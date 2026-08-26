// The second worklet, and the first one that reads its waveform rather than computing it.
//
// Everything structural here is the same as ladder-processor.js: a fixed pool of voices, an event
// queue drained against the audio clock, modulation evaluated on a sub-block, and no allocation
// anywhere. The arithmetic they share - the filter, the envelopes - is imported rather than
// repeated. What is genuinely new is the oscillator, and it is new in two ways.
//
// It reads from a table, so its harmonic content is whatever was baked in rather than whatever a
// formula produces, and the table is a pyramid: a note picks the most detailed level whose top
// harmonic still fits under Nyquist. That is the whole anti-aliasing strategy, and it is chosen per
// voice per sub-block rather than per note, because pitch modulation moves a note between levels
// while it sounds.
//
// And it has a *position*: the table holds sixteen waveforms and the oscillator sits between two of
// them. That is a continuous parameter, which means it is a modulation destination, which means an
// envelope or an LFO can sweep the harmonic content directly instead of filtering something that
// already exists. A subtractive synth cannot do that at all.

import { MOD_SOURCES } from '../../modulation.js';
import { FRAMES, levelForFrequency, sampleTable } from '../../wavetable.js';
import {
  MAX_UNISON, amplitudeWithMod, cutoffHz, ladderStep, rateFor, stepAmp, stepEnv, unisonOffsets, unisonScale,
} from './voice-dsp.js';

const MAX_VOICES = 16;
const TWO_PI = Math.PI * 2;
const REPORT_EVERY = 43;
const MAX_ROUTINGS = 8;
const MOD_SUBBLOCK = 8;

const TARGET_CUTOFF = 0;
const TARGET_RESONANCE = 1;
const TARGET_GAIN = 2;
const TARGET_TUNE = 3;
const TARGET_DRIVE = 4;
const TARGET_POSITION = 5;
const TARGET_CODES = {
  cutoff: TARGET_CUTOFF,
  resonance: TARGET_RESONANCE,
  gain: TARGET_GAIN,
  tune: TARGET_TUNE,
  drive: TARGET_DRIVE,
  position: TARGET_POSITION,
};

const SOURCE_BY_ID = Object.create(null);
for (const source of MOD_SOURCES) SOURCE_BY_ID[source.id] = source;

// Precomputed once per count, because the alternative is building a Float64Array inside a note-on.
const UNISON_OFFSETS = [];
for (let count = 1; count <= MAX_UNISON; count++) UNISON_OFFSETS.push(unisonOffsets(count));

/**
 * Starting phases for the unison copies.
 *
 * Not all zero, which is what they would be if nobody thought about it, and which sounds wrong in a
 * specific way: identical phases mean the copies sum to one loud in-phase transient at every note
 * start and only spread out as the detuning pulls them apart, so the attack of a big unison patch
 * is a click that decays into the sound you wanted. Irrational spacing avoids ever lining back up.
 */
const PHASE_SEEDS = new Float64Array(MAX_UNISON);
for (let i = 0; i < MAX_UNISON; i++) PHASE_SEEDS[i] = (i * 0.6180339887498949) % 1;

class Voice {
  constructor() {
    this.active = false;
    this.id = -1;
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.s4 = 0;
    this.ampLevel = 0;
    this.ampStage = 0;
    this.envLevel = 0;
    this.envStage = 0;
    this.releaseFrom = 0;
    this.envReleaseFrom = 0;
    this.age = 0;
    this.midi = 60;
    this.freq = 440;
    // A slide in progress: where the pitch came from, where it is going, how long it has. `freq` is
    // where it has reached, and `retune` below already reads that for every unison copy - so a
    // sliding note is one field moving and nothing else in here has to know.
    this.glideFrom = 0;
    this.glideTo = 0;
    this.glideSeconds = 0;
    this.startTime = 0;
    this.releasedAt = Infinity;
    this.modCutoff = 0;
    this.modResonance = 0;
    this.modGain = 0;
    this.modTune = 0;
    this.modDrive = 0;
    this.velocity = 1;
    // One phase and one increment per unison copy. Allocated once, at their maximum, and only the
    // first `unison` of them are ever read - a voice must not allocate when a knob moves.
    this.phases = new Float64Array(MAX_UNISON);
    this.incs = new Float64Array(MAX_UNISON);
    this.unison = 1;
    this.unisonScale = 1;
    this.level = 0;
  }

  reset(id, freq, midi, startTime, velocity, glideFrom = 0, glideSeconds = 0) {
    this.active = true;
    this.id = id;
    const sliding = glideFrom > 0 && glideSeconds > 0;
    this.freq = sliding ? glideFrom : freq;
    this.glideFrom = sliding ? glideFrom : 0;
    this.glideTo = freq;
    this.glideSeconds = sliding ? glideSeconds : 0;
    this.s1 = this.s2 = this.s3 = this.s4 = 0;
    this.ampLevel = 0;
    this.ampStage = 1;
    this.envLevel = 0;
    this.envStage = 1;
    this.age = 0;
    this.midi = midi;
    this.startTime = startTime;
    this.releasedAt = Infinity;
    this.modCutoff = this.modResonance = this.modGain = this.modTune = this.modDrive = 0;
    this.modPosition = 0;
    this.velocity = velocity;
    for (let i = 0; i < MAX_UNISON; i++) this.phases[i] = PHASE_SEEDS[i];
  }

  /**
   * Move a sliding voice on to the pitch it has reached by `now`.
   *
   * Geometric, because a pitch travelling at a constant rate covers equal *ratios* in equal times -
   * the same curve the node-graph instruments get from `exponentialRampToValueAtTime`, so a slide
   * sounds like one gesture whichever instrument is playing it. The last step lands exactly on the
   * target and switches itself off.
   *
   * It only moves `freq`; `retune` is what turns that into increments, and the caller does it - see
   * `retuneVoice`, which is also where the tune knob and any routing aimed at pitch come in.
   */
  glideStep(now) {
    const u = (now - this.startTime) / this.glideSeconds;
    if (u >= 1) {
      this.freq = this.glideTo;
      this.glideSeconds = 0;
      return;
    }
    this.freq = this.glideFrom * Math.pow(this.glideTo / this.glideFrom, u);
  }

  /**
   * Retune every unison copy, and pick the mip level to read them from.
   *
   * Called whenever anything that moves pitch moves - the tune knob, a routing aimed at it, a new
   * note - because the level depends on the frequency and a note that drifts up an octave needs a
   * level with half as many harmonics or it will start aliasing halfway through.
   *
   * The level is chosen from the *highest* copy rather than from the centre, since detuning spreads
   * the copies either side and it is the sharpest one that would alias first.
   */
  retune(semitones, detuneCents, unison, sampleRate) {
    this.unison = unison;
    this.unisonScale = unisonScale(unison);
    const offsets = UNISON_OFFSETS[unison - 1];
    let highest = 0;
    for (let i = 0; i < unison; i++) {
      const cents = semitones * 100 + offsets[i] * detuneCents;
      const f = this.freq * Math.pow(2, cents / 1200);
      this.incs[i] = f / sampleRate;
      if (f > highest) highest = f;
    }
    this.level = levelForFrequency(highest, sampleRate);
  }
}

class WavetableProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.state = {
      table: 'basic',
      position: 0.35,
      unison: 1,
      detune: 12,
      cutoff: 3000,
      resonance: 0.3,
      drive: 1.2,
      filterEnvAmount: 1.2,
      filterAttack: 0.004,
      filterDecay: 0.4,
      filterSustain: 0.3,
      attack: 0.004,
      decay: 0.3,
      sustain: 0.8,
      release: 0.3,
      gain: 0.8,
      tune: 0,
      mod: [],
    };

    // The table's samples, as a plain array of levels. It arrives built rather than being generated
    // here, and that is not a convenience: building it means several hundred inverse transforms,
    // which on this thread is a missed deadline and a gap in the audio. The main thread has the
    // memoised copy anyway - the same one the scope and the display read - so what crosses is data
    // that already existed.
    this.levels = null;

    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) this.voices[i] = new Voice();

    this.routeSource = new Array(MAX_ROUTINGS).fill(null);
    this.routeTarget = new Int32Array(MAX_ROUTINGS);
    this.routeDepth = new Float32Array(MAX_ROUTINGS);
    this.routeCount = 0;

    this.events = [];
    this.quanta = 0;

    const initial = options?.processorOptions;
    if (initial?.state) {
      for (const key in initial.state) this.state[key] = initial.state[key];
    }
    if (initial?.levels) this.levels = initial.levels;
    if (initial?.events?.length) {
      for (const event of initial.events) {
        if (typeof event.time === 'number') this.events.push(event);
      }
      this.events.sort((a, b) => a.time - b.time);
    }
    this.rebuildRoutes();

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'params') {
        const next = message.state;
        for (const key in next) this.state[key] = next[key];
        if (message.levels) this.levels = message.levels;
        this.rebuildRoutes();
        // Unison and detune change how many copies a sounding voice has and where they sit, so
        // notes already down have to be retuned or the knob would only affect the next note.
        for (let i = 0; i < MAX_VOICES; i++) {
          const voice = this.voices[i];
          if (voice.active) voice.retune(this.state.tune + voice.modTune, this.state.detune, this.unisonCount(), sampleRate);
        }
      } else if (message.type === 'noteOn' || message.type === 'noteOff') {
        this.events.push(message);
        this.events.sort((a, b) => a.time - b.time);
      } else if (message.type === 'panic') {
        for (let i = 0; i < MAX_VOICES; i++) this.voices[i].active = false;
        this.events.length = 0;
      }
    };
  }

  unisonCount() {
    const n = Math.round(this.state.unison);
    return n < 1 ? 1 : n > MAX_UNISON ? MAX_UNISON : n;
  }

  rebuildRoutes() {
    this.routeCount = 0;
    const matrix = this.state.mod;
    if (!Array.isArray(matrix)) return;
    for (let i = 0; i < matrix.length && this.routeCount < MAX_ROUTINGS; i++) {
      const routing = matrix[i];
      if (!routing) continue;
      const code = TARGET_CODES[routing.target];
      const source = SOURCE_BY_ID[routing.source];
      const depth = +routing.depth;
      if (code === undefined || !source || !depth) continue;
      this.routeSource[this.routeCount] = source;
      this.routeTarget[this.routeCount] = code;
      this.routeDepth[this.routeCount] = depth;
      this.routeCount++;
    }
  }

  evaluateModulation(voice, now) {
    let cutoff = 0;
    let resonance = 0;
    let gain = 0;
    let tune = 0;
    let drive = 0;
    let position = 0;
    const t = now - voice.startTime;
    for (let r = 0; r < this.routeCount; r++) {
      const amount = this.routeSource[r].sample(this.state, t, voice.releasedAt, voice.midi) * this.routeDepth[r];
      const target = this.routeTarget[r];
      if (target === TARGET_CUTOFF) cutoff += amount;
      else if (target === TARGET_RESONANCE) resonance += amount;
      else if (target === TARGET_GAIN) gain += amount;
      else if (target === TARGET_TUNE) tune += amount;
      else if (target === TARGET_DRIVE) drive += amount;
      else position += amount;
    }
    voice.modCutoff = cutoff;
    voice.modResonance = resonance;
    voice.modGain = gain;
    voice.modDrive = drive;
    voice.modPosition = position;
    if (tune !== voice.modTune) {
      voice.modTune = tune;
      this.retuneVoice(voice);
    }
  }

  /**
   * This voice's pitch as it now stands, from all three things that move it: the note, the tune knob
   * with whatever is routed at it, and a slide still arriving. One place, so that none of them can
   * be applied without the others.
   */
  retuneVoice(voice) {
    voice.retune((this.state.tune ?? 0) + voice.modTune, this.state.detune, this.unisonCount(), sampleRate);
  }

  allocate(id, freq, midi, startTime, velocity, glideFrom = 0, glideSeconds = 0) {
    let free = -1;
    let oldest = 0;
    for (let i = 0; i < MAX_VOICES; i++) {
      const voice = this.voices[i];
      if (!voice.active) {
        free = i;
        break;
      }
      if (voice.age > this.voices[oldest].age) oldest = i;
    }
    const voice = this.voices[free === -1 ? oldest : free];
    voice.reset(id, freq, midi, startTime, velocity, glideFrom, glideSeconds);
    this.retuneVoice(voice);
    return voice;
  }

  releaseVoice(id, at) {
    for (let i = 0; i < MAX_VOICES; i++) {
      const voice = this.voices[i];
      if (voice.active && voice.id === id && voice.ampStage !== 4) {
        voice.ampStage = 4;
        voice.envStage = 4;
        voice.releaseFrom = voice.ampLevel;
        voice.envReleaseFrom = voice.envLevel;
        voice.releasedAt = at - voice.startTime;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    // No table means the message carrying it has not arrived. Silence rather than a crash, and it
    // resolves itself within a quantum or two.
    if (!this.levels) return true;

    const state = this.state;
    const sr = sampleRate;
    const frames = out.length;
    const blockStart = currentTime;

    const ampAtk = rateFor(state.attack, sr);
    const ampDec = rateFor(state.decay, sr);
    const ampRel = rateFor(state.release, sr);
    const envAtk = rateFor(state.filterAttack, sr);
    const envDec = rateFor(state.filterDecay, sr);
    const envRel = rateFor(state.release, sr);

    const k = state.resonance * 4.4;
    const drive = state.drive;
    const gain = state.gain * 0.32;

    for (let i = 0; i < frames; i++) {
      const now = blockStart + i / sr;
      while (this.events.length && this.events[0].time <= now) {
        const event = this.events.shift();
        if (event.type === 'noteOn') {
          this.allocate(
            event.id,
            event.freq,
            event.midi ?? 60,
            now,
            event.velocity ?? 1,
            event.glideFrom ?? 0,
            event.glideSeconds ?? 0,
          );
        } else this.releaseVoice(event.id, now);
      }

      const evaluateMod = this.routeCount > 0 && i % MOD_SUBBLOCK === 0;

      let mix = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        const voice = this.voices[v];
        if (!voice.active) continue;
        voice.age++;
        if (evaluateMod) this.evaluateModulation(voice, now);
        // A voice still arriving at its pitch, on the same coarse clock the modulation uses. It
        // retunes every unison copy, which is more work than the ladder's one increment and still
        // an eighth of what doing it per sample would be.
        if (voice.glideSeconds > 0 && i % MOD_SUBBLOCK === 0) {
          voice.glideStep(now);
          this.retuneVoice(voice);
        }

        if (!stepAmp(voice, ampAtk, ampDec, ampRel, state.sustain)) {
          voice.active = false;
          continue;
        }
        stepEnv(voice, envAtk, envDec, envRel, state.filterSustain);

        // --- oscillator: every unison copy reads the same table at its own phase
        //
        // Clamped rather than wrapped, because a routing that pushes the position past either end
        // should sit against the end - wrapping would jump from the brightest frame to the darkest
        // in one sample, which is a click and never what anyone meant by "more".
        let position = state.position + voice.modPosition;
        if (position < 0) position = 0;
        else if (position > 1) position = 1;

        const level = this.levels[voice.level];
        const unison = voice.unison;
        let osc = 0;
        for (let u = 0; u < unison; u++) {
          osc += sampleTable(level, position, voice.phases[u]);
          let phase = voice.phases[u] + voice.incs[u];
          if (phase >= 1) phase -= 1;
          voice.phases[u] = phase;
        }
        osc *= voice.unisonScale;

        // --- ladder, the same four one-poles the other worklet uses
        const fc = cutoffHz(state.cutoff, state.filterEnvAmount * voice.envLevel + voice.modCutoff);
        const g = 1 - Math.exp((-TWO_PI * fc) / sr);

        let voiceK = k + voice.modResonance * 4.4;
        if (voiceK < 0) voiceK = 0;
        let voiceDrive = drive + voice.modDrive;
        if (voiceDrive < 0.01) voiceDrive = 0.01;

        mix += ladderStep(voice, osc, g, voiceK, voiceDrive) * amplitudeWithMod(voice);
      }

      out[i] = mix * gain;
    }

    if (++this.quanta >= REPORT_EVERY) {
      let sounding = 0;
      let oscillators = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        if (this.voices[v].active) {
          sounding++;
          oscillators += this.voices[v].unison;
        }
      }
      // Both numbers, because they answer different questions: voices is how many notes are down,
      // oscillators is what it costs. A unison of seven makes those differ by a factor of seven.
      this.port.postMessage({ type: 'load', voices: sounding, oscillators });
      this.quanta = 0;
    }

    return true;
  }
}

registerProcessor('wavetable', WavetableProcessor);
