// A plucked string, as a string rather than as a sound that resembles one.
//
// Every other instrument here starts from an oscillator and shapes it. This starts from the physics
// and lets the sound be whatever falls out, which is a different kind of design: there is no
// waveform, no envelope and no filter sweep, and the knobs are where the pick hits, how hard it is,
// and how quickly the string gives up its energy. What comes out is a plucked string because that is
// what the arithmetic *is*, not because it was tuned until it sounded like one.
//
// **The model.** A string with both ends fixed is a delay line with its output fed back to its input,
// inverted and slightly lossy. A displacement put into it travels to one end, comes back inverted,
// travels to the other, comes back the right way up, and is then where it started - so the whole
// thing repeats every `2·length/speed` seconds, which is the pitch. Losses at the ends and inside the
// wire take a little off every trip, and they take more off the high harmonics than the low ones,
// which is why a plucked note starts bright and turns into a sine wave as it dies. That is the entire
// instrument: **a delay line, a loss, and a filter.** It is Karplus-Strong, which was published in
// 1983 as a curiosity about cheap sounds and turned out to be a digital waveguide - the same
// arithmetic you get by discretising the wave equation, and the reason a hundred lines of it sounds
// more like a guitar than a hundred oscillators do.
//
// Three things are added to the bare loop, and each one is a thing you can hear the absence of:
//
//   - **Where the pick hits.** A pick at the twelfth fret cannot excite any harmonic that has a node
//     there, so the even harmonics vanish and the note goes hollow; near the bridge every harmonic is
//     excited and it is thin and nasal. This is a comb filter on the excitation, and it is the
//     difference between one guitar tone and all of them.
//   - **How hard the pick is.** A fingertip is a wide, soft contact and excites almost nothing above
//     a few hundred Hz; a plectrum is a hard narrow one. A lowpass on the noise burst, and the reason
//     the same string can be a nylon or a steel one.
//   - **The box.** A string on its own radiates almost nothing - it is a wire. What you hear is the
//     body it is bolted to, and three resonances of it is most of what that does.
//
// **Why it is a good fit for this project specifically.** It is the one instrument family the
// analyser's headline number is exactly right about. A string's partials are integer multiples of its
// fundamental by construction, so "how much of this is not a multiple of the note" is a real question
// with a real answer, and the answer is a measurement of the interpolation in the delay line: a
// linear read would put the partials measurably flat, and this one does not. See tests/pluck-dsp.js.
//
// Audio-thread rules: nothing allocates after the constructor, and the file has no browser globals in
// it, so a test can pluck a string and take its spectrum.

import {
  Body,
  DcBlock,
  DelayLine,
  OneZero,
  Rng,
  noteSeed,
  stringLineSamples,
  stringLoss,
  tiltedDecay,
} from './string-dsp.js';
import { PolyEngine } from './poly-engine.js';

/**
 * What a part's state looks like when nothing has been saved. Mirrors PLUCK_PARAMS' defaults.
 *
 * The damping and the tilt are the two that were chosen by measurement rather than by ear, because
 * both of them are about how the instrument behaves *across* its range, which is not something one
 * note can tell you. At these settings an A3's fundamental decays at 24dB/s, its fourth harmonic at
 * 27 and its eighth at 33 - so the note visibly darkens as it rings, which is the thing a plucked
 * string does and a decaying oscillator does not - while the fundamental's own decay stays exactly
 * what the Decay knob asks for at every pitch. See `stringLoss` for why that last part is not free.
 */
export const PLUCK_DEFAULTS = {
  pluckPosition: 0.22,
  pickHardness: 0.6,
  damping: 0.2,
  decay: 3.4,
  decayTilt: 0.45,
  body: 0.35,
  bodySize: 1,
  release: 0.4,
  tune: 0,
  gain: 0.25,
  mod: [],
};

/** The destinations, in the order the voices read them out of `mod`. */
export const PLUCK_TARGETS = ['gain', 'tune'];
const MOD_GAIN = 0;

/**
 * How long the excitation lasts, as a fraction of one period.
 *
 * The textbook pluck fills the whole delay line with noise, which is a burst exactly one period long
 * and is what makes the classic version sound synthetic: it is a full period of broadband noise, so
 * the attack is a *hiss* with a note behind it rather than a click with a note behind it. A real
 * contact is over in a millisecond or two, which at any pitch above the bass is a small fraction of a
 * period. Half of one, capped, is short enough to read as a contact and long enough to put energy in
 * the low harmonics of a bottom E.
 */
const PLUCK_TURNS = 0.5;
const PLUCK_MAX_S = 0.006;

export class PluckVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.line = new DelayLine(stringLineSamples(sampleRate));
    // The comb that puts the pick position in. A separate short line rather than arithmetic on the
    // string's own, because the two are read at different distances and a delay line has one write
    // pointer - and because this one only ever holds the excitation, which is over in milliseconds.
    this.comb = new DelayLine(stringLineSamples(sampleRate));
    this.loop = new OneZero();
    this.dc = new DcBlock(sampleRate);
    this.body = new Body(sampleRate);
    this.rng = new Rng();

    this.delay = 100;
    this.loopGain = 0.99;
    this.exciteLeft = 0;
    this.exciteTotal = 1;
    this.excitePole = 0;
    this.exciteCoef = 0.5;
    this.combDelay = 1;
    this.velocity = 1;
    this.bodyMix = 0;
    this.energy = 0;
    this.released = false;
    this.active = false;
  }

  /** A fresh pluck: the string is cleared and given a burst of noise to carry. */
  start(velocity, state) {
    this.velocity = velocity <= 0 ? 0.02 : velocity > 1 ? 1 : velocity;
    this.line.reset();
    this.comb.reset();
    this.loop.reset();
    this.dc.reset();
    this.body.reset();
    this.rng.reseed(noteSeed(this.id, 11));
    this.released = false;
    this.active = true;
    // Not zero: the first sample of a pluck is the loudest thing the note will do, and a voice that
    // retired on "energy below a threshold" before it had any would never sound at all.
    this.energy = 1;

    const period = this.sampleRate / Math.max(1, this.tuned || this.freq);
    const burst = Math.min(period * PLUCK_TURNS, PLUCK_MAX_S * this.sampleRate);
    this.exciteLeft = Math.max(2, Math.round(burst));
    this.exciteTotal = this.exciteLeft;
    this.excitePole = 0;
    this.prepare(state);
  }

  /**
   * Everything that comes off a knob, once per quantum.
   *
   * The pick's own settings are read here as well as at the start, which is the difference between a
   * knob you can turn while a note rings and one you cannot: the position and the hardness only
   * affect a note being struck, and the decay, damping and body affect one that is already going.
   */
  prepare(state) {
    const hz = this.tuned || this.freq;
    const t60 = this.released
      ? Math.max(0.02, state.release)
      : tiltedDecay(state.decay, hz, state.decayTilt);
    // The two halves of the string's loss, solved together rather than set independently - see
    // `stringLoss`, which exists because setting them independently made the top octave a click.
    const loss = stringLoss(hz, t60, state.damping, this.sampleRate);
    this.loop.set(loss.b);
    this.loopGain = loss.gain;
    // The loop filter's delay is part of the pitch, so it comes off the length. This is the whole
    // reason the filter is a one-zero: `b` samples, exactly, at any setting, so the knob cannot
    // retune the string.
    this.delay = Math.max(2, this.sampleRate / Math.max(1, hz) - this.loop.delay);

    // How far along the string the pick is, as a comb delay: a fraction of the string's own length.
    // `1 - z^-pL` notches at every multiple of `1/p`, so a pick half way along loses the even
    // harmonics and one at a quarter loses the fourth, the eighth and so on - which is exactly which
    // partials have a node under the pick and therefore cannot be excited by it.
    //
    // It was `p·L·2` first, on the reasoning that the reflection travels to the near end and back.
    // That is a fact about the string and the wrong length for this filter, and at a pick position of
    // 0.5 it made the comb delay one whole period - which notches *every* harmonic, so the note came
    // out 40dB down with nothing left in it. Measured before it was understood, which is the only
    // reason it was caught: a "hollow" tone at the halfway point is exactly what you expect to hear.
    const position = Math.max(0.02, Math.min(0.5, state.pluckPosition));
    this.combDelay = Math.max(1, this.delay * position);

    // A hard pick is a narrow contact and excites everything; a fingertip is wide and soft. One pole,
    // from about 300Hz at the softest to well past anything the string will carry - and multiplied by
    // how hard the note was struck, because a harder pluck is a *brighter* pluck and not merely a
    // louder one. That is the difference between dynamics and a volume control, and on a string it is
    // not a refinement: the same note at two velocities has two spectra.
    const hardness = Math.max(0, Math.min(1, state.pickHardness));
    const cutoff = 200 * (1 + 40 * hardness ** 2) * (0.3 + 0.7 * this.velocity);
    this.exciteCoef = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, this.sampleRate * 0.45)) / this.sampleRate);

    this.body.setScale(Math.max(0.4, state.bodySize));
    this.bodyMix = Math.max(0, Math.min(1, state.body));
  }

  setFrequency(hz, state) {
    this.tuned = hz;
    this.prepare(state);
  }

  /**
   * Letting go of a plucked string does not stop it, it damps it.
   *
   * Which is why this is a change to the loss rather than an envelope: a guitar string that is let go
   * carries on ringing, and one that is *muted* dies in a fraction of a second because a hand on it
   * is a huge loss at the end. Both of those are the same knob at different settings, and neither is
   * a gain ramp - a gain ramp would fade the note out with its spectrum intact, where damping takes
   * the top off it on the way down, which is what a hand does.
   */
  release(state) {
    this.released = true;
    this.prepare(state);
  }

  tick(state) {
    // Read before write: a loop that read what it wrote in the same sample would be a zero-delay
    // feedback path, which has no meaning and no solution.
    const back = this.line.readAt(this.delay);

    let input = 0;
    if (this.exciteLeft > 0) {
      // A raised-cosine window on the burst, so the contact starts and ends at zero. A rectangular
      // burst has two steps in it, and a step is broadband - it puts a click on the front of the
      // note that has nothing to do with the string.
      const phase = 1 - this.exciteLeft / this.exciteTotal;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
      const raw = this.rng.next() * window;
      this.excitePole += (raw - this.excitePole) * this.exciteCoef;
      input = this.excitePole * this.velocity;
      this.exciteLeft--;
    }
    // The comb runs whatever the excitation is doing, including nothing, so the tail of it that is
    // still in the line comes back out at the right moment.
    const combed = input - this.comb.readAt(this.combDelay);
    this.comb.write(input);

    const fed = this.loop.process(back) * this.loopGain;
    this.line.write(fed + combed);

    // Energy, as the slow envelope of the loop. Retiring on this rather than on a length is the only
    // honest test for a string: it is finished when there is nothing left in it, and how long that
    // takes depends on the pitch, the decay, the damping and whether it was let go.
    const magnitude = back < 0 ? -back : back;
    this.energy += (magnitude - this.energy) * 0.0005;
    if (this.energy < 2e-5 && this.exciteLeft === 0) this.active = false;

    let out = this.dc.process(back);
    if (this.bodyMix > 0) out += this.body.process(out) * this.bodyMix * 1.6;
    const level = 1 + this.mod[MOD_GAIN];
    return out * (level > 0 ? level : 0);
  }
}

export function createPluckEngine(sampleRate, voiceCount = 10) {
  const voices = [];
  for (let i = 0; i < voiceCount; i++) voices.push(new PluckVoice(sampleRate));
  return new PolyEngine({ sampleRate, defaults: PLUCK_DEFAULTS, targets: PLUCK_TARGETS, voices });
}
