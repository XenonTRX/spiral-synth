// The arithmetic three string instruments are made of.
//
// A piano is a string instrument. So is a guitar, and so is a violin, and the three of them are the
// same object excited three different ways: a hammer that leaves, a pick that leaves, and a bow that
// stays. What differs is the excitation and what happens at the ends; what is identical is the body
// the string is bolted to, the loss that makes a note stop, and the fact that all of it has to be
// deterministic. So the shared parts are here.
//
// The line this draws is the same one voice-dsp.js draws, and for the same reason: **share the
// arithmetic, not the architecture.** A body resonance that is subtly different in the guitar and the
// piano sounds like two rooms, and nobody would ever find it. A voice pool that is subtly different
// sounds like nothing at all.
//
// Same rules as anything that runs on the audio thread. Nothing here allocates outside a constructor,
// nothing closes over anything, and every object is reused in place across notes. There are no
// browser globals and no Web Audio, which is what lets `node --test` render a note and measure it -
// see tests/string-dsp.test.js.

// The delay line and the loop filter are the chorus's and the tape delay's, reused rather than
// rewritten. A plucked string *is* a delay whose length is its pitch, read at a fraction because
// 44100/440 is not a whole number, and the interpolation quality is the tuning accuracy - which is
// exactly the argument delay-line.js already makes at length about why it is cubic. Importing across
// the effects/instruments line is deliberate: the alternative is a fourth copy of a ring buffer.
export { DelayLine, MIN_DELAY_SAMPLES } from '../effects/delay-line.js';

/** The lowest note a string here is built for, which decides how long a delay line has to be. */
export const MIN_STRING_HZ = 26;

/**
 * How many samples of delay line a context needs for the lowest note.
 *
 * Allocated once per voice from this rather than per note, because a note changing the size of its
 * own buffer is an allocation on the audio thread. A C1 at 96kHz is 3692 samples and the line rounds
 * up to a power of two, so this is 4096 numbers a voice - which is nothing, and is the price of never
 * having to think about it again.
 */
export function stringLineSamples(sampleRate) {
  return Math.ceil(sampleRate / MIN_STRING_HZ) + 4;
}

/**
 * xorshift32, seeded per note.
 *
 * Deterministic on purpose, and the fourth thing in this project that needs to be: an exported WAV
 * should be the same file twice and a measurement should be the same measurement twice, or the
 * harness is measuring the weather. `Math.random` would make a pluck a different pluck every time
 * the same song was rendered.
 *
 * A class rather than a copy inside each voice, which is what the drum processor has - that one was
 * written before there was a second caller, and three more copies is where a shared helper starts
 * paying for itself.
 */
export class Rng {
  constructor(seed = 1) {
    this.reseed(seed);
  }

  reseed(seed) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 1;
  }

  /** -1..1. */
  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 2147483648 - 1;
  }
}

/** A seed from a note id and a voice kind, spread out so consecutive notes do not correlate. */
export function noteSeed(id, salt = 0) {
  return ((id * 2654435761 + salt * 40503 + 1) >>> 0) || 1;
}

/**
 * A one-zero lowpass: `(1-b)·x[n] + b·x[n-1]`.
 *
 * This is the loss filter in every string here, and it is a one-*zero* rather than the one-pole
 * everything else in this project uses, for a reason that is the whole difficulty of a waveguide: the
 * filter is inside the loop, so its **delay is part of the pitch**. A one-pole's group delay varies
 * with its cutoff and with frequency, so turning the brightness knob would retune the string - by
 * about a quarter tone at the dull end, which is not subtle. A one-zero's phase delay at low
 * frequency is exactly `b` samples, whatever `b` is, so the string subtracts `b` from its delay
 * length and stays in tune while the knob moves.
 *
 * `b` runs 0 (no filtering, and no delay) to 0.5 (the classic Karplus-Strong two-sample average,
 * which puts a zero exactly at Nyquist). Above 0.5 it would start to boost the top, which is not a
 * thing a string does.
 */
export class OneZero {
  constructor() {
    this.previous = 0;
    this.b = 0.25;
  }

  set(b) {
    this.b = b < 0 ? 0 : b > 0.5 ? 0.5 : b;
  }

  /** The delay this filter contributes, in samples - what the string has to take off its length. */
  get delay() {
    return this.b;
  }

  process(x) {
    const y = (1 - this.b) * x + this.b * this.previous;
    this.previous = x;
    return y;
  }

  reset() {
    this.previous = 0;
  }
}

/** A one-pole highpass, for taking the DC a feedback loop accumulates back out of the output. */
export class DcBlock {
  constructor(sampleRate, hz = 18) {
    this.coef = 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);
    this.state = 0;
  }

  process(x) {
    this.state += (x - this.state) * this.coef;
    return x - this.state;
  }

  reset() {
    this.state = 0;
  }
}

/**
 * The gain a string's loop needs to lose 60dB in `t60` seconds at `f0`.
 *
 * Per *round trip* rather than per sample, which is the only unit that makes the knob mean anything:
 * the signal passes the multiplier once every 1/f0 seconds, so a per-sample figure would make a decay
 * time that changed with pitch. A note at 440Hz goes round 440 times a second and one at 55Hz goes
 * round 55 times, and both have to take the same number of seconds to die.
 *
 * Capped just under 1, because a loop gain of 1 is a string that never stops and anything above it is
 * a string that gets louder until the numbers run out.
 */
export function loopGainFor(f0, t60) {
  if (!(t60 > 0) || !(f0 > 0)) return 0;
  const g = 10 ** (-3 / (f0 * t60));
  return g > 0.99995 ? 0.99995 : g;
}

/**
 * Split a string's per-round-trip loss between a flat gain and a filter, and answer both.
 *
 * This is the least obvious arithmetic in the whole model and it fixes a bug that made the top of the
 * instrument unusable, so it is worth setting out.
 *
 * The naive design is a loop filter with a fixed coefficient: pick `b`, and every trip round the
 * string loses a little more of the top than of the bottom. It sounds right at one pitch and falls
 * apart across a keyboard, because **the filter is applied once per round trip and a high note makes
 * a great many more round trips per second**. At A3 the loop turns over 220 times a second; at C7 it
 * turns over 2093 times. So a filter losing an inaudible 0.05dB per trip at the fundamental costs
 * 9.6dB a second at A3 and 95dB a second at C7 - measured, the top C decayed 60dB in 30ms and the
 * instrument's top octave was a click. Worse, none of it showed up in the Decay knob, which was
 * quietly being overruled by a filter nobody thought of as a loss.
 *
 * The fix is to treat the filter's loss at the fundamental as part of the decay rather than as
 * something separate: the knob keeps setting the filter coefficient - which is the right thing for it
 * to set, because a fixed `b` means the rolloff *by harmonic number* is the same at every pitch - and
 * the flat gain is then whatever is left over after the filter has taken its share. A one-zero's
 * magnitude response is `|H(w)|² = 1 − 2b(1−b)(1−cos w)`, so that share is a closed form rather than
 * a fit, and the fundamental ends up decaying exactly as the Decay knob says.
 *
 * Wherever it can, that is. Past a certain pitch the filter alone loses more per second than the knob
 * asked for, and there is nothing to be done about it: compensating would need a loop gain above
 * unity, and a loop whose gain exceeds one anywhere - including at DC, where a one-zero passes
 * everything - grows without bound. So the gain is capped just under one and those notes ring for
 * less than the knob says. With the default damping that is above about 1kHz, and it is the right
 * failure: a short string really does lose its energy faster, and the alternative is not a longer
 * note, it is an explosion.
 */
export function stringLoss(f0, t60, damping, sampleRate) {
  const b = damping < 0 ? 0 : damping > 0.5 ? 0.5 : damping;
  const w = (2 * Math.PI * Math.max(1, f0)) / sampleRate;
  const u = 1 - Math.cos(Math.min(Math.PI * 0.999, w));
  const loss = Math.sqrt(Math.max(1e-9, 1 - 2 * b * (1 - b) * u));
  const gain = loopGainFor(f0, t60) / loss;
  return { b, gain: gain > 0.99995 ? 0.99995 : gain };
}

/**
 * How long a note at `f0` actually rings, given a decay time quoted at `REFERENCE_HZ` and a tilt.
 *
 * Real strings do not all ring for the same time. A piano's bottom A sustains for the best part of a
 * minute and its top C is gone in a second, and the same is true of a guitar's sixth string against
 * its first - the energy leaves faster when there is less mass carrying it and the losses are
 * frequency-dependent. A single decay knob applied flat across the keyboard is the single most
 * obvious tell that a string model is a synthesiser: the top octave rings like a bell.
 *
 * `tilt` of 0 is that flat behaviour, and 1 makes the decay inversely proportional to pitch - so an
 * octave up rings half as long.
 */
export const REFERENCE_HZ = 110;

export function tiltedDecay(t60, f0, tilt, reference = REFERENCE_HZ) {
  if (!(tilt > 0)) return t60;
  return t60 * (reference / Math.max(1, f0)) ** tilt;
}

/**
 * The friction between a bow and a string, as a coefficient 0..1.
 *
 * This one function is the whole difference between a bowed string and a filtered sawtooth. A bow
 * does not drive a string; it *grips* it, drags it until the restoring force wins, slips, and grips
 * again - and it is that stick-slip cycle, not any oscillator, that decides the pitch and puts the
 * characteristic sawtooth-ish corner in the waveform. The grip is strongest when the bow and the
 * string are moving together and falls away sharply as they slide, which is what this curve is:
 * flat-topped near zero relative velocity, then a steep fall.
 *
 * The fourth power and the 0.75 offset are the classic table from the physical-modelling literature
 * (McIntyre-Woodhouse, by way of the STK), kept because the exponent is what decides whether the
 * model oscillates at all: shallower and the string never lets go, so it drifts to a stop; steeper
 * and it never grips, so there is nothing to release.
 *
 * `slope` is the bow pressure, inverted - a small slope is a heavy, sticky bow and a large one is a
 * light one that slips early.
 */
export function bowFriction(velocityDifference, slope, offset = 0.001) {
  const x = Math.abs((velocityDifference + offset) * slope) + 0.75;
  const f = x ** -4;
  return f > 1 ? 1 : f;
}

/**
 * One resonance of a body, as a two-pole resonator.
 *
 * A guitar's box, a violin's, and a piano's soundboard are all the same thing to a string: a lump of
 * wood with a handful of strong resonances that colours everything and radiates it. Modelling that
 * properly is a mesh; modelling it as three peaks is most of what you can hear, and it is the
 * difference between a string that sounds like a plucked string and one that sounds like a plucked
 * string in an instrument.
 *
 * A two-pole with a zero at DC and Nyquist, normalised to unity at the peak, so turning the body up
 * cannot make the level jump.
 */
export class Resonance {
  constructor() {
    this.b0 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  /** `q` here is the pole radius' companion: bandwidth as a fraction of the centre frequency. */
  set(hz, q, sampleRate) {
    const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
    const r = Math.exp(-w / (2 * Math.max(0.05, q)));
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -(r * r);
    // Normalised so the peak comes out at about unity, rather than at whatever the pole radius
    // happens to give - which is 40dB of difference between a narrow peak and a wide one, and would
    // make the body knob a volume control that also changed the tone.
    this.b0 = (1 - r * r) * Math.sin(w);
  }

  process(x) {
    const y = this.b0 * x + this.a1 * this.y1 + this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset() {
    this.y1 = 0;
    this.y2 = 0;
  }
}

/**
 * Three resonances in parallel, which is a body.
 *
 * The frequencies are a scale factor away from a small instrument's, so one knob moves the whole box:
 * a violin is a small guitar as far as this is concerned, and a piano's soundboard is a very large
 * one. The three peaks are the air resonance, the main plate mode, and one higher plate mode, which
 * is the smallest set that reads as wood rather than as a filter.
 */
export class Body {
  /**
   * The shape of the box is fixed at construction and only its *size* moves afterwards.
   *
   * Which is not a simplification, it is the no-allocation rule: `setScale` is called once per
   * quantum per voice, and a version that took its frequencies as an argument would mean an array
   * literal on the audio thread forty times a millisecond. A guitar and a violin are different boxes,
   * so they pass different tables here, once, when their voices are built.
   */
  constructor(sampleRate, hz = [110, 215, 420], q = [3.5, 4.5, 6], gains = [1, 0.7, 0.45]) {
    this.sampleRate = sampleRate;
    this.peaks = [new Resonance(), new Resonance(), new Resonance()];
    this.hz = new Float64Array(hz);
    this.q = new Float64Array(q);
    this.gains = new Float64Array(gains);
    this.scale = 0;
    this.setScale(1);
  }

  setScale(scale) {
    if (scale === this.scale) return;
    this.scale = scale;
    for (let i = 0; i < this.peaks.length; i++) this.peaks[i].set(this.hz[i] * scale, this.q[i], this.sampleRate);
  }

  process(x) {
    let sum = 0;
    for (let i = 0; i < this.peaks.length; i++) sum += this.peaks[i].process(x) * this.gains[i];
    return sum;
  }

  reset() {
    for (const peak of this.peaks) peak.reset();
  }
}

/**
 * A velocity's effect on brightness, as an exponent for a `1/n^tilt` partial rolloff.
 *
 * Every one of these instruments is brighter when it is played harder, and none of them is simply
 * louder: a piano struck softly has almost no upper partials, a plucked string picked hard has a
 * spectrum an octave wider, and a bow drawn faster grips longer before it slips. A model that only
 * scales the level is the other obvious tell - a quiet note sounds like the loud one turned down,
 * which is the machine-gun problem in the frequency domain.
 */
export function brightnessTilt(velocity, hardness) {
  const v = velocity < 0.02 ? 0.02 : velocity > 1 ? 1 : velocity;
  return 1 + (1 - v) * 2.2 * (1 - Math.max(0, Math.min(1, hardness)));
}
