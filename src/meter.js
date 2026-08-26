// Bars: where the time axis is divided, and how the divisions are counted.
//
// Nothing in here touches a note. A note holds an absolute start and length in whole notes, so a
// bar line is an overlay on a continuous axis rather than a container anything lives inside -
// the same simplification key changes got. Changing the meter re-frames the drawing and moves
// nothing, which is the only reason this could be added without disturbing the model at all.
//
// A meter is two facts, and separating them matters because the second is the only thing that
// distinguishes 3/4 from 6/8:
//
//   - **How long a bar is** - numerator/denominator whole notes. 3/4 and 6/8 are both 0.75.
//     The same bar, exactly.
//   - **How it is grouped** - 3/4 is three groups of two eighths, 6/8 is two groups of three.
//     That is the entire difference, and it is what the mid-bar lines draw. Without it, 6/8
//     would be 3/4 wearing a hat.
//
// Every question here is asked *at a beat* - `barAt(beat)`, not `barAt()` - even though the
// answer cannot currently vary, because the song has one meter throughout. That is deliberate
// groundwork: mid-song meter changes are the next step, and when they arrive they change what is
// behind these functions rather than who calls them. The one thing they will change is that
// "which bar is this" stops being a division and becomes a walk over the markers, which is why
// nothing outside this file is allowed to divide a beat by a bar length. There is no
// `BEATS_PER_BAR` any more for exactly that reason.

import { labelForBeats } from './music-theory.js';
import { createListeners } from './observable.js';

// Denominators are powers of two, so every bar length is an exact binary fraction and bar
// arithmetic never accumulates error. The epsilons below are for the beats arriving from
// elsewhere, not for these.
const EPSILON = 1e-9;

/**
 * How a bar divides, in units of the denominator.
 *
 * Compound time - 6/8, 9/8, 12/8 - is felt in dotted beats, three of the written unit to each.
 * 3/8 is the exception the rule needs: it is too short to subdivide and is counted in three, not
 * as one lone group. Anything irregular says so explicitly, because there is no rule that gets
 * 7/8 right - it is 2+2+3 or 3+2+2 depending on the tune.
 */
function groupsFor({ numerator, denominator, groups }) {
  if (groups) return groups;
  if (denominator >= 8 && numerator > 3 && numerator % 3 === 0) {
    return Array.from({ length: numerator / 3 }, () => 3);
  }
  return Array.from({ length: numerator }, () => 1);
}

function meter(numerator, denominator, groups) {
  const spec = { numerator, denominator, groups };
  return {
    id: `${numerator}/${denominator}`,
    label: `${numerator}/${denominator}`,
    numerator,
    denominator,
    groups: groupsFor(spec),
    barBeats: numerator / denominator,
  };
}

export const METER_CHOICES = [
  meter(4, 4),
  meter(3, 4),
  meter(2, 4),
  meter(2, 2),
  meter(6, 8),
  meter(9, 8),
  meter(12, 8),
  meter(3, 8),
  meter(5, 4, [2, 3]),
  meter(7, 8, [2, 2, 3]),
  meter(5, 8, [3, 2]),
];

const DEFAULT_METER = METER_CHOICES[0];

let meterId = DEFAULT_METER.id;
const { subscribe: subscribeMeter, emit } = createListeners();
export { subscribeMeter };

export function getMeterId() {
  return meterId;
}

export function setMeterId(id) {
  if (id === meterId || !METER_CHOICES.some((m) => m.id === id)) return;
  meterId = id;
  emit();
}

/** The meter in force at a beat. One song, one meter - for now; the argument is the seam. */
export function meterAt(beat = 0) {
  return METER_CHOICES.find((m) => m.id === meterId) ?? DEFAULT_METER;
}

export function barBeats(beat = 0) {
  return meterAt(beat).barBeats;
}

// --- the bar map ---------------------------------------------------------------------------

/** Which bar a beat is in, counted from zero, and how far into it. */
export function barAt(beat) {
  const length = barBeats(beat);
  const bar = Math.max(0, Math.floor(beat / length + EPSILON));
  return { bar, beatInBar: beat - bar * length };
}

export function barStartBeat(bar) {
  return bar * barBeats(0);
}

/** Rounded up to the next bar line - what a loop and a repeat both want. */
export function ceilToBar(beat) {
  const length = barBeats(beat);
  return Math.ceil(beat / length - EPSILON) * length;
}

/**
 * The next bar line in the direction of travel.
 *
 * A beat already on a line moves a whole bar; one between lines lands on the nearer one first,
 * so `⇧←` from halfway through bar 4 goes to the start of bar 4 rather than to bar 3.
 */
export function nextBarLine(beat, direction = 1) {
  const length = barBeats(beat);
  const units = beat / length;
  const next = direction > 0 ? Math.floor(units + EPSILON) + 1 : Math.ceil(units - EPSILON) - 1;
  return Math.max(0, next * length);
}

// Nothing in this app draws thousands of lines usefully - past that they are a texture, and the
// callers thin out long before it - but a stride of the wrong sign or a zero bar length would
// otherwise spin forever, and a render loop is a bad place to find that out.
const MAX_LINES = 4096;

/** Every bar line in [from, to], every `stride` bars, as `{ bar, beat }`. */
export function barLinesBetween(from, to, stride = 1) {
  const out = [];
  const step = Math.max(1, Math.round(stride));
  const first = barAt(Math.max(0, from)).bar;
  for (let bar = first - (first % step); out.length < MAX_LINES; bar += step) {
    const beat = barStartBeat(bar);
    if (beat > to + EPSILON) break;
    if (beat >= from - EPSILON) out.push({ bar, beat });
  }
  return out;
}

/**
 * Every line *inside* a bar in [from, to] - the pulse, with the bar lines themselves left out
 * because they are drawn heavier and by someone else.
 *
 * This is where the grouping does its work: in 3/4 it puts two lines in the bar and in 6/8 it
 * puts one, which is the only way the two are told apart on screen.
 */
export function groupLinesBetween(from, to) {
  const out = [];
  for (const { beat } of barLinesBetween(from, to)) {
    const { groups, denominator } = meterAt(beat);
    let offset = 0;
    for (let i = 0; i < groups.length - 1 && out.length < MAX_LINES; i += 1) {
      offset += groups[i] / denominator;
      const at = beat + offset;
      if (at >= from - EPSILON && at <= to + EPSILON) out.push(at);
    }
  }
  return out;
}

// --- what a beat is ------------------------------------------------------------------------

/**
 * The felt pulse: one group where the groups are equal, and the written unit where they are not,
 * since there is no single pulse length in 7/8 to report.
 */
export function pulseBeats(beat = 0) {
  const { groups, denominator } = meterAt(beat);
  const first = groups[0];
  return groups.every((g) => g === first) ? first / denominator : 1 / denominator;
}

/**
 * The tempo as a musician would write it.
 *
 * BPM is stored as quarter notes per minute and stays that way, because it is the one definition
 * that means the same thing in every meter - but nobody counts 6/8 in quarters. So the number in
 * the box is the unambiguous one and this says what it amounts to: `1/4. = 66.7` next to a BPM
 * of 100. Changing the meter never changes the stored tempo, only this reading of it.
 */
export function pulseLabel(bpm) {
  const pulse = pulseBeats();
  const perMinute = bpm * (0.25 / pulse);
  const rounded = Math.abs(perMinute - Math.round(perMinute)) < 0.05
    ? String(Math.round(perMinute))
    : perMinute.toFixed(1);
  return `${labelForBeats(pulse)} = ${rounded}`;
}

/**
 * A moment in the song, written the way a DAW writes it: bar, then which unit of the bar, both
 * counted from one. The second number counts the *denominator's* unit - eighths in 6/8, quarters
 * in 3/4 - so it always agrees with the signature on screen. Anything off that unit shows as a
 * decimal; this is a readout to check the cursor against, not a value anyone types back in.
 */
export function positionLabel(beats) {
  const { bar, beatInBar } = barAt(beats);
  const { denominator } = meterAt(beats);
  const beat = beatInBar * denominator + 1;
  const rounded = Math.round(beat);
  const shown =
    Math.abs(beat - rounded) < 1e-6
      ? String(rounded)
      : beat.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${bar + 1}|${shown}`;
}
