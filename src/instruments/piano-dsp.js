// A piano, as a bank of decaying sinusoids rather than as a delay line.
//
// The other two strings here are waveguides: a delay line whose length is the pitch, which is the
// right model for them because what you do to those instruments happens *at a point on the string*
// and at a particular moment - a pick leaves, a bow stays. A piano hammer also leaves, so a waveguide
// would work, and it is the wrong tool anyway. Everything that makes a piano sound like a piano is a
// statement about its **partials**, one at a time:
//
//   - They are **not** harmonics. A piano string is stiff, so it resists bending, so the restoring
//     force on a short wavelength is larger than the wave equation says - and the nth partial lands
//     at `n·f0·√(1+B·n²)` rather than at `n·f0`. B is tiny (a ten-thousandth) and the consequence is
//     enormous: by the sixteenth partial the string is a third of a semitone sharp of where a harmonic
//     series would put it, the octaves inside one note do not line up, and that is *the* piano sound.
//     It is also why pianos are tuned stretched, and why a perfectly harmonic "piano" patch sounds
//     like an organ with a percussive envelope.
//   - They **decay at different rates**. High partials lose energy far faster than low ones, so a
//     struck note starts as a clang and becomes a sine within a second or two. One envelope over the
//     whole spectrum cannot do that.
//   - Their **amplitudes come from where the hammer hits**. A hammer at a nodal point of the eighth
//     partial cannot excite it, so a strike an eighth of the way along leaves a notch there. This is
//     why the low register sounds hollow in a specific way rather than merely dark.
//   - There are **two or three strings per note**, tuned very slightly apart, and the beating between
//     them is what makes a piano sound wide and alive rather than like a bell.
//
// Every one of those is a per-partial fact, so the model is per-partial: an exponentially decaying
// sinusoid each, and no filter, envelope or oscillator anywhere. That reads as expensive and is not -
// see `Partials.tick` for why it is four multiplies and two adds per partial with no `Math.sin` at
// all, and why the decay is *inside* the rotation rather than being a second multiply.
//
// The honest limits of this: it is not physical modelling. There is no hammer-felt nonlinearity, no
// coupling between the strings of a unison beyond their being detuned, no sympathetic resonance from
// the undamped strings and no pedal. What it is, is every *linear* property of a struck string, which
// is most of what the instrument is, made of controls that mean what they say.
//
// Audio-thread rules: nothing allocates after the constructor, and there are no browser globals - so
// a test can strike a note and check the partials are where the arithmetic says.

import { Body, DcBlock, Rng, brightnessTilt, noteSeed, tiltedDecay } from './string-dsp.js';
import { PolyEngine } from './poly-engine.js';

/** What a part's state looks like when nothing has been saved. Mirrors PIANO_PARAMS' defaults. */
export const PIANO_DEFAULTS = {
  hammer: 0.13,
  hardness: 0.5,
  inharmonic: 1,
  partials: 20,
  decay: 7,
  decayTilt: 0.6,
  detune: 3.5,
  thump: 0.35,
  board: 0.3,
  release: 0.14,
  tune: 0,
  gain: 0.25,
  mod: [],
};

/**
 * The destinations, in the order the voices read them out of `mod`.
 *
 * Level only, and that is the whole list on purpose. `tune` is a destination on the other two strings
 * because a delay line's length can move while it rings; a partial bank cannot, so a routing aimed at
 * it would be a control that moved and did nothing - see the Tune knob's own note in piano.js. The
 * rule this keeps is that every destination the panel offers is one the sound actually has.
 */
export const PIANO_TARGETS = ['gain'];
const MOD_GAIN = 0;

/**
 * The most partials a note can have, whatever the knob says.
 *
 * Thirty-two, and it is a cost ceiling rather than a musical one: a bass note on a real piano has
 * dozens of audible partials, and the arithmetic here is four multiplies each per string per sample.
 * Two strings, thirty-two partials and ten voices is 640 rotations a sample, which is the most this
 * is prepared to spend. The count adapts downwards on its own - anything past Nyquist is never built,
 * and a partial the hammer position kills is skipped - so a treble note costs a fraction of a bass
 * one and a full chord in the bass is the only case that reaches this.
 */
export const MAX_PARTIALS = 32;

/**
 * Two strings a note, not three.
 *
 * A real grand has one string in the bass, two in the middle and three in the treble, and the reason
 * is loudness rather than sound. What the extra strings buy audibly is the beating between them, and
 * two is enough to have beating: a third mostly makes the beat pattern more complex. Two costs half
 * again as much as one and sounds most of the way there, which is the trade this makes deliberately.
 */
const STRINGS = 2;

/**
 * The inharmonicity coefficient B at a given pitch.
 *
 * B is not a constant across a piano - it is set by the stiffness, length and tension of each string,
 * and a piano's design pushes it up towards the treble, where the strings are short. Measured values
 * on real instruments run from around a hundred-thousandth in the bass to a thousandth at the top,
 * and this is the trend fitted through the middle: a ten-thousandth at middle C, rising as the
 * one-and-a-half power of frequency. The `inharmonic` knob scales it, and at zero it is switched off
 * entirely - which is worth having precisely because it sounds so wrong.
 */
function inharmonicity(f0, amount) {
  return 1e-4 * (f0 / 261.626) ** 1.5 * amount;
}

export class PianoVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    const size = MAX_PARTIALS * STRINGS;
    // A rotating complex number per partial per string. `re`/`im` is the state; `c`/`s` is the
    // rotation, and its *magnitude* is the per-sample decay - which is the trick this file turns on.
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.c = new Float64Array(size);
    this.s = new Float64Array(size);
    // The frequency and the decay each partial was set up with, so a release can rescale the
    // rotation without recomputing a cosine.
    this.hz = new Float64Array(size);
    this.decay = new Float64Array(size);
    this.count = 0;

    this.rng = new Rng();
    this.dc = new DcBlock(sampleRate);
    // A soundboard is a much bigger, much less resonant box than a guitar's - a wide radiator with
    // broad modes rather than three sharp ones - so the peaks are low and the Qs are loose.
    this.board = new Body(sampleRate, [95, 185, 340], [2.2, 2.6, 3], [1, 0.7, 0.5]);
    this.boardMix = 0;

    this.thumpLeft = 0;
    this.thumpTotal = 1;
    this.thumpPole = 0;
    this.thumpCoef = 0.4;
    this.thumpLevel = 0;

    this.envelope = 0;
    this.envelopeCoef = 0;
    this.velocity = 1;
    this.active = false;
  }

  /**
   * Set the partial bank up for one strike.
   *
   * All of the arithmetic that has a `Math.sin`, a `Math.cos` or a `**` in it happens here, once per
   * note, because a note's partials do not move: a piano string's pitch is fixed the moment it is
   * struck and its decay is a property of the string. That is what makes the per-sample cost four
   * multiplies - everything expensive has already been done.
   */
  start(velocity, state) {
    const sr = this.sampleRate;
    const v = velocity <= 0 ? 0.02 : velocity > 1 ? 1 : velocity;
    this.velocity = v;
    this.rng.reseed(noteSeed(this.id, 41));
    this.dc.reset();
    this.board.reset();
    this.active = true;

    const f0 = Math.max(8, this.tuned || this.freq);
    const nyquist = sr * 0.5;
    const wanted = Math.max(1, Math.min(MAX_PARTIALS, Math.round(state.partials)));
    const B = inharmonicity(f0, Math.max(0, state.inharmonic));
    const hammer = Math.max(0.01, Math.min(0.4, state.hammer));
    // Harder strikes are brighter. Not louder - brighter: the felt compresses more, the contact time
    // shortens, and the spectrum reaches an octave higher. A model that only scales the level is the
    // reason velocity on a sampled piano so often sounds like a volume pedal.
    const tilt = brightnessTilt(v, state.hardness);
    // The detune is split either side of the note, so turning it up widens the pair without moving
    // the pitch - the same rule the wavetable's unison keeps.
    const spread = Math.max(0, state.detune) / 2;
    const t60Base = tiltedDecay(Math.max(0.2, state.decay), f0, 0.35, 261.626);

    this.count = 0;
    let sum = 0;
    for (let n = 1; n <= wanted; n++) {
      const stretch = Math.sqrt(1 + B * n * n);
      const hz = n * f0 * stretch;
      if (hz >= nyquist * 0.96) break;
      // Where the hammer hits, as the string's own answer to being struck there: a sine in the
      // position, so a partial with a node under the hammer gets nothing. Plus the rolloff, which is
      // what velocity moves.
      const shape = Math.abs(Math.sin(n * Math.PI * hammer)) / n ** tilt;
      if (shape < 1e-4) continue;
      // Higher partials die faster, which is most of what a piano note *does* over its length. The
      // tilt is against the partial's own frequency rather than its index, so a partial an octave up
      // decays the same way whether it is the second of a low note or the eighth of a high one.
      const t60 = Math.max(0.05, tiltedDecay(t60Base, hz, state.decayTilt, f0));
      for (let k = 0; k < STRINGS; k++) {
        const i = this.count++;
        // Cents either side, so the pair beats. The beat rate is the frequency difference, which
        // rises with the partial index - which is exactly why a piano's top partials shimmer faster
        // than its fundamental does, and why one detune knob is enough.
        const cents = k === 0 ? -spread : spread;
        this.hz[i] = hz * 2 ** (cents / 1200);
        // The two strings are deliberately *not* matched, and this is not decoration - it is the
        // difference between beating and cancellation. Two partials of equal amplitude 3.5 cents
        // apart null each other completely once per beat, so the fundamental of every note vanished
        // for a moment every couple of seconds: measured, 17dB of swing on a held middle C. One hammer
        // never hits two strings identically and the two never decay at the same rate, so the pair is
        // uneven in both, and what is left is a beat that breathes rather than one that pumps.
        const weight = k === 0 ? 0.58 : 0.42;
        this.decay[i] = 10 ** (-3 / (t60 * (k === 0 ? 1 : 0.82) * sr));
        const w = (2 * Math.PI * this.hz[i]) / sr;
        this.c[i] = this.decay[i] * Math.cos(w);
        this.s[i] = this.decay[i] * Math.sin(w);
        // Starting at (amp, 0) and reading `im` means the partial starts at zero and rises, so the
        // bank sums to silence at the moment of the strike and there is no step to click on.
        this.re[i] = shape * weight;
        this.im[i] = 0;
        sum += shape * weight;
      }
    }
    // Normalised, so the number of partials and where the hammer hits change the *tone* and not the
    // level. Without it, turning the partial count up is a volume control.
    const norm = sum > 0 ? 1 / sum : 0;
    for (let i = 0; i < this.count; i++) this.re[i] *= norm * v;

    // The knock: the hammer hitting wood and felt, which is not part of the string at all. It is
    // what makes a piano's attack read as a *strike* - without it the note fades in over the first
    // few milliseconds, because every partial starts at zero.
    this.thumpLevel = Math.max(0, Math.min(1, state.thump)) * v;
    this.thumpTotal = Math.max(2, Math.round(0.004 * sr));
    this.thumpLeft = this.thumpTotal;
    this.thumpPole = 0;
    this.thumpCoef = 1 - Math.exp((-2 * Math.PI * Math.min(900 + 2400 * state.hardness, sr * 0.45)) / sr);

    // The slowest partial's decay, which is how long the note has left. Tracked as one number rather
    // than by scanning the bank, because "is anything still audible" is asked every sample.
    this.envelope = 1;
    this.envelopeCoef = this.count ? Math.max(...Array.prototype.slice.call(this.decay, 0, this.count)) : 0;
    this.prepare(state);
  }

  prepare(state) {
    this.board.setScale(1);
    this.boardMix = Math.max(0, Math.min(1, state.board));
  }

  /**
   * A piano string cannot be bent, and the model follows it.
   *
   * Retuning a struck bank would mean recomputing a cosine per partial per sample, which is the one
   * thing this design cannot afford - and it would be modelling something that does not exist. The
   * instrument declares `slides: false` for the same reason, so nothing offers the gesture. What
   * arrives here is the tune knob before the note starts, which is a different thing and works.
   */
  setFrequency(hz) {
    this.tuned = hz;
  }

  /**
   * The damper coming down.
   *
   * A felt damper on a ringing string is a very large loss, so every partial's decay is replaced by
   * one short one - and it is a *replacement of the decay*, not a gain ramp, which is the same
   * distinction the plucked string makes: a gain ramp fades the note out with its spectrum intact,
   * where a damper takes the top off it on the way down. Scaling the rotation rather than rebuilding
   * it keeps this cheap: the rotation's magnitude *is* the decay, so one multiply per partial
   * re-tunes the whole envelope without touching a trigonometric function.
   */
  release(state) {
    const t60 = Math.max(0.02, state.release);
    const target = 10 ** (-3 / (t60 * this.sampleRate));
    for (let i = 0; i < this.count; i++) {
      if (this.decay[i] <= target) continue;
      const ratio = target / this.decay[i];
      this.c[i] *= ratio;
      this.s[i] *= ratio;
      this.decay[i] = target;
    }
    this.envelopeCoef = Math.min(this.envelopeCoef, target);
  }

  tick(state) {
    let sum = 0;
    const { re, im, c, s } = this;
    for (let i = 0; i < this.count; i++) {
      // One complex multiply: a rotation by the partial's frequency, scaled by its decay. The result
      // is an exact exponentially decaying sinusoid, with no phase accumulator to wrap and no table
      // to interpolate - and `im` is the sine of it.
      const nre = re[i] * c[i] - im[i] * s[i];
      const nim = re[i] * s[i] + im[i] * c[i];
      re[i] = nre;
      im[i] = nim;
      sum += nim;
    }

    if (this.thumpLeft > 0) {
      const phase = 1 - this.thumpLeft / this.thumpTotal;
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
      this.thumpPole += (this.rng.next() * window - this.thumpPole) * this.thumpCoef;
      sum += this.thumpPole * this.thumpLevel * 0.5;
      this.thumpLeft--;
    }

    this.envelope *= this.envelopeCoef;
    if (this.envelope < 1e-5 && this.thumpLeft === 0) this.active = false;

    let out = this.dc.process(sum);
    if (this.boardMix > 0) out += this.board.process(out) * this.boardMix * 1.2;
    const level = 1 + this.mod[MOD_GAIN];
    return out * (level > 0 ? level : 0);
  }
}

export function createPianoEngine(sampleRate, voiceCount = 10) {
  const voices = [];
  for (let i = 0; i < voiceCount; i++) voices.push(new PianoVoice(sampleRate));
  return new PolyEngine({ sampleRate, defaults: PIANO_DEFAULTS, targets: PIANO_TARGETS, voices });
}
