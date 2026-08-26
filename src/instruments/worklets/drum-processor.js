// A drum kit, synthesised rather than sampled.
//
// The obvious way to get drums is to ship recordings of drums, and it is the wrong way for this
// project twice over. There is no build step and no asset pipeline, so a kit would have to arrive
// as megabytes of base64 inside a source file. And a sample has no knobs: the whole point of a
// drum machine, as opposed to a drum, is that the kick has a tune control and a decay control and
// you can make it the length of the bar. Every drum below is a few oscillators and an envelope, in
// the tradition of the machines that defined how programmed drums sound, and every one of them is
// parametric all the way down.
//
// This is the third worklet and it breaks the shape the other two share, on purpose. They are one
// voice architecture with parameters; a kit is eleven small synths that happen to live in one
// processor, and pretending otherwise would mean a filter and an envelope on a hi-hat that wants
// neither. What they do share - the deadline, the no-allocation rule, the fixed voice pool, the
// event queue drained against the audio clock - is unchanged, and the arithmetic that is genuinely
// common comes from voice-dsp.js.
//
// **Every voice is deterministic.** Noise comes from a per-voice counter-seeded xorshift rather
// than Math.random, which matters more than it sounds: an exported WAV should be the same file
// twice, and a measurement should be the same measurement twice, or the harness is measuring the
// weather. Seeding from the note id means the same song renders identically every time while two
// hats in a row still get different noise.

import { CLAP, CRASH, HAT_CLOSED, HAT_OPEN, KICK, RIDE, RIM, SNARE, TOM_HI, TOM_LO, TOM_MID, kindForMidi } from '../drum-map.js';
import { squareAt } from './voice-dsp.js';

const MAX_VOICES = 24;
const TWO_PI = Math.PI * 2;
const REPORT_EVERY = 43;

/**
 * The six oscillator frequencies of the machine everyone means when they say "808 hi-hat".
 *
 * Deliberately inharmonic - no two of them are a whole-number ratio - which is the entire trick.
 * Squares at harmonic intervals sum to a brighter square and sound like a buzzer; squares at these
 * intervals sum to something with no discernible pitch, and once it has been through a steep
 * highpass what is left reads as metal. They are ratios here rather than absolute frequencies so
 * the tone knob can move all six together.
 */
const METAL_RATIOS = [1, 1.4826, 1.8, 2.5457, 2.6303, 3.8964];
const METAL_BASE_HZ = 205.3;

// How long the kick's click and the rim's tick last. Short enough to be a transient rather than a
// sound of its own - past about 5ms a click stops being an attack and starts being a pop.
const CLICK_S = 0.0025;

// A clap is not one noise burst, it is several hands not quite together. Three fast repeats and
// then the room: it is the repeats that make it read as a clap rather than as a snare with no tone.
const CLAP_BURSTS = 3;
const CLAP_GAP_S = 0.0095;

/** An open hat is cut off by a closed one, over this long - fast enough to read as a choke,
 *  slow enough not to be a click of its own. Real hats are one pair of cymbals and cannot ring
 *  through their own foot; a kit that let them is the most obvious tell that drums are fake. */
const CHOKE_S = 0.004;

/**
 * Output trim per voice, measured rather than guessed.
 *
 * These exist because the drums are built from very different amounts of signal. A kick is a sine
 * at full scale; a hi-hat is six squares summed, divided by six, and then put through a highpass at
 * 8kHz which throws away all but their top harmonics. Left untrimmed the closed hat measured 38dB
 * below the kick - not quiet, *inaudible* under it - and the four metallic voices spanned 17dB
 * between themselves purely because their highpass corners differ.
 *
 * So each voice is trimmed to land where it belongs in a kit: kick loudest, snare and toms a few dB
 * under, hats well under, cymbals between. The numbers come from rendering each drum on its own and
 * comparing mean power, and they are the reason the level knobs can all sit at their defaults and
 * still sound like a kit rather than a list of drums.
 */
const TRIM = [];
TRIM[KICK] = 1;
TRIM[RIM] = 1.1;
TRIM[SNARE] = 2.2;
TRIM[CLAP] = 1.4;
TRIM[TOM_LO] = 0.85;
TRIM[HAT_CLOSED] = 14;
TRIM[TOM_MID] = 0.85;
TRIM[HAT_OPEN] = 7;
TRIM[TOM_HI] = 0.85;
TRIM[CRASH] = 4.5;
TRIM[RIDE] = 3.2;

class Voice {
  constructor() {
    this.active = false;
    this.kind = -1;
    this.id = -1;
    this.age = 0;
    this.t = 0;
    this.velocity = 1;
    this.level = 0;

    // Two envelopes, as a level and a per-sample multiplier. Exponential because that is what a
    // struck object does - energy leaves at a rate proportional to how much is left - and because
    // it costs one multiply.
    this.amp = 0;
    this.ampCoef = 0;
    this.aux = 0;
    this.auxCoef = 0;

    // A short attack ramp. A percussive envelope starting at full level is a step, and a step is
    // broadband - it puts a click on the front of every drum. Two milliseconds removes it without
    // softening anything anybody can hear.
    this.attack = 0;
    this.attackStep = 0;

    this.phase = 0;
    this.inc = 0;
    this.phase2 = 0;
    this.inc2 = 0;
    this.baseFreq = 0;
    this.sweep = 0;

    this.metalPhase = new Float64Array(METAL_RATIOS.length);
    this.metalInc = new Float64Array(METAL_RATIOS.length);

    // Chamberlin state-variable filter, for the band-passed noise in snares and claps.
    this.svfLow = 0;
    this.svfBand = 0;
    this.svfF = 0;
    this.svfQ = 0;

    // Two one-pole highpasses in series, for the cymbals. One-pole rather than the SVF because a
    // hat's corner sits near 8kHz, and a Chamberlin filter that high is not stable - it was the
    // obvious reuse and it would have blown up rather than sounded wrong.
    this.hp1 = 0;
    this.hp1x = 0;
    this.hp2 = 0;
    this.hp2x = 0;
    this.hpCoef = 0;

    this.noiseMix = 0;
    this.toneMix = 0;
    this.clapBurst = 0;
    this.clapNext = 0;
    this.rng = 1;
  }

  /** xorshift32. Fast, deterministic, and good enough for a noise source by a wide margin. */
  noise() {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return (this.rng / 2147483648) - 1;
  }
}

/**
 * The per-sample multiplier for a decay of `seconds`.
 *
 * `seconds` is the time to fall 60dB, not the exponential's time constant, and the difference is
 * not academic - it is the difference between a knob that means something and one that lies. Using
 * the time constant, a kick set to 420ms was still audible at two seconds, because an exponential
 * takes about seven time constants to reach anything like silence. A drum knob has to mean "this is
 * how long the drum lasts", so 60dB it is: set it to 420ms and the kick is gone in 420ms.
 */
const DECAY_DB = Math.log(1000);
const decayCoef = (seconds, sr) => Math.exp(-DECAY_DB / Math.max(1, seconds * sr));

class DrumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.state = {
      kickTune: 52,
      kickDecay: 0.42,
      kickBend: 3.2,
      kickClick: 0.35,
      kickLevel: 1,
      snareTune: 190,
      snareDecay: 0.19,
      snareSnap: 0.6,
      snareLevel: 0.85,
      clapDecay: 0.24,
      clapLevel: 0.8,
      hatTone: 1,
      hatClosedDecay: 0.055,
      hatOpenDecay: 0.42,
      hatLevel: 0.7,
      tomTune: 1,
      tomDecay: 0.5,
      tomLevel: 0.8,
      cymbalDecay: 1.8,
      cymbalLevel: 0.55,
      rimLevel: 0.7,
      gain: 0.9,
    };

    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) this.voices[i] = new Voice();

    this.events = [];
    this.quanta = 0;

    const initial = options?.processorOptions;
    if (initial?.state) for (const key in initial.state) this.state[key] = initial.state[key];
    if (initial?.events?.length) {
      for (const event of initial.events) if (typeof event.time === 'number') this.events.push(event);
      this.events.sort((a, b) => a.time - b.time);
    }

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'params') {
        const next = message.state;
        for (const key in next) this.state[key] = next[key];
      } else if (message.type === 'noteOn') {
        this.events.push(message);
        this.events.sort((a, b) => a.time - b.time);
      } else if (message.type === 'panic') {
        for (let i = 0; i < MAX_VOICES; i++) this.voices[i].active = false;
        this.events.length = 0;
      }
      // noteOff is deliberately ignored. Every drum here is a one-shot: it rings for as long as
      // its own decay says and no longer, and how long the note was drawn on the roll has nothing
      // to do with it. The one thing that *does* cut a drum short is another drum - see the choke.
    };
  }

  allocate(midi, when, velocity, id) {
    const kind = kindForMidi(midi);
    if (kind < 0) return null;

    // A closed hat shuts an open one, whichever order they were played in.
    if (kind === HAT_CLOSED || kind === HAT_OPEN) {
      for (let i = 0; i < MAX_VOICES; i++) {
        const other = this.voices[i];
        if (other.active && other.kind === HAT_OPEN) other.ampCoef = decayCoef(CHOKE_S, sampleRate);
      }
    }

    let free = -1;
    let oldest = 0;
    for (let i = 0; i < MAX_VOICES; i++) {
      const voice = this.voices[i];
      if (!voice.active) { free = i; break; }
      if (voice.age > this.voices[oldest].age) oldest = i;
    }
    const voice = this.voices[free === -1 ? oldest : free];
    this.startVoice(voice, kind, velocity, id);
    return voice;
  }

  /**
   * Set a voice up for one hit.
   *
   * Everything that depends on a knob is computed here rather than per sample: a drum is over in a
   * few hundred milliseconds, so a parameter that changed mid-hit would be inaudible anyway, and
   * this is the difference between two `Math.exp` per note and two per sample per voice.
   */
  startVoice(voice, kind, velocity, id) {
    const s = this.state;
    const sr = sampleRate;
    const v = velocity <= 0 ? 0.01 : velocity > 1 ? 1 : velocity;

    voice.active = true;
    voice.kind = kind;
    voice.id = id;
    voice.age = 0;
    voice.t = 0;
    voice.velocity = v;
    voice.amp = 0;
    voice.aux = 0;
    voice.phase = 0;
    voice.phase2 = 0;
    voice.svfLow = 0;
    voice.svfBand = 0;
    voice.hp1 = voice.hp1x = voice.hp2 = voice.hp2x = 0;
    voice.clapBurst = 0;
    voice.clapNext = 0;
    // Seeded from the note id so a render repeats exactly while consecutive hits still differ.
    voice.rng = (id * 2654435761 + kind * 40503 + 1) >>> 0;
    if (voice.rng === 0) voice.rng = 1;

    // A louder hit is a brighter hit on a real drum, so velocity opens the envelopes slightly as
    // well as raising the level. Without it a quiet hat is the same sound turned down, which is
    // the thing that makes programmed drums sound programmed.
    const bright = 0.55 + 0.45 * v;

    voice.attack = 0;
    voice.attackStep = 1 / Math.max(1, 0.002 * sr);

    if (kind === KICK) {
      voice.baseFreq = s.kickTune;
      voice.sweep = s.kickBend;
      voice.inc = 0;
      voice.ampCoef = decayCoef(s.kickDecay, sr);
      voice.aux = 1;
      voice.auxCoef = decayCoef(0.035, sr);
      voice.level = s.kickLevel * v;
      voice.noiseMix = s.kickClick;
    } else if (kind === SNARE) {
      voice.inc = s.snareTune / sr;
      voice.inc2 = (s.snareTune * 1.58) / sr;
      voice.ampCoef = decayCoef(s.snareDecay * bright, sr);
      voice.aux = 1;
      voice.auxCoef = decayCoef(s.snareDecay * 0.45, sr);
      voice.svfF = 2 * Math.sin((Math.PI * Math.min(0.45 * sr, 1750 * bright)) / sr);
      voice.svfQ = 0.85;
      voice.level = s.snareLevel * v;
      voice.noiseMix = s.snareSnap;
      voice.toneMix = 1 - s.snareSnap;
    } else if (kind === CLAP) {
      voice.ampCoef = decayCoef(s.clapDecay, sr);
      voice.auxCoef = decayCoef(0.0042, sr);
      voice.svfF = 2 * Math.sin((Math.PI * 1080) / sr);
      voice.svfQ = 0.6;
      voice.level = s.clapLevel * v;
      voice.clapNext = CLAP_GAP_S;
    } else if (kind === RIM) {
      voice.inc = 1690 / sr;
      voice.inc2 = 524 / sr;
      voice.ampCoef = decayCoef(0.026, sr);
      voice.level = s.rimLevel * v;
      voice.noiseMix = 0.35;
    } else if (kind === TOM_LO || kind === TOM_MID || kind === TOM_HI) {
      const pitch = kind === TOM_LO ? 92 : kind === TOM_MID ? 140 : 205;
      voice.baseFreq = pitch * s.tomTune;
      voice.sweep = 0.55;
      voice.ampCoef = decayCoef(s.tomDecay * (kind === TOM_HI ? 0.72 : kind === TOM_MID ? 0.86 : 1), sr);
      voice.aux = 1;
      voice.auxCoef = decayCoef(0.07, sr);
      voice.level = s.tomLevel * v;
      voice.noiseMix = 0.12;
    } else {
      // The metallic family: two hats and two cymbals off one oscillator bank, told apart by how
      // long they ring and how much of the bottom is taken away.
      const decay = kind === HAT_CLOSED ? s.hatClosedDecay * bright
        : kind === HAT_OPEN ? s.hatOpenDecay
        : kind === RIDE ? s.cymbalDecay * 0.75
        : s.cymbalDecay;
      const corner = kind === HAT_CLOSED ? 8200 : kind === HAT_OPEN ? 7400 : kind === RIDE ? 5200 : 4200;
      voice.ampCoef = decayCoef(decay, sr);
      voice.hpCoef = 1 / (1 + (TWO_PI * corner) / sr);
      voice.level = (kind === HAT_CLOSED || kind === HAT_OPEN ? s.hatLevel : s.cymbalLevel) * v;
      const base = METAL_BASE_HZ * s.hatTone * (kind === RIDE || kind === CRASH ? 0.78 : 1);
      for (let i = 0; i < METAL_RATIOS.length; i++) {
        voice.metalInc[i] = (base * METAL_RATIOS[i]) / sr;
        // Spread the starting phases so the bank does not begin every hit with all six aligned,
        // which is a transient of its own and makes every cymbal start identically.
        voice.metalPhase[i] = (i * 0.37 + (voice.rng % 1024) / 1024) % 1;
      }
      // A ride has a pitch in a way a hat does not - the stick on the bell.
      voice.inc = kind === RIDE ? 2350 / sr : 0;
    }
  }

  /** One sample of one voice. */
  render(voice, sr) {
    const kind = voice.kind;
    let out = 0;

    if (kind === KICK) {
      // The pitch envelope is the kick. A sine that simply stops is a beep; one that falls an
      // octave and a half in thirty milliseconds is a beater hitting a head, and the sweep knob is
      // the difference between a tight click and a long boom.
      const freq = voice.baseFreq * (1 + voice.sweep * voice.aux);
      voice.phase += freq / sr;
      if (voice.phase >= 1) voice.phase -= 1;
      out = Math.sin(TWO_PI * voice.phase) * voice.amp;
      if (voice.t < CLICK_S * sr) out += voice.noise() * voice.noiseMix * (1 - voice.t / (CLICK_S * sr));
    } else if (kind === SNARE) {
      voice.phase += voice.inc;
      if (voice.phase >= 1) voice.phase -= 1;
      voice.phase2 += voice.inc2;
      if (voice.phase2 >= 1) voice.phase2 -= 1;
      const tone = (Math.sin(TWO_PI * voice.phase) + Math.sin(TWO_PI * voice.phase2) * 0.7) * voice.aux;
      const noise = this.bandpass(voice, voice.noise());
      out = (tone * voice.toneMix * 1.1 + noise * voice.noiseMix * 1.9) * voice.amp;
    } else if (kind === CLAP) {
      out = this.bandpass(voice, voice.noise()) * voice.aux * 2.2;
    } else if (kind === RIM) {
      voice.phase += voice.inc;
      if (voice.phase >= 1) voice.phase -= 1;
      voice.phase2 += voice.inc2;
      if (voice.phase2 >= 1) voice.phase2 -= 1;
      const tone = Math.sin(TWO_PI * voice.phase) + Math.sin(TWO_PI * voice.phase2) * 0.8;
      out = (tone + voice.noise() * voice.noiseMix) * voice.amp * 0.7;
    } else if (kind === TOM_LO || kind === TOM_MID || kind === TOM_HI) {
      const freq = voice.baseFreq * (1 + voice.sweep * voice.aux);
      voice.phase += freq / sr;
      if (voice.phase >= 1) voice.phase -= 1;
      out = (Math.sin(TWO_PI * voice.phase) + voice.noise() * voice.noiseMix * voice.aux) * voice.amp;
    } else {
      let sum = 0;
      for (let i = 0; i < METAL_RATIOS.length; i++) {
        sum += squareAt(voice.metalPhase[i], voice.metalInc[i]);
        let p = voice.metalPhase[i] + voice.metalInc[i];
        if (p >= 1) p -= 1;
        voice.metalPhase[i] = p;
      }
      sum *= 1 / METAL_RATIOS.length;
      if (voice.inc > 0) {
        voice.phase += voice.inc;
        if (voice.phase >= 1) voice.phase -= 1;
        sum += Math.sin(TWO_PI * voice.phase) * 0.28 * voice.aux;
      }
      out = this.highpass(voice, sum) * voice.amp;
    }

    return out * voice.level * TRIM[kind];
  }

  /** Chamberlin state-variable bandpass. Only used well below Nyquist, where it is stable. */
  bandpass(voice, input) {
    voice.svfLow += voice.svfF * voice.svfBand;
    const high = input - voice.svfLow - voice.svfQ * voice.svfBand;
    voice.svfBand += voice.svfF * high;
    return voice.svfBand;
  }

  /** Two one-pole highpasses in series - 12dB an octave, and unconditionally stable at 8kHz. */
  highpass(voice, input) {
    const a = voice.hpCoef;
    voice.hp1 = a * (voice.hp1 + input - voice.hp1x);
    voice.hp1x = input;
    voice.hp2 = a * (voice.hp2 + voice.hp1 - voice.hp2x);
    voice.hp2x = voice.hp1;
    return voice.hp2;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    const sr = sampleRate;
    const frames = out.length;
    const blockStart = currentTime;
    const gain = this.state.gain * 0.5;
    const clapTail = decayCoef(this.state.clapDecay, sr);

    for (let i = 0; i < frames; i++) {
      const now = blockStart + i / sr;
      while (this.events.length && this.events[0].time <= now) {
        const event = this.events.shift();
        this.allocate(event.midi, now, event.velocity ?? 1, event.id ?? 0);
      }

      let mix = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        const voice = this.voices[v];
        if (!voice.active) continue;
        voice.age++;

        if (voice.attack < 1) {
          voice.attack += voice.attackStep;
          if (voice.attack > 1) voice.attack = 1;
          voice.amp = voice.attack;
        } else {
          voice.amp *= voice.ampCoef;
        }

        if (voice.kind === CLAP) {
          // Re-strike the burst envelope up to three times, then let the last one ring out.
          if (voice.clapBurst < CLAP_BURSTS && voice.t / sr >= voice.clapNext) {
            voice.aux = 1;
            voice.clapBurst++;
            voice.clapNext += CLAP_GAP_S;
          } else {
            voice.aux *= voice.clapBurst >= CLAP_BURSTS ? clapTail : voice.auxCoef;
          }
        } else {
          voice.aux *= voice.auxCoef;
        }

        mix += this.render(voice, sr);
        voice.t++;

        // Retired on level rather than on a length, because a drum has no length - it is finished
        // when it is inaudible. -80dB is far below anything that will survive the mix.
        if (voice.attack >= 1 && voice.amp < 1e-4) voice.active = false;
      }

      out[i] = mix * gain;
    }

    if (++this.quanta >= REPORT_EVERY) {
      let sounding = 0;
      for (let v = 0; v < MAX_VOICES; v++) if (this.voices[v].active) sounding++;
      this.port.postMessage({ type: 'load', voices: sounding });
      this.quanta = 0;
    }

    return true;
  }
}

registerProcessor('drums', DrumProcessor);
