// A tape delay, as arithmetic that runs without a browser.
//
// The browser has `DelayNode`, and for a plain echo it would do. What it cannot do is any of the four
// things that make a delay a *musical* effect rather than a repeat:
//
//   - **Filtered feedback.** A `DelayNode` fed back through a `BiquadFilterNode` is a real graph and
//     does work, but the loop then has a whole quantum of latency in it - Web Audio guarantees at
//     least 128 samples of delay round any cycle - so the shortest repeat you can have is 2.7ms and
//     the interval is not what you asked for. Here the loop is one sample.
//   - **Saturation in the loop.** There is no node for it that can sit inside a cycle for the same
//     reason.
//   - **A read position that moves.** `delayTime` is an AudioParam and can be automated, but the
//     interpolation is the implementation's business and unspecified; wow and flutter are entirely a
//     question of *how* the fraction between two samples is found. See delay-line.js.
//   - **A time change that glides.** Automating `delayTime` jumps the read pointer, which is a click.
//
// **Tempo sync lives outside this file.** What arrives here is a number of seconds, because a note
// division is a fact about a song and this is a signal processor - and because the same code then
// renders a file at whatever tempo the file was written at, with no second definition of what a
// dotted eighth is. See delay.js for the resolving.

import { DelayLine, LoopTone, softSaturate } from './delay-line.js';

export const DELAY_DEFAULTS = {
  timeSeconds: 0.45,
  feedback: 0.42,
  tone: 3600,
  lowCut: 220,
  wow: 0.3,
  saturate: 0.25,
  mix: 0.32,
};

/**
 * The longest repeat the buffer can hold.
 *
 * 3 seconds is a 1/4 at 20 BPM, which is the slowest tempo the app allows, and a 1/2 at 40. Beyond
 * that a synced division is clamped rather than honoured, which the summary shows: at 20 BPM a delay
 * set to 1/2 reads `1/2 3.00 s`, and 3 seconds is not a 1/2 there. The alternative is 12 seconds of
 * buffer - a whole note at 20 BPM - held by every instance for a case nobody has.
 *
 * One megabyte per instance at 48kHz as it stands, allocated once. The time knob moves the read
 * pointer within it, because allocating on the audio thread is a missed deadline waiting to happen.
 */
export const MAX_DELAY_SECONDS = 3;

/**
 * How fast the read distance travels to a new time: a time constant, and a speed limit.
 *
 * A delay whose time jumps is a click - the read pointer lands somewhere unrelated to where it was
 * and the waveform is discontinuous. Every hardware delay glides instead, because the mechanism
 * physically had to: a tape machine's capstan takes a moment to change speed, and what you hear
 * while it does is the pitch of everything already in the line sliding. That is a sound worth having
 * rather than an artefact to hide, and it is most of why dragging this knob is fun.
 *
 * The speed limit is not decoration, and finding out why is the reason this comment is long. An
 * exponential glide alone moves fastest at the start, in proportion to how far it has to go, and a
 * read *distance* that grows by more than one sample per sample is a read *position* travelling
 * backwards through the buffer - the tape running in reverse. At a 90ms time constant a jump from a
 * 1/16 to a 1/2 at 100 BPM (0.15s to 1.2s, so 50,400 samples) starts at **11.7 samples per sample**,
 * which is not a glide at all, it is a tenth of a second of the last two bars played backwards at
 * eleven times speed.
 *
 * So the rate is capped, which is also the physically honest thing - a capstan has a top speed. At
 * the cap the read distance grows at half a sample per sample, so the pitch of what is already in the
 * line falls an octave while it moves and rises a fifth going the other way, and the jump above
 * settles in 2.35 seconds. Ordinary knob drags never reach it: one step of the free-time slider at
 * 450ms is 2.4ms, which glides at 0.03 samples per sample - under half a semitone.
 */
const GLIDE_TAU_S = 0.09;
const MAX_GLIDE_RATE = 0.5;

/**
 * Wow and flutter, as two sines at rates that share no factor.
 *
 * The depths are declared in cents of pitch deviation rather than in milliseconds of sweep, because
 * cents is what you hear and milliseconds is not. For a read distance modulated as `D·sin(2πft)` the
 * instantaneous pitch ratio is `1 - D·2πf·cos(2πft)`, so the peak deviation in cents fixes D:
 * `D = (2^(c/1200) - 1) / (2πf)`. That is 1.34ms of sweep for the wow and 0.055ms - two and a half
 * samples at 48kHz - for the flutter, which is why a table of millisecond depths would have looked
 * like a mistake.
 *
 * Fixed depth in time rather than scaled by the delay length, which is a choice and not the only
 * defensible one. A tape machine's speed error is proportional, so a longer loop wobbles further in
 * milliseconds and the same amount in cents. Doing it that way makes the wow knob mean four times as
 * much on a whole note as on a 1/16, and what you want from it is a constant amount of character.
 *
 * Checked against the output rather than against the algebra, by demodulating a 500Hz tone that has
 * been through the line and differentiating its phase: at 100% the pitch swings ±12.3 cents, ±9.7 of
 * which is the wow on its own, and at 0% it reads ±0.00 - which is the part worth having a number for,
 * because a modulation that does not switch off is the way this kind of thing usually goes wrong.
 */
const WOW_HZ = 0.62;
const WOW_CENTS = 9;
const FLUTTER_HZ = 5.9;
const FLUTTER_CENTS = 3.5;

const centsToSweepSeconds = (cents, hz) => (2 ** (cents / 1200) - 1) / (2 * Math.PI * hz);
const WOW_SWEEP_S = centsToSweepSeconds(WOW_CENTS, WOW_HZ);
const FLUTTER_SWEEP_S = centsToSweepSeconds(FLUTTER_CENTS, FLUTTER_HZ);

/** Never shorter than this, so the modulation cannot drive the read into the four-point window. */
const MIN_DELAY_S = 0.002;

export class Delay {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.line = new DelayLine(Math.ceil(MAX_DELAY_SECONDS * sampleRate) + 8);
    this.tone = new LoopTone(sampleRate);
    this.glideCoef = 1 - Math.exp(-1 / (GLIDE_TAU_S * sampleRate));
    // Where the read actually is, as against where it has been asked to be. Starts *at* the target
    // rather than at zero, or the first note of a song would arrive on a glide up from nothing.
    this.distance = null;
    this.wowPhase = 0;
    this.flutterPhase = 0;
    this.configure({ ...DELAY_DEFAULTS, ...options });
  }

  configure({ timeSeconds, feedback, tone, lowCut, wow, saturate, mix } = {}) {
    if (Number.isFinite(timeSeconds)) {
      this.timeSeconds = Math.max(MIN_DELAY_S, Math.min(MAX_DELAY_SECONDS, timeSeconds));
    }
    if (Number.isFinite(feedback)) this.feedback = Math.max(0, Math.min(0.95, feedback));
    if (Number.isFinite(wow)) this.wow = Math.max(0, Math.min(1, wow));
    if (Number.isFinite(saturate)) this.saturate = Math.max(0, Math.min(1, saturate));
    if (Number.isFinite(mix)) this.mix = Math.max(0, Math.min(1, mix));
    if (Number.isFinite(tone) || Number.isFinite(lowCut)) {
      if (Number.isFinite(tone)) this.toneHz = tone;
      if (Number.isFinite(lowCut)) this.lowCutHz = lowCut;
      this.tone.configure(this.toneHz, this.lowCutHz);
    }
  }

  reset() {
    this.line.reset();
    this.tone.reset();
    this.distance = null;
    this.wowPhase = 0;
    this.flutterPhase = 0;
  }

  /**
   * `frames` samples from `input` to `output`, both arrays of channels.
   *
   * One delay line, fed by the sum of the channels, exactly like the compressor computes one gain
   * from the loudest of them: a delay line per channel with a shared feedback would be a stereo
   * effect and this chain is mono. Everything is written so that the day it is not, the loop is the
   * only thing to revisit.
   */
  process(input, output, frames) {
    const channels = output.length;
    const { sampleRate, line, tone, glideCoef, feedback, saturate, mix } = this;
    const dry = 1 - mix;
    const target = this.timeSeconds * sampleRate;
    if (this.distance === null) this.distance = target;

    const wowStep = (2 * Math.PI * WOW_HZ) / sampleRate;
    const flutterStep = (2 * Math.PI * FLUTTER_HZ) / sampleRate;
    const wowDepth = this.wow * WOW_SWEEP_S * sampleRate;
    const flutterDepth = this.wow * FLUTTER_SWEEP_S * sampleRate;
    const floor = MIN_DELAY_S * sampleRate;

    for (let i = 0; i < frames; i++) {
      let x = 0;
      for (let c = 0; c < channels; c++) x += input[c] ? input[c][i] : 0;
      if (channels > 1) x /= channels;

      const wanted = (target - this.distance) * glideCoef;
      this.distance += Math.max(-MAX_GLIDE_RATE, Math.min(MAX_GLIDE_RATE, wanted));
      this.wowPhase += wowStep;
      this.flutterPhase += flutterStep;
      const modulated = Math.max(
        floor,
        this.distance + wowDepth * Math.sin(this.wowPhase) + flutterDepth * Math.sin(this.flutterPhase),
      );

      // Read before write, so the shortest possible loop is one sample rather than none.
      const echo = line.readAt(modulated);
      // Filter and saturate on the way *back in*, not on the way out. It is the difference between a
      // delay whose repeats get darker and dirtier one after another - which is what a tape machine
      // does, because every repeat is another pass over the heads - and one where every repeat is
      // equally dark, which is what a filter on the output gives and sounds static by comparison.
      line.write(x + softSaturate(tone.process(echo) * feedback, saturate));

      const y = x * dry + echo * mix;
      for (let c = 0; c < channels; c++) output[c][i] = y;
    }
  }
}

/**
 * How long the repeats go on for, in seconds, from the feedback alone.
 *
 * Feedback `g` loses `-20·log10(g)` dB per repeat, so 60dB of it takes `60 / that` repeats. This
 * ignores the loop filters, which is deliberately the conservative direction - they are a further
 * loss, so the real tail is shorter than this says, and an over-estimate costs a render a little
 * trailing silence while an under-estimate cuts the repeats off, which nothing can put back.
 *
 * Measured against a 450ms delay with the default tone in circuit, fitting the per-repeat energy over
 * its -1 to -50dB span:
 *
 *   feedback     0.42     0.60     0.80     0.95
 *   claimed      4.03s    6.54s   14.38s   20.00s   (capped)
 *   real         2.76s    4.48s    8.73s   20.80s
 *
 * So the estimate is a third to a half generous below the cap, which is the safe direction, and at the
 * top of the knob the cap is what decides. Capped because the arithmetic does not stop being true up
 * there: 0.95 feedback on a whole note at 60 BPM is 263 repeats of four seconds, and a render that
 * honoured it would produce a twenty-three-minute file of a fading echo. With the tone knob wide open
 * the same 450ms delay at 0.95 really does ring for 46.8s and the cap truncates it - which is the trade
 * the number is: a tail nobody is waiting for, against a file nobody wants.
 */
const TAIL_CAP_S = 20;

export function delayTailSeconds(timeSeconds, feedback) {
  const time = Math.max(MIN_DELAY_S, Math.min(MAX_DELAY_SECONDS, timeSeconds || 0));
  const g = Math.max(0, Math.min(0.95, feedback || 0));
  if (g <= 0) return time;
  const repeats = 60 / (-20 * Math.log10(g));
  return Math.min(TAIL_CAP_S, time * (repeats + 1));
}
