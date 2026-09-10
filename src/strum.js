// A chord that is not struck all at once.
//
// Every note in a chord here starts on the same number, and nothing on a real instrument does that.
// A guitarist drags a pick across six strings over something like forty milliseconds; a pianist rolls
// a tenth they cannot reach; a string section is a dozen bows that do not quite agree. The gap is
// small enough that nobody hears it as an arpeggio and large enough that its absence is most of what
// makes programmed chords sound programmed - a block of simultaneous attacks is a single broadband
// transient, and no amount of reverb afterwards puts back the thing that was never there.
//
// So this is one operation: **take what is selected and spread it in pitch order**.
//
// **Why the arithmetic is here and not in edits.js.** edits.js is where an operation reachable from
// two surfaces belongs, and `strumSelection` is there. But edits.js reaches the audio engine, so it
// cannot be imported by a test, and the interesting part of a strum is arithmetic: which note goes
// how much later, and what happens when you do it twice. That part is here, where `node --test` can
// get at it. See tests/strum.test.js.
//
// **Relative, not absolute.** The offsets are *added* to what the notes already have rather than
// being laid out from the chord's start. Three things follow, and all three are why:
//
//   - Pressing it again widens the strum, which is the same "more of what it is" gesture `,` `.` and
//     `[` `]` already are.
//   - The opposite direction narrows it, exactly: up then down leaves the chord as it was, because
//     rank *k* from the bottom and rank *k* from the top sum to the same constant for every note.
//   - It needs no idea of what a chord *is*. An absolute layout has to answer "which of these notes
//     are one chord", and every rule for that either splits a chord that has already been strummed
//     (its notes no longer share a start) or swallows a run of sixteenths into one long ramp. A
//     relative shift applied to a selection spanning several chords simply moves each note a little,
//     which is the honest reading of the gesture and is undone by one ⌘Z.
//
// The re-anchoring is what makes the second point exact. Offsets are all positive, so a plain add
// would drag the whole chord later every time - up-then-down would come back flat but a strum's
// width late. Subtracting the smallest resulting shift pins the earliest note where it was, which
// also means **nothing ever moves earlier**, so a chord on the first beat of the song cannot be
// pushed off the front of it.

import { createListeners } from './observable.js';

/**
 * How far apart two neighbouring notes of a strum are, in whole notes - the same unit every other
 * duration here is in, so a strum written at 100bpm is the same gesture at 140.
 *
 * The default is a 1/64, which is 37ms at 100bpm. That is squarely what a downstroke across a guitar
 * actually measures - 20ms is a hard fast strum, 60ms is a lazy one - and it is deliberately below
 * the ~50ms at which the ear stops hearing one chord and starts hearing notes in succession.
 *
 * The range runs from a 1/256 - 9ms, a hair, the finest thing worth calling a gesture - to a 1/16,
 * which is 150ms a note and well past a strum into a rolled chord. There is no zero, because a
 * relative shift of nothing does nothing: the way to take a strum off is the other direction, which
 * cancels it exactly.
 */
export const DEFAULT_SPREAD = 1 / 64;
export const MIN_SPREAD = 1 / 256;
export const MAX_SPREAD = 1 / 16;

let spread = DEFAULT_SPREAD;
const { subscribe: subscribeStrum, emit } = createListeners();
export { subscribeStrum };

/**
 * One owner for how wide a strum is, for the same reason tempo has one: the key and the control in
 * the panel must be the same gesture, and a panel holding the number privately would make them two.
 */
export function getStrumSpread() {
  return spread;
}

export function setStrumSpread(beats) {
  const next = Math.max(MIN_SPREAD, Math.min(MAX_SPREAD, Number(beats) || DEFAULT_SPREAD));
  if (next === spread) return;
  spread = next;
  emit();
}

/**
 * Where each note ends up: `[{ id, start }]`, in the order it was given.
 *
 * `direction` is +1 for a strum that arrives at the top last - a downstroke on a guitar, low string
 * first - and -1 for one that arrives at the bottom last. Pitch order rather than the order the notes
 * are stored in, because that is what a strum is: the pick crosses the strings in pitch order, and
 * the notes' own order in the song is start-then-pitch and says nothing about which is which inside
 * one chord.
 *
 * Notes are ranked as a single run whatever their starts are. See the header for why there is no
 * attempt to work out which of them are a chord.
 */
export function strumShifts(notes, { direction = 1, spread: width = DEFAULT_SPREAD } = {}) {
  if (!notes.length) return [];
  const step = Math.max(0, Math.min(MAX_SPREAD, width));
  if (!(step > 0)) return notes.map((note) => ({ id: note.id, start: note.start }));
  const ranked = [...notes].sort((a, b) => a.midi - b.midi || a.start - b.start);
  if (direction < 0) ranked.reverse();
  const offsets = new Map();
  ranked.forEach((note, rank) => offsets.set(note.id, rank * step));
  // How much later the *first* attack would now be, taken off every note, so the passage stays where
  // it starts. Measured on the resulting starts rather than on the offsets, which is what makes the
  // reversal exact: after a strum the smallest offset belongs to a note that is already late, and
  // subtracting the smallest offset (zero) would leave the whole chord a strum's width behind.
  let lift = Infinity;
  let earliest = Infinity;
  for (const note of notes) {
    lift = Math.min(lift, note.start + offsets.get(note.id));
    earliest = Math.min(earliest, note.start);
  }
  lift -= earliest;
  return notes.map((note) => ({ id: note.id, start: note.start + offsets.get(note.id) - lift }));
}
