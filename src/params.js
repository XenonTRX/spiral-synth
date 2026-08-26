// What a knob is, on its own, with nothing that knows about instruments.
//
// These lived in instruments.js and were moved out for one reason: modulation.js declares knobs too
// (an LFO has a rate and a shape), and instruments.js needs modulation.js to read a saved routing
// matrix. Left as they were that is a circular import. It would in fact have *worked* - function
// declarations are hoisted before any module body runs, so the cycle resolves - and that is exactly
// the kind of thing that works until someone changes a `function` to a `const` and spends an evening
// on it. The one import below is decibels.js, which imports nothing itself, so this file still cannot
// be part of a cycle - which was the whole point of moving it here.

import { dbLabel, gainToDb } from './decibels.js';

/**
 * Describe one knob.
 *
 * `min`/`max` are what the value is *allowed* to be, and the control covers all of it. The old
 * split - a slider showing a comfortable range while the clamp allowed a wider one - is what
 * `scale` replaces: a frequency gets a logarithmic control, so the full legal span fits under
 * the thumb and still feels right, because that is how the ear reads frequency. A linear cutoff
 * slider spends four fifths of its travel in a range you cannot hear it moving through.
 *
 * `mod` names the unit a modulation *depth* aimed at this knob is measured in - see MOD_UNITS in
 * modulation.js. A knob without it is not a destination.
 *
 * `activeWhen(state)` says when this knob does anything, and exists because several of them genuinely
 * do not. A filter's Gain is ignored by every shape except a shelf and a peak; a delay's Milliseconds
 * is ignored whenever it is synced to a division. Both were sliders that moved and changed nothing,
 * which is worse than a missing control - a missing control tells you where you are, and a dead one
 * tells you the effect is broken. A knob with no `activeWhen` is always active.
 */
export function numberParam({ key, label, min, max, step, def, scale = 'linear', format, help, mod, activeWhen }) {
  return { kind: 'number', key, label, min, max, step, def, scale, format, help, mod, activeWhen };
}

export function choiceParam({ key, label, choices, def, help, activeWhen }) {
  return { kind: 'choice', key, label, choices, def, help, activeWhen };
}

/**
 * How loud a part is - the one knob every instrument has, declared once so it means one thing.
 *
 * It used to be five separate declarations that happened to look alike, all reading `def: 0.8`, and
 * they meant five different loudnesses. Measured, one note at Level 100% peaked at +3.3dBFS on the
 * subtractive synth and -23.9dBFS on the wavetable: a spread of **27dB** behind identical labels, so
 * switching a part's instrument moved it by up to that much and a mix balanced by the numbers was
 * balanced by nothing. Each instrument now carries a measured `OUTPUT_TRIM` that puts one note at
 * full scale when this knob is at 100%, which is what makes a single default sensible - and what
 * makes this a shared declaration rather than five copies.
 *
 * `max` is 1.5 rather than 1 for two reasons. A level control that cannot go above its calibration
 * point cannot be pushed, and every real mixer's fader can. And it is what let the calibration be
 * applied without changing any existing song: saved gains are divided by the trim on load, and the
 * loudest instrument's trim is below 1, so its songs need room above 100% to land in.
 *
 * The default puts one note 12dB below full scale. That is not a round number for its own sake: it
 * leaves a three-note chord at about -3dBFS and three such parts a little over, which is where the
 * bus limiter is a safety net taking a few decibels off transients rather than doing the mixing.
 */
export function levelParam({ label = 'Level', def = 0.25, help } = {}) {
  return numberParam({
    key: 'gain',
    label,
    min: 0,
    max: 1.5,
    // No step: a decibel taper has no natural one. A fixed step in *amplitude* would be 0.09dB at the
    // top of this control and 12dB near the bottom, which is the same mistake as the linear taper in
    // miniature. The 1000 positions the slider has are 0.06dB apart, which is finer than the ear.
    def,
    // In decibels, which is the whole of this control's ergonomics - see paramToUnit.
    scale: 'db',
    mod: 'level',
    help,
    // In decibels, because that is what a level is. A percentage of an amplitude tells you nothing
    // useful - "50%" is -6dB, which nobody reads off it - and the two knobs this now shares a scale
    // with, the master fader and the reduction readout, are both in dB already.
    format: (v) => (v > 0 ? dbLabel(gainToDb(v)) : 'silent'),
  });
}

/**
 * Where a level control bottoms out before it becomes silence.
 *
 * A `db` parameter cannot use the `log` scale, and the reason is the whole point of having a third
 * one: a logarithmic scale needs a positive minimum, and a level's minimum is zero. So the taper runs
 * in decibels from this floor to the parameter's maximum, and position zero is silence rather than
 * -60dB - which is what a fader at the bottom means everywhere else in the world.
 *
 * -60dB is inaudible on any system, and carrying on below it would spend travel on differences nobody
 * can hear. The master fader in master-strip.js uses the same floor for the same reason; it is not a
 * declared parameter, so it does its own arithmetic.
 */
export const DB_FLOOR = -60;

const asDb = (gain) => 20 * Math.log10(gain);

/**
 * A control's position, 0..1, and the value it means.
 *
 * Kept as a pair here rather than in the panel so that anything else which wants to move a
 * parameter smoothly - an automation lane, a randomiser, a modulation source - moves it the way
 * the control does, instead of inventing its own idea of halfway.
 *
 * Three scales, and each exists because the other two get something wrong:
 *
 *   - **linear** for anything whose units are already even to the ear or the eye.
 *   - **log** for frequency, because a linear cutoff control spends four fifths of its travel above
 *     4kHz where almost nothing is.
 *   - **db** for a level, because linear *amplitude* is worse than either. Half the travel of a
 *     0-to-1.5 amplitude fader covers the top 6dB and the rest covers everything else, so every
 *     sensible setting for a part in a four-part mix crowds into the bottom sixth of it. Measured on
 *     a real song rather than reasoned about: three of its four parts sat below 18% of the travel,
 *     one of them at 7%, which is where a fader has no resolution left and feels broken.
 */
export function paramToUnit(param, value) {
  if (param.scale === 'db') {
    if (!(value > 0)) return 0;
    const top = asDb(param.max);
    return Math.max(0, Math.min(1, (asDb(value) - DB_FLOOR) / (top - DB_FLOOR)));
  }
  if (param.scale === 'log') {
    return Math.log(value / param.min) / Math.log(param.max / param.min);
  }
  return (value - param.min) / (param.max - param.min);
}

export function unitToParam(param, unit) {
  const t = Math.max(0, Math.min(1, unit));
  if (param.scale === 'db') {
    if (t <= 0) return param.min;
    const top = asDb(param.max);
    return 10 ** ((DB_FLOOR + t * (top - DB_FLOOR)) / 20);
  }
  if (param.scale === 'log') {
    return param.min * (param.max / param.min) ** t;
  }
  return param.min + t * (param.max - param.min);
}

/**
 * Freeze an automated parameter at `value` as of `time`, discarding whatever was scheduled after it.
 * What every release needs before it can ramp down from "here".
 *
 * Two ways to get this wrong, and this project has now made both of them.
 *
 * The first was reading `param.value` and planting that. But `.value` is the parameter *now* - at
 * `ctx.currentTime` - and a sequenced note is scheduled as much as a lookahead before it sounds, so
 * "now" is a moment before the note has even started. What got written was the gain's resting value,
 * planted at the release like a step, and every note ended on a click: a sample-to-sample jump of
 * 0.62 in a waveform whose own steepest slope was 0.06, invisible until the spectrogram drew it as a
 * bright vertical stripe across every frequency at once.
 *
 * The second was believing `cancelAndHoldAtTime` alone was the answer. It is documented as holding the
 * value the automation *would* have reached, which sounds exactly right, and it does not leave an
 * event behind for a following ramp to start from. So `cancelAndHoldAtTime(t)` then
 * `linearRampToValueAtTime(0, t + tail)` does not ramp over the tail at all - it ramps from whatever
 * the last *real* event was, which is the end of the decay, and every sustained note faded slowly
 * from there instead of holding. Measured against a DC source, a note whose sustain was 1.0 read 0.42
 * a quarter of the way through and 0.23 halfway. The sustain knob set the level reached at the end of
 * the decay and nothing kept it there.
 *
 * So the caller passes the value. It is the only party that can: the value at the release depends on
 * the shape of the envelope, and the envelope belongs to the instrument. What is shared is only the
 * order of operations - cancel, anchor, then let the caller ramp.
 */
export function holdParamAt(param, time, value) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
  else param.cancelScheduledValues(time);
  if (Number.isFinite(value)) param.setValueAtTime(value, time);
}

/**
 * Where a two-stage linear ramp has got to at `t`: rising to `peak` by `attackEnd`, then to
 * `sustain` by `decayEnd`, then holding.
 *
 * The companion to `holdParamAt` - this is what an instrument passes it. Linear because that is what
 * an amplitude envelope uses; `holdExponentialAt` is the same idea for a frequency.
 */
export function linearStageAt(t, { start, attackEnd, decayEnd, peak, sustain }) {
  if (t <= start) return 0;
  if (t < attackEnd) return (peak * (t - start)) / (attackEnd - start);
  if (t < decayEnd) return peak + ((sustain - peak) * (t - attackEnd)) / (decayEnd - attackEnd);
  return sustain;
}

/** The same for a parameter travelling exponentially, which is how anything in Hz has to travel. */
export function exponentialStageAt(t, { start, attackEnd, decayEnd, from, peak, sustain }) {
  if (t <= start) return from;
  if (t < attackEnd) return from * (peak / from) ** ((t - start) / (attackEnd - start));
  if (t < decayEnd) return peak * (sustain / peak) ** ((t - attackEnd) / (decayEnd - attackEnd));
  return sustain;
}
