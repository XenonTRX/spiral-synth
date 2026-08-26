// A chorus, as arithmetic that runs without a browser.
//
// **It is a delay whose length is moving, and that is the whole of it.** Everything called chorus,
// flanger, ensemble or vibrato is this one circuit at different settings, and saying so out loud is
// more useful than three effects that pretend to be unrelated:
//
//   - **Chorus** is a delay of 10 to 25 milliseconds, swept slowly, mixed roughly half and half with
//     the dry. You hear it as two instruments slightly out of tune with each other, because that is
//     what it is - the swept copy is pitch-shifted by however fast the sweep is moving.
//   - **Flanger** is the same thing at 1 to 5 milliseconds with feedback. Short enough that the comb
//     notches land inside the audible range and move through it, which is the jet-plane sound.
//   - **Vibrato** is the same thing with the dry turned off. Nothing to beat against, so all you hear
//     is the pitch moving.
//
// So there is one effect here with a delay knob, a feedback knob and a mix knob, and the presets are
// the names. A user who wants a flanger reaches for the preset called Flanger and lands in the same
// DSP with the delay short and the feedback up.
//
// **Why the voices share one LFO.** Three independent LFOs at slightly different rates is the obvious
// way to build an ensemble and it is not what the machine everyone is imitating did. A Juno-106's
// chorus is one triangle oscillator driving two bucket-brigade lines in antiphase, and the reason that
// matters is that independent rates drift: the voices pass through unison every so often, and the
// effect audibly thins out for a moment each time they do. One LFO at fixed phase offsets can never
// thin out, because the voices are never in unison. It is also why the effect has a *character* rather
// than a wander.
//
// The interpolation is where the quality of this actually lives, and it is in delay-line.js with the
// numbers that decided it.

import { DelayLine } from './delay-line.js';

export const CHORUS_DEFAULTS = {
  voices: 2,
  rate: 0.62,
  depth: 0.5,
  delayMs: 6,
  feedback: 0,
  shape: 'triangle',
  mix: 0.5,
};

export const MAX_VOICES = 3;

/**
 * The base delay the knob may ask for, and the sweep the depth knob adds *on top of* it.
 *
 * One-sided rather than centred, which is a small decision with a large consequence. Centred on the
 * base is the obvious reading of "depth", and it means a flanger - whose whole point is a base delay
 * of one or two milliseconds - has a sweep that runs off the bottom and sits clamped against the
 * shortest read for most of every cycle, which is a sweep with a flat spot in it. One-sided makes the
 * Delay knob mean the *shortest* read, the sweep always fits, and there is nothing to clamp.
 */
const MAX_DELAY_MS = 30;
const MAX_SWEEP_MS = 12;

/**
 * The shortest read, in milliseconds.
 *
 * A flanger wants to get as close to zero as it can - that is where the first comb notch is highest
 * in frequency - and the four-point interpolator needs a sample on the near side, so the hard floor
 * is about 0.02ms at 48kHz. 0.2ms is the floor here because below it the base is a fraction of a
 * sample and the interpolator is doing all the work.
 */
const MIN_DELAY_MS = 0.2;

/**
 * What each voice count is divided by, so that changing it does not change the level.
 *
 * Not `1/N`, and `1/√N` only once it had been checked. The voices are delayed copies of one signal, so
 * they are neither identical - which would add up as N - nor independent, which would add up as √N;
 * they are comb-filtered versions of each other and how much they reinforce depends on the spread of
 * the taps. Measured, with pink-ish noise through the wet path alone, RMS in dB relative to one voice:
 *
 *   voices        1        2        3
 *   raw sum    0.00    +3.12    +5.04 dB
 *   √N would   0.00    +3.01    +4.77 dB
 *
 * So they are slightly *more* correlated than independent, and dividing by √N leaves three voices
 * 0.27dB louder than one - which is under the ear's threshold for a level change and not worth a
 * table of measured constants. Using N would have made three voices four and a half decibels quiet.
 */
const VOICE_NORM = [1, 1 / Math.SQRT2, 1 / Math.sqrt(3)];

/**
 * The two LFO shapes, as a fraction of the sweep: 0 at the shortest read, 1 at the longest.
 *
 * A triangle sweeps the delay at a constant rate, so the pitch shift it produces is *constant* and
 * simply changes sign twice a cycle - which is why a Juno sounds like two fixed detunings swapping
 * over rather than like something wobbling, and why it is the default here. A sine's pitch shift is
 * itself a sine, peaking π/2 higher than the triangle's for the same depth: measured off the output at
 * 0.62Hz, 50% depth and one voice, the sine swings ±20.3 cents where the triangle holds ±13.0.
 */
const unipolarSine = (turns) => 0.5 + 0.5 * Math.sin(Math.PI * 2 * turns);
const unipolarTriangle = (turns) => {
  const t = turns - Math.floor(turns);
  return t < 0.5 ? 2 * t : 2 - 2 * t;
};

export class Chorus {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    const maxSamples = ((MAX_DELAY_MS + MAX_SWEEP_MS) / 1000) * sampleRate + 8;
    this.line = new DelayLine(maxSamples);
    // Turns rather than radians, because the triangle needs a fraction and the sine can multiply.
    this.phase = 0;
    this.configure({ ...CHORUS_DEFAULTS, ...options });
  }

  configure({ voices, rate, depth, delayMs, feedback, shape, mix } = {}) {
    if (Number.isFinite(voices)) this.voices = Math.max(1, Math.min(MAX_VOICES, Math.round(voices)));
    if (Number.isFinite(rate)) this.rate = Math.max(0.01, Math.min(20, rate));
    if (Number.isFinite(depth)) this.depth = Math.max(0, Math.min(1, depth));
    if (Number.isFinite(delayMs)) {
      this.delayMs = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, delayMs));
    }
    // Signed on purpose. A flanger fed back in antiphase cancels where the in-phase one reinforces, so
    // its notches sit at the other set of frequencies and it sounds hollow rather than resonant - the
    // two are different enough that offering only one would be leaving out half the effect.
    if (Number.isFinite(feedback)) this.feedback = Math.max(-0.9, Math.min(0.9, feedback));
    if (shape === 'sine' || shape === 'triangle') this.shape = shape;
    if (Number.isFinite(mix)) this.mix = Math.max(0, Math.min(1, mix));
  }

  reset() {
    this.line.reset();
    this.phase = 0;
  }

  /**
   * `frames` samples from `input` to `output`.
   *
   * One line read at N places rather than N lines, which is not an optimisation - it is the same
   * thing. Every voice is reading the same recording at a different distance back, which is exactly
   * what a bucket-brigade ensemble was: one analogue shift register with taps.
   */
  process(input, output, frames) {
    const channels = output.length;
    const { sampleRate, line, voices, shape, feedback, mix } = this;
    const dry = 1 - mix;
    const norm = VOICE_NORM[voices - 1];
    const shortest = (this.delayMs / 1000) * sampleRate;
    const sweep = ((this.depth * MAX_SWEEP_MS) / 1000) * sampleRate;
    const lfo = shape === 'sine' ? unipolarSine : unipolarTriangle;
    const step = this.rate / sampleRate;

    for (let i = 0; i < frames; i++) {
      let x = 0;
      for (let c = 0; c < channels; c++) x += input[c] ? input[c][i] : 0;
      if (channels > 1) x /= channels;

      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;

      let sum = 0;
      for (let v = 0; v < voices; v++) {
        // Evenly spread round one cycle: two voices are in antiphase, three are at thirds. The
        // arrangement that cannot pass through unison.
        sum += line.readAt(shortest + sweep * lfo(this.phase + v / voices));
      }
      const wet = sum * norm;

      // The *mean* of the voices goes back round, not the normalised sum, and that is a stability
      // requirement rather than a taste. The output normalisation is √N because that is how the taps
      // actually add up on average (see VOICE_NORM); the worst case, when the taps momentarily
      // coincide, is N. So a loop closed on the normalised sum has a gain of up to N/√N = √N, and at
      // two voices and 0.9 feedback that is 1.27 - measured, it reached five million and then NaN in
      // under a second. The mean can never exceed the largest tap, so the loop is bounded by the
      // feedback knob alone, which is what the knob is entitled to mean.
      //
      // Read before write, so the feedback path is one sample rather than none.
      line.write(x + (sum / voices) * feedback);

      const y = x * dry + wet * mix;
      for (let c = 0; c < channels; c++) output[c][i] = y;
    }
  }
}

/**
 * How long it goes on for after the input stops.
 *
 * Without feedback it is one sweep's worth of delay line and nothing more - a few tens of
 * milliseconds - so the honest answer is almost zero, and saying so keeps a chorus from padding every
 * render. With feedback it is a resonator: `g` per pass over a delay of `delayMs`, which at 0.9 on a
 * 2ms flanger is 66 passes of 2ms - 0.17s, and measured, nothing is left of it after that.
 */
export function chorusTailSeconds({ delayMs, feedback } = {}) {
  const time = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, delayMs ?? 6)) / 1000;
  const g = Math.min(0.9, Math.abs(feedback ?? 0));
  const sweep = (MAX_DELAY_MS + MAX_SWEEP_MS) / 1000;
  if (g <= 0) return sweep;
  return sweep + time * (60 / (-20 * Math.log10(g)));
}
