// How fast the song goes, in one place.
//
// This was a `let` in main.js, read everywhere through a `getBpm` closure that main.js handed to
// whoever asked. That worked for a year of features because everything that needed the tempo was
// *constructed* by main.js and could be given it. A tempo-synced delay is the first thing that is
// not: an effect is built by the chain, which is built by the instrument pool, which is built by
// whichever of the two audio contexts is asking - none of which has any business knowing about a
// transport, and none of which could be handed a getter without three layers of plumbing whose only
// cargo is one number.
//
// So the number moves here and the plumbing stays exactly as it was: main.js still owns the input
// box and still passes `getBpm` to the roll, the transport and the exporter. What changed is that
// the value it passes now lives somewhere an effect can also reach.
//
// **Quarter notes per minute, always.** The rest of the app measures time in whole notes - see
// `secondsForBeats`, whose `beats` argument is wholes - and the meter can make a bar anything it
// likes. BPM is the one figure that must not move when either of those does, so it is defined
// against the quarter and stays there in 6/8 as much as in 4/4. meter.js's `pulseLabel` is what
// translates it into whatever the bar happens to divide into.

const MIN_BPM = 20;
const MAX_BPM = 300;

let bpm = 100;

export function getBpm() {
  return bpm;
}

export const MIN_BPM_ALLOWED = MIN_BPM;
export const MAX_BPM_ALLOWED = MAX_BPM;

/**
 * Tapping a tempo in, which is the oldest and still the most reliable way to find one.
 *
 * No DOM and no audio - it takes timestamps and gives back a tempo, so the button that calls it can
 * live wherever the tempo is displayed and the arithmetic only exists once. It is also the honest
 * counterweight to the beat detector: tapping cannot make an octave error, cannot be confused by a
 * shuffle, and works on a rubato performance where nothing automatic will.
 *
 * The estimate is a **least-squares fit of tap time against tap index**, not an average of the gaps.
 * The reason is not obvious and is worth stating, because averaging the gaps looks like the same
 * thing: it telescopes to `(last - first) / (n - 1)`, so it depends on the first and last tap and on
 * nothing in between. A tap that lands late in the *middle* costs both methods nothing - it lengthens
 * one gap and shortens the next. A late tap at either *end* costs the average about half as much
 * again as it costs the fit. Measured on nine taps at 128: a last tap 60ms late reads 125.98 by
 * average of gaps and 126.92 by fit, and the last tap is the one you have only just made and are
 * least likely to have placed well.
 *
 * Only the last few taps are kept, so a series that has been running for a while can still be pulled
 * to a new tempo instead of being anchored by a minute of history.
 *
 * A gap longer than `timeoutMs` starts a new series rather than extending the old one, because a
 * pause means you stopped, and folding the pause in would report about half the tempo.
 */
export function createTapper({ timeoutMs = 2200, keep = 12 } = {}) {
  let taps = [];

  return {
    /** The tempo the taps so far imply, or null while there is only one of them. */
    tap(at = performance.now()) {
      if (taps.length && at - taps[taps.length - 1] > timeoutMs) taps = [];
      taps.push(at);
      if (taps.length > keep) taps.shift();
      if (taps.length < 2) return null;

      const n = taps.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        sx += i;
        sy += taps[i];
        sxx += i * i;
        sxy += i * taps[i];
      }
      const denominator = n * sxx - sx * sx;
      if (!(denominator > 0)) return null;
      const interval = (n * sxy - sx * sy) / denominator;
      if (!(interval > 0)) return null;
      return { bpm: 60000 / interval, taps: n };
    },
    reset() {
      taps = [];
    },
    count: () => taps.length,
    /** Whether a series is still open, so a control can say it is listening. */
    isLive: (at = performance.now()) => taps.length > 0 && at - taps[taps.length - 1] <= timeoutMs,
  };
}

/** Ignores anything that is not a usable tempo, and answers whether it took it. */
export function setBpm(value) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < MIN_BPM || next > MAX_BPM) return false;
  bpm = next;
  return true;
}

/**
 * A note division in whole notes: `'1/8.'` is 0.1875.
 *
 * Parsed rather than tabulated because the table would then exist twice - once here and once in
 * whichever effect offers the choices - and the two would drift the first time anything gained a
 * 1/32. The suffixes are the standard two: `.` is dotted (one and a half), `t` is a triplet (two
 * thirds).
 */
export function divisionWholes(division) {
  const match = /^1\/(\d+)([.t]?)$/.exec(String(division ?? ''));
  if (!match) return null;
  const denominator = Number(match[1]);
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const base = 1 / denominator;
  if (match[2] === '.') return base * 1.5;
  if (match[2] === 't') return (base * 2) / 3;
  return base;
}

/** And what that division lasts at the current tempo. `secondsForBeats` in music-theory.js, for one note. */
export function divisionSeconds(division, atBpm = bpm) {
  const wholes = divisionWholes(division);
  return wholes === null ? null : (wholes * 4 * 60) / atBpm;
}
