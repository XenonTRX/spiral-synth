// A lookahead peak limiter, written as arithmetic that can run without a browser.
//
// Two things belong on the end of a mix bus: the level you happen to be listening at, and a
// guarantee that nothing leaves above full scale. This is the second one, and until now the bus did
// not have it. What it had was a `DynamicsCompressor` built with its defaults, which is neither: a
// -24dB threshold at 12:1 is a heavy broadband compressor, so it squashed the whole mix, and its
// 3ms attack meant the peaks it was nominally there to stop went through anyway.
//
// That was measured rather than assumed, twice, and both measurements are the reason this file
// exists. The demo song rendered at 1.221 through the compressor and this project's own song at
// 1.116 with 76 samples over full scale, which the 16-bit encoder then has to flatten. And setting
// the compressor like a limiter does not fix it: threshold at -4dB with a hard knee left the mix
// 0.5dB from where it started and took the clipped count from 341 to 808, because the low threshold
// had been holding peaks down as a *side effect* of squashing everything above it.
//
// A compressor cannot fix it at any setting, because it has no way to know a transient is coming.
// It sees a sample, decides a gain, and by the time its attack has moved the gain the peak is
// already out of the door. What a limiter has instead is **lookahead**: delay the audio, and choose
// the gain from audio the output has not reached yet. Then the gain is already down when the
// transient arrives. That is the whole idea, and it is why what follows is a delay line and a
// sliding minimum rather than a cleverer envelope follower.
//
// It lives here rather than in the processor for the reason src/wavetable.js does: a file with no
// Web Audio in it can be run in Node, and "nothing leaves above the ceiling" is exactly the kind of
// claim that has to be checked against numbers rather than ears. See the harness this was built
// with - the first version of it overshot by 0.35dB and the number said so before any audio existed.

export const LIMITER_DEFAULTS = {
  // -1dBFS rather than 0. A ceiling *at* full scale leaves nothing for the two things a sample-peak
  // limiter genuinely cannot see: the smoothing residue below, and inter-sample peaks - a waveform
  // reconstructed between two samples can be higher than either of them, which no amount of
  // arithmetic on the samples themselves will reveal. A dB of air covers both and costs a dB.
  ceilingDb: -1,
  // Long enough to smooth the gain, short enough to be inaudible as latency. 3ms is 132 samples at
  // 44.1kHz, and every sample of it is added to the monitoring round trip.
  lookaheadMs: 3,
  // How fast the gain comes back after a peak. Too fast and the level audibly breathes on every
  // kick; too slow and one loud transient ducks the following bar.
  releaseMs: 150,
  enabled: true,
};

/**
 * How many one-pole time constants of gain smoothing fit inside the lookahead window.
 *
 * The gain has exactly the lookahead to travel from where it is to where it has to be, and an
 * exponential never quite arrives, so this number is the whole accuracy story: at N time constants
 * the gain is `1 - e^-N` of the way there when the peak lands, and the rest of the way is overshoot.
 *
 * I expected this to be a trade and measured it as one. It is not much of a trade. A gain that moves
 * faster moves *within* a cycle of the waveform, which is distortion by definition, so a slow attack
 * should buy cleanliness with headroom - and against a 55Hz tone with transients over it, the bass
 * note's harmonics move by less than 1dB across the entire range from 2 taus to 24, while the peak
 * that gets through moves by 3.3dB. The dip in the gain is the thing that modulates the bass, and how
 * *smoothly* it is entered barely matters next to the fact of it. So this is set by the ceiling
 * alone: 8 taus lets 0.010dB past on a single-sample spike 12dB over the ceiling, and nothing
 * measurable past anything musical, while still slewing the gain over 0.37ms rather than stepping it.
 */
const ATTACK_TAUS = 8;

const pow2AtLeast = (n) => {
  let size = 1;
  while (size < n) size *= 2;
  return size;
};

/**
 * One limiter, one signal, however many channels.
 *
 * The gain is computed once from the loudest channel and applied to all of them, which is the only
 * option that does not move the stereo image: a per-channel gain turns a peak on the left into a
 * pan. Everything here is mono today and the arithmetic does not care.
 */
export class PeakLimiter {
  constructor(sampleRate, options = {}) {
    const opts = { ...LIMITER_DEFAULTS, ...options };
    this.sampleRate = sampleRate;

    // Fixed at construction, unlike the other three, because it is the node's latency: a limiter
    // that could change its lookahead while running would change how far behind the sound is, and
    // there is no way to do that without a gap or a repeat.
    this.lookahead = Math.max(1, Math.round((opts.lookaheadMs / 1000) * sampleRate));
    this.attackCoef = 1 - Math.exp(-ATTACK_TAUS / this.lookahead);

    // The sliding minimum, as a monotonic deque of indices into the gain the input asked for. It
    // holds at most one entry per sample in the window, and eviction happens before insertion, so
    // `window` slots is the bound rather than a guess.
    this.window = this.lookahead + 1;
    const dequeSize = pow2AtLeast(this.window);
    this.dequeMask = dequeSize - 1;
    this.dequeGain = new Float32Array(dequeSize);
    // Absolute sample indices, in doubles rather than Int32 so there is no overflow to explain: a
    // 32-bit counter wraps after thirteen hours of audio and the comparison below would invert.
    this.dequeIndex = new Float64Array(dequeSize);
    this.head = 0;
    this.count = 0;
    this.index = 0;

    const delaySize = pow2AtLeast(this.window);
    this.delayMask = delaySize - 1;
    this.delaySize = delaySize;
    this.delay = [];
    this.write = 0;

    this.gain = 1;
    this.configure(opts);
    this.resetMeter();
  }

  /** Latency, which the graph above has to be able to ask about even though nothing yet does. */
  get latencySeconds() {
    return this.lookahead / this.sampleRate;
  }

  configure({ ceilingDb, releaseMs, enabled } = {}) {
    if (Number.isFinite(ceilingDb)) this.ceiling = 10 ** (ceilingDb / 20);
    if (Number.isFinite(releaseMs)) {
      this.releaseCoef = 1 - Math.exp(-1000 / (Math.max(1, releaseMs) * this.sampleRate));
    }
    if (enabled !== undefined) this.enabled = enabled !== false;
  }

  channel(c) {
    let line = this.delay[c];
    if (!line) {
      line = new Float32Array(this.delaySize);
      this.delay[c] = line;
    }
    return line;
  }

  reset() {
    for (const line of this.delay) line?.fill(0);
    this.gain = 1;
    this.head = 0;
    this.count = 0;
    this.resetMeter();
  }

  resetMeter() {
    this.peakIn = 0;
    this.peakOut = 0;
    this.gainFloor = 1;
    this.clipped = 0;
    this.sumSquares = 0;
    this.meterFrames = 0;
  }

  /**
   * What the meter has seen since it was last asked, and a clean slate.
   *
   * Extremes rather than instantaneous values, so nothing can happen between two reads and go
   * unseen - which for a peak is the entire point of reading it. `rms` is the exception and is an
   * average by definition; over a 23ms window it is a fast one, and the display integrates further.
   */
  readMeter() {
    const report = {
      peakIn: this.peakIn,
      peakOut: this.peakOut,
      rms: this.meterFrames > 0 ? Math.sqrt(this.sumSquares / this.meterFrames) : 0,
      gainFloor: this.gainFloor,
      clipped: this.clipped,
    };
    this.resetMeter();
    return report;
  }

  /**
   * The minimum gain asked for anywhere in the lookahead window ending at this sample.
   *
   * A plain envelope follower would be shorter and wrong: it would start moving when the peak
   * arrives, and the output is at that point already `lookahead` samples behind, so it would react
   * to a transient the listener heard three milliseconds ago. Taking the *minimum over the window*
   * means the gain starts falling the moment a peak enters the window, which is exactly the moment
   * it becomes possible to know about, and the smoothing below then has the whole window to arrive.
   *
   * A monotonic deque rather than a scan of the window, because the scan is O(lookahead) per sample
   * - 132 comparisons per sample at 3ms, on a thread with 2.9ms to fill 128 samples. This is O(1)
   * amortised: a value that is not smaller than something already waiting can never be the minimum
   * before that thing expires, so it is dropped on arrival and the deque stays short.
   */
  slidingMin(asked) {
    const { dequeGain, dequeIndex, dequeMask } = this;
    let count = this.count;
    let head = this.head;

    // Off the back of the window first, so the bound below is `window` and not `window + 1`.
    const oldest = this.index - this.window + 1;
    while (count > 0 && dequeIndex[head] < oldest) {
      head = (head + 1) & dequeMask;
      count--;
    }
    while (count > 0 && dequeGain[(head + count - 1) & dequeMask] >= asked) count--;

    const slot = (head + count) & dequeMask;
    dequeGain[slot] = asked;
    dequeIndex[slot] = this.index;
    count++;

    this.head = head;
    this.count = count;
    this.index++;
    return dequeGain[head];
  }

  /**
   * `frames` samples from `input` to `output`, both arrays of channels, in place-safe order.
   *
   * `input` may be shorter than `output` - a Web Audio node with nothing connected is handed an
   * empty input - and it still has to run, because the delay line is holding the last few
   * milliseconds of the song and silence is how it gets flushed out.
   */
  process(input, output, frames) {
    const channels = output.length;
    const { delayMask, ceiling } = this;

    for (let i = 0; i < frames; i++) {
      let asked = 1;
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const x = input[c] ? input[c][i] : 0;
        this.channel(c)[this.write] = x;
        const magnitude = x < 0 ? -x : x;
        if (magnitude > peak) peak = magnitude;
      }
      if (peak > ceiling) asked = ceiling / peak;
      if (peak > this.peakIn) this.peakIn = peak;

      const target = this.slidingMin(asked);
      // Down fast enough to be in place before the peak lands, back slowly. Which of the two this
      // is, is decided by direction rather than by state, so there is no attack/release mode to get
      // stuck in - the classic bug in a hand-written follower.
      this.gain += (target - this.gain) * (target < this.gain ? this.attackCoef : this.releaseCoef);
      if (this.gain < this.gainFloor) this.gainFloor = this.gain;

      const read = (this.write - this.lookahead) & delayMask;
      // Bypass keeps the delay and drops only the gain, so switching it is a level change and never
      // a jump in time - which is what makes it usable as an A/B rather than as a rewiring.
      const applied = this.enabled ? this.gain : 1;
      for (let c = 0; c < channels; c++) {
        const y = this.channel(c)[read] * applied;
        output[c][i] = y;
        const magnitude = y < 0 ? -y : y;
        if (magnitude > this.peakOut) this.peakOut = magnitude;
        if (magnitude > 1) this.clipped++;
        this.sumSquares += y * y;
      }
      this.meterFrames += channels;
      this.write = (this.write + 1) & delayMask;
    }
  }
}
