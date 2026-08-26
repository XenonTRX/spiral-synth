// The first DSP in this project that is actually written rather than wired up.
//
// Everything before this was Web Audio nodes arranged into a graph: the nodes did the arithmetic
// and the instrument decided the shape. That has a ceiling, and both halves of this file are past
// it. A BiquadFilter is linear, so it cannot be driven into saturation and cannot self-oscillate;
// an OscillatorNode is band-limited for you, so you never have to think about aliasing and also
// cannot build a waveform of your own. Here there is nothing underneath but a Float32Array and
// 128 samples' worth of time to fill it.
//
// This runs on the audio thread, which has a deadline rather than a speed: 128 samples of work
// every 128 samples, forever, and missing once means silence. So the rules are different from the
// rest of the codebase. Nothing here allocates - no object literals, no array methods, no closures
// per sample - because allocation means garbage collection and garbage collection means a missed
// deadline. Voices are a fixed pool reused in place. It reads as more C than JavaScript, and that
// is not a style choice.

// Modulation is defined once, on the main thread, and imported here. A worklet module is an ES
// module and static imports resolve inside AudioWorkletGlobalScope - verified with a probe processor
// rather than assumed - so "what LFO 1 is" has one definition rather than two that have to be kept
// in step. What cannot be shared is the *mechanism*: over there an LFO is an OscillatorNode
// connected to an AudioParam and the summing is free, and down here it cannot be, because one node
// plays every voice and an AudioParam belongs to the node rather than to a voice. So the sources
// carry both a `create` for nodes and a `sample` for this, side by side. This half uses `sample`.
import { MOD_SOURCES } from '../../modulation.js';
import { amplitudeWithMod, cutoffHz, ladderStep, polyBlep, rateFor, stepAmp, stepEnv } from './voice-dsp.js';

const MAX_VOICES = 16;
const TWO_PI = Math.PI * 2;

// How often the processor reports what it cost. Roughly every 125ms at 44.1kHz - often enough to
// watch, rare enough that the reporting is not itself a measurable part of the measurement.
const REPORT_EVERY = 43;

const MAX_ROUTINGS = 8;

// Destinations as small integers, because the inner loop dispatches on them once per routing per
// voice per sub-block and comparing strings there would be the most expensive thing in the file.
const TARGET_CUTOFF = 0;
const TARGET_RESONANCE = 1;
const TARGET_GAIN = 2;
const TARGET_TUNE = 3;
const TARGET_DRIVE = 4;
const TARGET_CODES = {
  cutoff: TARGET_CUTOFF,
  resonance: TARGET_RESONANCE,
  gain: TARGET_GAIN,
  tune: TARGET_TUNE,
  drive: TARGET_DRIVE,
};

const SOURCE_BY_ID = Object.create(null);
for (const source of MOD_SOURCES) SOURCE_BY_ID[source.id] = source;

/**
 * How often modulation is re-evaluated, in samples.
 *
 * Not per sample, which would be the obvious thing and is pure waste: sixteen voices times eight
 * routings is 128 source evaluations per sample, most of them `Math.sin`, for quantities that at
 * their fastest complete a cycle in a thousand samples. Every eight samples is 5.5kHz of update
 * rate against a 40Hz ceiling on the LFOs - far finer than anything being modulated can respond to,
 * and a sixteenth of the work. Not per *quantum* either, which would have been cheaper still and is
 * where this would have gone wrong: 128 samples is 2.9ms, so a fast LFO would arrive as a staircase
 * of 344Hz steps and put a buzz into the cutoff that no amount of measurement afterwards would have
 * been able to blame on the right thing.
 */
const MOD_SUBBLOCK = 8;

class Voice {
  constructor() {
    this.active = false;
    this.id = -1;
    this.phase = 0;
    this.inc = 0;
    // Ladder state: four one-pole stages in series. The filter *is* these four numbers.
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.s4 = 0;
    // Envelopes, as a level and which segment it is in. Held as plain numbers rather than as
    // scheduled ramps, because there is no scheduler down here - this is the thing that would
    // have been doing the scheduling.
    this.ampLevel = 0;
    this.ampStage = 0; // 0 off, 1 attack, 2 decay, 3 sustain, 4 release
    this.envLevel = 0;
    this.envStage = 0;
    this.releaseFrom = 0;
    this.envReleaseFrom = 0;
    this.age = 0;
    // What modulation needs to know about this voice: how high the note is, and how far into it we
    // are. Held in seconds on the audio clock rather than in samples, because that is the unit the
    // shared source definitions are written in - the main thread has no samples.
    this.midi = 60;
    this.freq = 440;
    // A slide, as three numbers: where the pitch came from, where it is going, and how long it has
    // to get there. `freq` is where it has actually reached, so everything downstream of it - the
    // increment, the tune knob, a routing aimed at pitch - goes on reading one field and needs to
    // know nothing about any of this. `glideSeconds` of 0 is a note that starts where it belongs,
    // which is nearly all of them.
    this.glideFrom = 0;
    this.glideTo = 0;
    this.glideSeconds = 0;
    this.startTime = 0;
    this.releasedAt = Infinity;
    this.velocity = 1;
    // The modulation as of the current sub-block, held between evaluations.
    this.modCutoff = 0;
    this.modResonance = 0;
    this.modGain = 0;
    this.modTune = 0;
    this.modDrive = 0;
  }

  reset(id, freq, midi, startTime, sampleRate, velocity, glideFrom = 0, glideSeconds = 0) {
    this.active = true;
    this.id = id;
    this.phase = 0;
    const sliding = glideFrom > 0 && glideSeconds > 0;
    this.freq = sliding ? glideFrom : freq;
    this.glideFrom = sliding ? glideFrom : 0;
    this.glideTo = freq;
    this.glideSeconds = sliding ? glideSeconds : 0;
    this.inc = this.freq / sampleRate;
    this.s1 = this.s2 = this.s3 = this.s4 = 0;
    this.ampLevel = 0;
    this.ampStage = 1;
    this.envLevel = 0;
    this.envStage = 1;
    this.age = 0;
    this.midi = midi;
    this.startTime = startTime;
    this.releasedAt = Infinity;
    this.velocity = velocity;
    this.modCutoff = this.modResonance = this.modGain = this.modTune = this.modDrive = 0;
  }

  /**
   * Move a sliding voice on to where its pitch has got to by `now`.
   *
   * Geometric, because that is what a pitch travelling at a constant rate is: equal ratios in equal
   * times, which is a straight line in semitones and the same curve `exponentialRampToValueAtTime`
   * gives the node-graph instruments. A linear ramp through Hz would leave most of the journey
   * sounding like the destination.
   *
   * The last step lands on the target exactly and switches the slide off, so a note that has arrived
   * costs nothing further and cannot sit a rounding error away from its own pitch for the rest of
   * its life.
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
}

class LadderProcessor extends AudioWorkletProcessor {
  /**
   * `processorOptions` is not a convenience here, it is the only channel that works offline.
   *
   * Messages posted to a port are delivered between render quanta, which is fine on a live
   * context that runs in real time and is not fine on an OfflineAudioContext, which renders as
   * fast as it can and finishes before the main thread's message has been serviced. Measured:
   * a probe processor reported `gotMessageByFirstProcess: false` while the same information
   * passed through `processorOptions` arrived at construction. So anything that must be true
   * before the first sample comes in through the constructor, and the port carries only what
   * genuinely arrives later - which, during live playback, is everything.
   */
  constructor(options) {
    super();

    this.state = {
      waveform: 'saw',
      cutoff: 800,
      resonance: 0.6,
      drive: 2,
      filterEnvAmount: 2.4,
      filterAttack: 0.004,
      filterDecay: 0.35,
      filterSustain: 0.2,
      attack: 0.004,
      decay: 0.25,
      sustain: 0.7,
      release: 0.25,
      gain: 0.8,
      polyblep: 1,
      tune: 0,
      mod: [],
    };

    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) this.voices[i] = new Voice();

    // The routing matrix, flattened into fixed arrays. Rebuilt whenever the state changes, which
    // happens between quanta, so the inner loop only ever reads it - no iterating an array of
    // objects and looking up strings where the deadline is.
    this.routeSource = new Array(MAX_ROUTINGS).fill(null);
    this.routeTarget = new Int32Array(MAX_ROUTINGS);
    this.routeDepth = new Float32Array(MAX_ROUTINGS);
    this.routeCount = 0;

    // Events arrive from the main thread with a time on the audio clock, and are applied at the
    // sample they land on rather than at the start of whatever quantum happens to be running.
    // 128 samples is 2.9ms; a note quantised to the nearest quantum would be up to that late, and
    // two parts disagreeing by 2.9ms is exactly the flamming the whole scheduler exists to avoid.
    this.events = [];

    this.nextId = 1;
    this.quanta = 0;

    const initial = options?.processorOptions;
    if (initial?.state) {
      for (const key in initial.state) this.state[key] = initial.state[key];
    }
    if (initial?.events?.length) {
      // Only things that happen at a time belong in a queue drained by time. Anything else here
      // would never compare true and would block everything behind it - which is precisely how
      // this went wrong once already.
      for (const event of initial.events) {
        if (typeof event.time === 'number') this.events.push(event);
      }
      this.events.sort((a, b) => a.time - b.time);
    }
    this.rebuildRoutes();

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'params') {
        // Assigned field by field into the existing object rather than replaced, so the audio
        // thread never sees a half-built one and nothing is allocated in the process.
        const next = message.state;
        for (const key in next) this.state[key] = next[key];
        this.rebuildRoutes();
      } else if (message.type === 'noteOn' || message.type === 'noteOff') {
        this.events.push(message);
        this.events.sort((a, b) => a.time - b.time);
      } else if (message.type === 'panic') {
        for (let i = 0; i < MAX_VOICES; i++) this.voices[i].active = false;
        this.events.length = 0;
      }
    };
  }

  /**
   * Flatten the matrix into the arrays the inner loop reads.
   *
   * Called from the constructor and from a `params` message, both of which run between render
   * quanta, so this is allowed to look things up by string and skip over rubbish. It writes into
   * arrays that already exist rather than building new ones, because they are read on the audio
   * thread and a fresh array here would be garbage to collect there.
   */
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

  /** Re-evaluate every routing for one voice, once per sub-block. */
  evaluateModulation(voice, now) {
    let cutoff = 0;
    let resonance = 0;
    let gain = 0;
    let tune = 0;
    let drive = 0;
    const t = now - voice.startTime;
    for (let r = 0; r < this.routeCount; r++) {
      const amount = this.routeSource[r].sample(this.state, t, voice.releasedAt, voice.midi) * this.routeDepth[r];
      const target = this.routeTarget[r];
      if (target === TARGET_CUTOFF) cutoff += amount;
      else if (target === TARGET_RESONANCE) resonance += amount;
      else if (target === TARGET_GAIN) gain += amount;
      else if (target === TARGET_TUNE) tune += amount;
      else drive += amount;
    }
    voice.modCutoff = cutoff;
    voice.modResonance = resonance;
    voice.modGain = gain;
    voice.modDrive = drive;
    if (tune !== voice.modTune) {
      voice.modTune = tune;
      this.retune(voice);
    }
  }

  /**
   * The increment this voice's pitch comes out to, whatever moved it.
   *
   * Three things can: the note itself, the tune knob plus anything routed at it, and a slide still
   * arriving. They all end up here so that no two of them can be applied in a different order or,
   * worse, one of them forget the others - which is what a second copy of this line inside the
   * glide would have done to a note with a vibrato on it.
   */
  retune(voice) {
    voice.inc = (voice.freq * Math.pow(2, ((this.state.tune ?? 0) + voice.modTune) / 12)) / sampleRate;
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
    // Nothing free means stealing the one that has been going longest, which is the least bad
    // answer: the alternative is dropping the note you just asked for.
    const voice = this.voices[free === -1 ? oldest : free];
    voice.reset(id, freq, midi, startTime, sampleRate, velocity, glideFrom, glideSeconds);
    // The static tune knob, before any modulation has been evaluated.
    this.retune(voice);
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

    const state = this.state;
    const sr = sampleRate;
    const frames = out.length;
    const blockStart = currentTime;

    // Envelope rates, in level per sample. Recomputed once per quantum rather than per sample:
    // the parameters cannot change inside a quantum anyway, since messages are delivered between
    // them, so doing this in the inner loop would be 128 times the work for the same answer.
    const ampAtk = rateFor(state.attack, sr);
    const ampDec = rateFor(state.decay, sr);
    const ampRel = rateFor(state.release, sr);
    const envAtk = rateFor(state.filterAttack, sr);
    const envDec = rateFor(state.filterDecay, sr);
    const envRel = rateFor(state.release, sr);

    // Resonance runs past the point where the feedback sustains itself. That is the whole reason
    // for writing a filter rather than using the one in the box: a BiquadFilter's Q makes a peak
    // and stops, while a ladder at k around 4 becomes an oscillator and sings on its own.
    const k = state.resonance * 4.4;
    const drive = state.drive;
    const square = state.waveform === 'square';
    const useBlep = state.polyblep !== 0;
    const gain = state.gain * 0.28;

    for (let i = 0; i < frames; i++) {
      // Anything due at or before this sample, applied here rather than at the block edge.
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

      // Modulation on its own, coarser clock. `i % MOD_SUBBLOCK` rather than a second loop so that a
      // voice starting mid-block still gets evaluated before it is first heard: a voice allocated at
      // sample 3 is evaluated at sample 8, four samples of its attack later, which is 90µs.
      const evaluateMod = this.routeCount > 0 && i % MOD_SUBBLOCK === 0;

      let mix = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        const voice = this.voices[v];
        if (!voice.active) continue;
        voice.age++;
        if (evaluateMod) this.evaluateModulation(voice, now);
        // A voice still arriving at its pitch, moved on the same coarse clock the modulation uses -
        // 8 samples is 170µs, which is finer than a glide can be heard to be stepping.
        if (voice.glideSeconds > 0 && i % MOD_SUBBLOCK === 0) {
          voice.glideStep(now);
          this.retune(voice);
        }

        if (!stepAmp(voice, ampAtk, ampDec, ampRel, state.sustain)) {
          voice.active = false;
          continue;
        }
        stepEnv(voice, envAtk, envDec, envRel, state.filterSustain);

        // --- oscillator
        voice.phase += voice.inc;
        if (voice.phase >= 1) voice.phase -= 1;
        let osc;
        if (square) {
          osc = voice.phase < 0.5 ? 1 : -1;
          if (useBlep) {
            osc += polyBlep(voice.phase, voice.inc);
            let half = voice.phase + 0.5;
            if (half >= 1) half -= 1;
            osc -= polyBlep(half, voice.inc);
          }
        } else {
          osc = 2 * voice.phase - 1;
          if (useBlep) osc -= polyBlep(voice.phase, voice.inc);
        }

        // --- ladder, four one-poles inside a saturating feedback loop
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

    // How many voices are really sounding - which is all this thread can honestly report.
    //
    // The plan was for it to time its own process() against the 2.9ms it is allowed, since that
    // is the one measurement nothing outside this thread can make. It cannot: there is no clock
    // here. `performance` is undefined in AudioWorkletGlobalScope, and `currentTime` and
    // `currentFrame` both count rendered audio rather than elapsed wall time, so they measure how
    // much sound has been made and not how long it took to make it. With renderCapacity also
    // absent from the browser, live CPU load is not measurable by any route at all. What is left
    // is an exact voice count, which beats the node graph's guess at one, and an offline render
    // timed from the main thread (see analysis.js) for the question of whether a patch is
    // affordable at all.
    if (++this.quanta >= REPORT_EVERY) {
      let sounding = 0;
      for (let v = 0; v < MAX_VOICES; v++) if (this.voices[v].active) sounding++;
      this.port.postMessage({ type: 'load', voices: sounding });
      this.quanta = 0;
    }

    return true;
  }
}

registerProcessor('ladder', LadderProcessor);
