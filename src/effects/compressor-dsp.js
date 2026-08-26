// A compressor, as arithmetic that runs without a browser.
//
// The browser has one - `DynamicsCompressor` - and this project has already been round that houses:
// see the mix bus, where it was replaced because it has no lookahead and could not be a limiter at any
// setting. As an *insert* compressor it is much more defensible; what it cannot do is say how much
// gain it is removing in a way anything can act on, offer makeup gain, offer a dry/wet mix for
// parallel compression, or be measured against its own declared numbers. All four of those are the
// reason this is written out instead.
//
// The topology is the ordinary modern one, and worth naming because the alternatives sound different:
// a **feed-forward** design that computes a gain from the input and smooths *the gain* rather than the
// level. Smoothing the level first and then computing a gain from the smoothed level - the older
// arrangement - puts the attack and release inside the detector, where a soft knee then distorts them,
// and makes the two controls interact with the ratio. Here they mean what they say.
//
// The whole file is one class with no imports so it can be run in Node, which is the only way the
// claims below - "the slope above the threshold is one over the ratio", "the attack is the time it
// says" - are anything more than assertions. See the harness in the README.

export const COMPRESSOR_DEFAULTS = {
  thresholdDb: -18,
  ratio: 4,
  kneeDb: 6,
  attackMs: 10,
  releaseMs: 120,
  makeupDb: 0,
  mix: 1,
};

// Silence in dB has to be a number rather than -Infinity, because the gain computer does arithmetic
// on it. -160dB is far below anything a 16-bit file can hold and far below where the knee reaches.
const FLOOR_DB = -160;

const LOG10_20 = 20 / Math.LN10;

export class Compressor {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.reductionDb = 0;
    this.configure({ ...COMPRESSOR_DEFAULTS, ...options });
    this.resetMeter();
  }

  /**
   * Attack and release are one time constant each, not a 10-to-90 time.
   *
   * Worth stating because the two conventions differ by a factor of more than two and every
   * manufacturer picks one silently. One time constant is 63% of the way, so ten to ninety per cent is
   * ln(9) of them - a 10ms attack here covers that span in 22.0ms, measured against a steady level.
   *
   * Against a *sine* it measures nearly twice that, and the difference is the compressor working
   * rather than a discrepancy: the detector sees |x|, which falls to zero twice a cycle, so the gain
   * spends most of every cycle releasing and only the peaks pulling it down. That is also why the
   * static curve below sits above its ideal at slow attacks.
   */
  configure({ thresholdDb, ratio, kneeDb, attackMs, releaseMs, makeupDb, mix } = {}) {
    if (Number.isFinite(thresholdDb)) this.thresholdDb = thresholdDb;
    if (Number.isFinite(ratio)) this.ratio = Math.max(1, ratio);
    if (Number.isFinite(kneeDb)) this.kneeDb = Math.max(0, kneeDb);
    if (Number.isFinite(attackMs)) {
      this.attackCoef = 1 - Math.exp(-1000 / (Math.max(0.05, attackMs) * this.sampleRate));
    }
    if (Number.isFinite(releaseMs)) {
      this.releaseCoef = 1 - Math.exp(-1000 / (Math.max(1, releaseMs) * this.sampleRate));
    }
    if (Number.isFinite(makeupDb)) this.makeup = 10 ** (makeupDb / 20);
    if (Number.isFinite(mix)) this.mix = Math.max(0, Math.min(1, mix));
  }

  /**
   * How much gain to remove at this input level, in dB, before any smoothing. Never positive.
   *
   * The knee is the standard quadratic interpolation, and the reason to have one at all is that a
   * hard knee is a discontinuity in the *derivative* of the curve: a signal hovering at the threshold
   * crosses between "untouched" and "compressed at 4:1" every cycle, which is audible as a grainy
   * edge on exactly the material that sits at the threshold. The quadratic makes the slope continuous
   * so there is nothing to cross.
   */
  reductionFor(levelDb) {
    const over = levelDb - this.thresholdDb;
    const slope = 1 / this.ratio - 1;
    if (this.kneeDb > 0 && 2 * Math.abs(over) <= this.kneeDb) {
      const into = over + this.kneeDb / 2;
      return (slope * into * into) / (2 * this.kneeDb);
    }
    return over > 0 ? slope * over : 0;
  }

  resetMeter() {
    this.peakIn = 0;
    this.peakOut = 0;
    this.gainFloor = 1;
  }

  readMeter() {
    const report = { peakIn: this.peakIn, peakOut: this.peakOut, gainFloor: this.gainFloor };
    this.resetMeter();
    return report;
  }

  reset() {
    this.reductionDb = 0;
    this.resetMeter();
  }

  /**
   * `frames` samples from `input` to `output`, both arrays of channels.
   *
   * One gain across every channel, computed from the loudest of them, because a per-channel gain turns
   * a peak on the left into a pan. Everything here is mono today and the arithmetic does not care.
   */
  process(input, output, frames) {
    const channels = output.length;
    const { attackCoef, releaseCoef, makeup, mix } = this;
    const dry = 1 - mix;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const x = input[c] ? input[c][i] : 0;
        const magnitude = x < 0 ? -x : x;
        if (magnitude > peak) peak = magnitude;
      }
      if (peak > this.peakIn) this.peakIn = peak;

      const levelDb = peak > 0 ? LOG10_20 * Math.log(peak) : FLOOR_DB;
      const wanted = this.reductionFor(levelDb);
      // Which of the two coefficients applies is decided by direction rather than by a stored mode, so
      // there is no state machine to get stuck in - the classic bug in a hand-written follower.
      const coefficient = wanted < this.reductionDb ? attackCoef : releaseCoef;
      this.reductionDb += (wanted - this.reductionDb) * coefficient;

      const gain = 10 ** (this.reductionDb / 20);
      if (gain < this.gainFloor) this.gainFloor = gain;
      // The mix belongs here, on the wet path, and leaving it off was a real bug rather than a typo
      // worth hiding: `dry + gain * makeup` is not a crossfade, it is the dry signal with a compressed
      // copy added on top at full strength. At mix 0 - which is supposed to be "no effect at all" -
      // it measured 0.67 away from the input on a full-scale tone, so the one setting that must be
      // transparent was the loudest thing in the file.
      const wet = gain * makeup * mix;

      for (let c = 0; c < channels; c++) {
        const x = input[c] ? input[c][i] : 0;
        // Parallel compression when mix is below 1: the makeup belongs to the wet path only, which is
        // what makes turning it up bring the compressed copy *into* the dry one rather than raising
        // both together.
        const y = x * (dry + wet);
        output[c][i] = y;
        const magnitude = y < 0 ? -y : y;
        if (magnitude > this.peakOut) this.peakOut = magnitude;
      }
    }
  }
}
