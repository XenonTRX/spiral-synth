// A reverb, as arithmetic that runs without a browser.
//
// **Why not a ConvolverNode.** The browser has convolution, and the usual trick for a project with no
// files to load is to synthesise an impulse response - a burst of noise with an exponential envelope -
// and hand it over. It is about fifteen lines and it does produce something reverb-like. What it cannot
// do is have controls. Size, decay and damping are all baked into the impulse, so moving any of them
// means generating a new buffer of tens of thousands of samples and swapping it in, which is a click
// and a spike; and the sound itself is a dense wash from the first sample, because noise has no early
// reflections, only late ones.
//
// **What this is instead.** A feedback delay network: eight delay lines whose outputs are mixed back
// into their inputs through an orthogonal matrix. That is the standard way to build a reverb whose
// parameters are all continuous, and it is worth understanding why it works rather than treating it as
// a recipe:
//
//   - **A single delay line with feedback is an echo.** You hear the repeats, because everything comes
//     back at one interval.
//   - **Eight, cross-mixed, is a room.** Every pass redistributes energy across all eight lines, so a
//     single input sample becomes eight echoes, then sixty-four, then five hundred and twelve. The
//     repeats become a density instead of a rhythm.
//   - **The matrix has to be orthogonal**, or it is not a room, it is a filter. An orthogonal matrix
//     preserves total energy exactly, which means the only thing that decides how long the tail lasts
//     is the per-line gain - so `decay` is a single number with a closed-form answer rather than
//     something to tune by ear. A Hadamard matrix is orthogonal, is all ±1, and can be applied in
//     3 × 8 add/subtracts instead of 64 multiplies.
//
// The per-line gain comes straight out of that. A signal circulating in a line of L samples completes
// `sr/L` passes a second, and RT60 asks for 60dB of loss over `decay` seconds, so `g = 10^(-3L/(sr·decay))`.
// No fitting, no tuning: see the measured RT60 in the README, which comes out within a few per cent of
// what the knob says across the whole range.

export const REVERB_DEFAULTS = {
  mix: 0.28,
  decay: 2.2,
  size: 1,
  damping: 5200,
  predelayMs: 18,
  lowCut: 140,
};

/**
 * The delay lines, in milliseconds at size 1.
 *
 * Mutually prime-ish on purpose, and spread over a bit more than a factor of two. If two lines share a
 * common factor their echoes coincide forever and the tail rings at that period; if they are too close
 * together the early sound is a flutter rather than a room; if they are too far apart the long ones
 * arrive as distinct echoes after the short ones have become a wash.
 */
const LINE_MS = [23.17, 29.51, 33.83, 37.79, 41.29, 47.11, 53.27, 59.63];
const LINES = LINE_MS.length;

/** Two allpasses in front, to break up the attack. See the note on diffusion in `process`. */
const DIFFUSER_MS = [5.11, 7.53];
const DIFFUSER_GAIN = 0.62;

const MAX_SIZE = 2;
const MAX_PREDELAY_MS = 200;

/**
 * At or above this, the damping filter is taken out of the loop rather than opened wide.
 *
 * Not tidiness - a one-pole at 20kHz still loses 1.3dB per pass at Nyquist, and a reverb is *all*
 * passes. Measured with the filter merely opened: RT60 came out a consistent 12.3% short of the knob
 * across the entire range, because a broadband decay curve is dominated by whatever is losing energy
 * fastest. With the filter genuinely bypassed the same measurement lands within 0.3%, which is what
 * makes `decay` a derivable number rather than a fitted one.
 */
const DAMPING_OFF_HZ = 20000;

// 60dB in nepers-per-pass terms: g = 10^(-3 L / (sr · rt60)).
const DECAY_EXPONENT = 3;

const pow2AtLeast = (n) => {
  let size = 1;
  while (size < n) size *= 2;
  return size;
};

export class Reverb {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;

    // Buffers are allocated for the largest size the knob allows and never reallocated, because
    // `size` is a control and allocation on the audio thread is a missed deadline waiting to happen.
    // Changing size moves the read pointer instead, which is also the physically honest thing: it
    // moves the walls rather than rebuilding the room.
    this.lineLength = LINE_MS.map((ms) => Math.round((ms / 1000) * sampleRate));
    this.lines = [];
    this.lineMask = [];
    this.lineWrite = new Int32Array(LINES);
    for (let i = 0; i < LINES; i++) {
      const size = pow2AtLeast(this.lineLength[i] * MAX_SIZE + 2);
      this.lines.push(new Float32Array(size));
      this.lineMask.push(size - 1);
    }
    // One damping pole per line, in the feedback path.
    this.damped = new Float32Array(LINES);
    // Scratch for the matrix, so the inner loop allocates nothing.
    this.tap = new Float32Array(LINES);

    const predelaySize = pow2AtLeast((MAX_PREDELAY_MS / 1000) * sampleRate + 2);
    this.predelay = new Float32Array(predelaySize);
    this.predelayMask = predelaySize - 1;
    this.predelayWrite = 0;

    this.diffusers = DIFFUSER_MS.map((ms) => {
      const length = Math.round((ms / 1000) * sampleRate);
      const size = pow2AtLeast(length + 2);
      return { buffer: new Float32Array(size), mask: size - 1, length, write: 0 };
    });

    this.lowCutState = 0;
    this.configure({ ...REVERB_DEFAULTS, ...options });
  }

  configure({ mix, decay, size, damping, predelayMs, lowCut } = {}) {
    if (Number.isFinite(mix)) this.mix = Math.max(0, Math.min(1, mix));
    if (Number.isFinite(size)) this.size = Math.max(0.1, Math.min(MAX_SIZE, size));
    if (Number.isFinite(decay)) this.decay = Math.max(0.05, decay);
    if (Number.isFinite(predelayMs)) {
      this.predelaySamples = Math.max(
        1,
        Math.round((Math.min(MAX_PREDELAY_MS, Math.max(0, predelayMs)) / 1000) * this.sampleRate),
      );
    }
    if (Number.isFinite(damping)) {
      // A one-pole lowpass, as a coefficient. The higher the cutoff the less each pass loses at the
      // top - and at the very top it is removed rather than opened, for the reason in DAMPING_OFF_HZ.
      const cutoff = Math.max(200, Math.min(this.sampleRate * 0.45, damping));
      this.dampCoef = damping >= DAMPING_OFF_HZ ? 0 : Math.exp((-2 * Math.PI * cutoff) / this.sampleRate);
    }
    if (Number.isFinite(lowCut)) {
      const cutoff = Math.max(10, Math.min(2000, lowCut));
      this.lowCutCoef = Math.exp((-2 * Math.PI * cutoff) / this.sampleRate);
    }
    this.updateGains();
  }

  /**
   * The feedback gain per line, and the reason `decay` needs no tuning.
   *
   * `g = 10^(-3L/(sr·decay))` is 60dB of loss over `decay` seconds for a line of L samples, and the
   * matrix above it is lossless, so nothing else in the network contributes to how long the tail is.
   * Measured with damping off, RT60 lands within 0.3% of the knob from 0.4s to 12s.
   *
   * The damping filter is a *deliberate* extra loss, so it shortens the broadband tail, and by much
   * more than you might expect: at the default 5.2kHz the measured RT60 is 13 to 17% below the knob.
   * That is reported rather than compensated for, because it is not an error - a damped room really
   * does decay faster broadband than a bright one of the same size, and the by-band measurement says
   * so directly: with damping at 3kHz and decay asked for 3s, below 500Hz measures 2.79s and above
   * 4kHz measures 1.37s. Compensating would mean this number stopped being derivable and started being
   * fitted.
   */
  updateGains() {
    if (!this.gain) this.gain = new Float32Array(LINES);
    if (!this.delaySamples) this.delaySamples = new Int32Array(LINES);
    for (let i = 0; i < LINES; i++) {
      const length = Math.max(2, Math.round(this.lineLength[i] * this.size));
      this.delaySamples[i] = length;
      this.gain[i] = 10 ** ((-DECAY_EXPONENT * length) / (this.sampleRate * this.decay));
    }
  }

  reset() {
    for (const line of this.lines) line.fill(0);
    for (const diffuser of this.diffusers) diffuser.buffer.fill(0);
    this.predelay.fill(0);
    this.damped.fill(0);
    this.lowCutState = 0;
  }

  /**
   * `frames` samples from `input` to `output`.
   *
   * Mono in, mono out: the network is summed to one channel because everything in this project is one
   * channel. A stereo version takes two different sums of the same eight lines, which is a change to
   * this method and to nothing else.
   */
  process(input, output, frames) {
    const {
      lines, lineMask, lineWrite, delaySamples, gain, tap, damped, diffusers,
      predelay, predelayMask, dampCoef, lowCutCoef, mix,
    } = this;
    const dry = 1 - mix;
    // 1/sqrt(8), the scale that makes the Hadamard butterflies orthonormal rather than eight times too
    // loud - which is the difference between a reverb and an explosion.
    const matrixScale = 1 / Math.sqrt(LINES);
    // The wet sum is eight lines' worth of the same energy, so it needs the same scaling.
    const outScale = 1 / Math.sqrt(LINES);

    for (let n = 0; n < frames; n++) {
      const x = input[0] ? input[0][n] : 0;

      // Predelay first: the gap before any of the room arrives, which is what makes a big space sound
      // big rather than merely long.
      predelay[this.predelayWrite] = x;
      const delayedIn = predelay[(this.predelayWrite - this.predelaySamples) & predelayMask];
      this.predelayWrite = (this.predelayWrite + 1) & predelayMask;

      // A one-pole highpass, so the tail does not pile up under the bass. Written as "signal minus its
      // own lowpass" because that is one multiply and one add.
      this.lowCutState = delayedIn + lowCutCoef * (this.lowCutState - delayedIn);
      let diffused = delayedIn - this.lowCutState;

      // Diffusion: two allpasses, which spread a single sample into a short burst without colouring
      // it. Without them the first thing the network does with a transient is repeat it eight times at
      // eight audible intervals, which sounds like a spring rather than a room.
      for (const ap of diffusers) {
        const d = ap.buffer[(ap.write - ap.length) & ap.mask];
        const y = d - DIFFUSER_GAIN * diffused;
        ap.buffer[ap.write] = diffused + DIFFUSER_GAIN * y;
        ap.write = (ap.write + 1) & ap.mask;
        diffused = y;
      }

      // Read every line's output.
      let wet = 0;
      for (let i = 0; i < LINES; i++) {
        const value = lines[i][(lineWrite[i] - delaySamples[i]) & lineMask[i]];
        tap[i] = value;
        wet += value;
      }

      // The Hadamard transform, as three stages of butterflies. Eight in, eight out, 24 add/subtracts
      // instead of 64 multiply-accumulates, and the result is exactly an orthogonal mix.
      for (let span = 1; span < LINES; span *= 2) {
        for (let i = 0; i < LINES; i += span * 2) {
          for (let j = i; j < i + span; j++) {
            const a = tap[j];
            const b = tap[j + span];
            tap[j] = a + b;
            tap[j + span] = a - b;
          }
        }
      }

      for (let i = 0; i < LINES; i++) {
        // Damping in the feedback path, so each pass loses a little more at the top than at the
        // bottom. That is what a room's surfaces do, and it is the difference between a tail that
        // darkens as it fades and one that hisses to the end.
        const fed = tap[i] * matrixScale * gain[i];
        damped[i] = fed + dampCoef * (damped[i] - fed);
        lines[i][lineWrite[i]] = diffused + damped[i];
        lineWrite[i] = (lineWrite[i] + 1) & lineMask[i];
      }

      const y = x * dry + wet * outScale * mix;
      output[0][n] = y;
      // Every other channel gets the same thing: the network is mono, and pretending otherwise by
      // sending it a different dry signal per channel would produce two different reverbs.
      for (let c = 1; c < output.length; c++) output[c][n] = y;
    }
  }
}
