// A ring buffer you can read from at a fractional distance back.
//
// The reverb already has delay lines, and does not use this, which is worth saying so that the
// duplication reads as a decision rather than an oversight. A reverb's lines are *fixed*: their
// lengths are chosen once, read at whole samples, and the only thing that ever moves is a scale
// factor. The two effects here are the opposite - a chorus is nothing but a delay whose length is
// moving, and a tape delay's wow is the same idea with a slower hand - so the read distance is a
// fraction that changes every sample, and how you get the sample *between* two samples becomes the
// whole quality of the effect.
//
// **Why cubic and not linear.** Linear interpolation between two neighbours is a two-tap averaging
// filter whose response depends on the fraction: at a whole sample it is flat, and at exactly halfway
// it is a lowpass losing 0.075dB at 2kHz, 1.25dB at 8kHz and 6dB at Nyquist. On a *moving* read that
// is not a fixed dullness you could dial back in - it is a brightness that opens and closes twice per
// LFO cycle, which is a tremolo on the top octave at the modulation rate. Cubic's error at the same
// half sample is 0.001dB at 2kHz and 0.23dB at 8kHz.
//
// Both claims are measured against an answer that needs no reference implementation, which is the
// nice thing about this particular problem: reading an ideal signal at a distance of d(t) is exactly
// x(t - d(t)), so for a sine the correct output is a sine and the error is a real number rather than
// a comparison. Swept the way the chorus sweeps it - 8ms ± 2ms at 0.6Hz - the error against that
// closed form comes out:
//
//       110Hz    440Hz     1kHz     2kHz     4kHz     8kHz
//   linear    -94dB    -71dB    -56dB    -44dB    -32dB    -20dB
//   cubic    -148dB   -113dB    -92dB    -73dB    -54dB    -34dB
//
// About 22dB of it across the board, and more where most of a pad's energy actually is. What it
// sounds like is that the cubic one is detuning and the linear one is detuning with a tremolo on it.
//
// Catmull-Rom rather than a Lagrange or a Thiran allpass. It is the cheapest thing that is
// continuous in its first derivative, which is the property that matters here: the interpolator is
// being asked for a smoothly changing position, and a scheme with a kink at each sample boundary
// puts that kink into the output at whatever rate the read is crossing boundaries.

const pow2AtLeast = (n) => {
  let size = 1;
  while (size < n) size *= 2;
  return size;
};

/** The shortest read a four-point interpolator can serve: it needs one sample on the near side. */
export const MIN_DELAY_SAMPLES = 1;

export class DelayLine {
  constructor(maxDelaySamples) {
    // Three of headroom: the interpolator reaches one sample nearer and two further than the integer
    // part of the distance asked for, and a power of two so the wrap is a mask rather than a branch.
    const size = pow2AtLeast(Math.max(4, Math.ceil(maxDelaySamples) + 3));
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
    this.writeIndex = 0;
    this.maxDelay = size - 3;
  }

  write(x) {
    this.buffer[this.writeIndex] = x;
    this.writeIndex = (this.writeIndex + 1) & this.mask;
  }

  /**
   * The signal as it was `delaySamples` ago, which may be a fraction.
   *
   * Read *before* the matching `write` and the newest sample in the buffer is one behind the write
   * pointer, so a distance of 1 is the sample just written on the previous call. Both callers do it
   * in that order - read, then write - because a delay whose feedback path reads what it wrote in
   * the same sample is a zero-delay loop.
   */
  readAt(delaySamples) {
    const distance = Math.min(this.maxDelay, Math.max(MIN_DELAY_SAMPLES, delaySamples));
    const whole = Math.floor(distance);
    const f = distance - whole;
    const { buffer, mask } = this;
    // The four taps, in order of increasing distance back. Catmull-Rom does not care which way the
    // axis runs - it is interpolation on an even grid - so indexing by distance is as valid as
    // indexing by time, and this way the arithmetic matches the argument.
    const base = this.writeIndex - whole;
    const a = buffer[(base + 1) & mask];
    const b = buffer[base & mask];
    const c = buffer[(base - 1) & mask];
    const d = buffer[(base - 2) & mask];
    return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
  }

  reset() {
    this.buffer.fill(0);
    this.writeIndex = 0;
  }
}

/**
 * A one-pole lowpass and a one-pole highpass, as one object, for use inside a feedback loop.
 *
 * Both of the effects here need exactly this and nothing more. A biquad would be sharper and is the
 * wrong tool: inside a feedback path the filter is applied once per repeat, so a gentle 6dB slope
 * applied twenty times is already a steep one, and the shape you hear is the shape of the *loop*
 * rather than of the filter. It is also the shape a bucket-brigade delay actually had.
 */
export class LoopTone {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.lowState = 0;
    this.highState = 0;
    this.lowCoef = 1;
    this.highCoef = 0;
  }

  /** `lowpassHz` at or above Nyquist takes the pole out of circuit rather than opening it wide. */
  configure(lowpassHz, highpassHz) {
    const nyquist = this.sampleRate * 0.5;
    this.lowCoef = lowpassHz >= nyquist ? 1 : 1 - Math.exp((-2 * Math.PI * lowpassHz) / this.sampleRate);
    this.highCoef = highpassHz <= 0 ? 0 : 1 - Math.exp((-2 * Math.PI * highpassHz) / this.sampleRate);
  }

  process(x) {
    this.lowState += (x - this.lowState) * this.lowCoef;
    let y = this.lowState;
    if (this.highCoef > 0) {
      this.highState += (y - this.highState) * this.highCoef;
      y -= this.highState;
    }
    return y;
  }

  reset() {
    this.lowState = 0;
    this.highState = 0;
  }
}

/**
 * Soft saturation for use inside a feedback loop: the identity at `amount` 0, and never a gain.
 *
 * Written as a blend towards `tanh(kx)/k` rather than as a shape with a drive knob, and both halves
 * of that were bought with a bug.
 *
 * **The blend** is because the knob has to be able to mean *nothing*. A shaper parameterised by k
 * tends to the identity as k→0, but not at any k a program actually uses, so its knob has a step at
 * the bottom of its range - which is the one place a user is entitled to expect the effect to be
 * gone. This is exact at 0.
 *
 * **The `/k`** is because the obvious normalisation is `/tanh(k)`, which makes full scale come out at
 * full scale and is right for a saturator in series. In a *loop* it is a disaster: dividing by
 * `tanh(2.2)` leaves a small-signal gain of 2.25, so a delay at 95% feedback had a loop gain of over
 * two and self-oscillated - measured, it sat at full scale thirty seconds after a 200ms burst and
 * would have stayed there until the effect was removed. Dividing by `k` instead makes the slope
 * through zero exactly 1 at every amount, so the shape can only ever take level away and the loop is
 * bounded by the feedback knob alone. The price is that hard saturation is also quiet - at amount 1 a
 * full-scale sample comes back as 0.44 - which is what a tape loop being driven hard actually does.
 */
const SATURATION_K = 2.2;

export function softSaturate(x, amount) {
  if (amount <= 0) return x;
  return x + amount * (Math.tanh(SATURATION_K * x) / SATURATION_K - x);
}
