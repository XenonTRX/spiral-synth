// Where things are allowed to land in time.
//
// Starts and lengths are quantised on completely different terms, and it took two goes to get
// there. A start wants the grid: notes lining up with each other and with the bar is what makes
// a passage readable, and it is also the only way two parts can be read against one another. A
// length wants nothing at all.
//
// Lengths used to be forced onto the notation's lattice - note value times modifier - which is
// a tidy idea that quietly decides what music you are allowed to write. The lattice is
// geometric, so its gaps widen towards the long end and no amount of extra modifiers closes
// them; and a swung eighth, a note held a hair past the beat, or anything borrowed from a
// recording is not on it at all. So a length is now simply a number. If it happens to land on
// something the notation can name, it is named; if not, it is called custom, which is the honest
// answer and takes no more room to say.
//
// What free lengths cost, though, is that nothing lines up with anything. A length dragged by
// hand lands on some number no other note will ever land on, and after a stretch a whole passage
// sits on positions that agree with nothing - which makes the next edit harder rather than
// freer. Freedom from the *notation's* lattice was the point; freedom from arithmetic was not.
//
// So there is a **resolution**: the finest position anything is allowed to land on, set in the
// header and applying to every length and to any start not already on the snap grid. At its
// default of a 1/64 it is far below anything the notation can name - it does not put the lattice
// back, and a swung eighth is still perfectly expressible - but two notes dragged to "about the
// same length" now come out exactly equal, which is the whole difference between free and
// unusable.
//
// Snap and resolution answer two different questions and neither replaces the other. Snap is
// where a start goes, and it is coarse and musical: a 1/16, or a 1/12 when you are writing
// triplets. Resolution is the grid underneath everything, fine enough to be invisible until you
// need it. Note that the binary resolutions cannot express a triplet exactly - a 1/12 is not a
// multiple of a 1/64 - which is why the list carries 1/48, 1/96 and 1/192 as well, and why the
// resolution is never applied to a start the snap grid already placed.

import { SNAP_CHOICES, snapById } from './music-theory.js';
import { barBeats, pulseBeats } from './meter.js';
import { createListeners } from './observable.js';

export const RESOLUTION_CHOICES = [
  { id: '16th', label: '1/16', beats: 1 / 16 },
  { id: '32nd', label: '1/32', beats: 1 / 32 },
  { id: '48th', label: '1/48', beats: 1 / 48, ternary: true },
  { id: '64th', label: '1/64', beats: 1 / 64 },
  { id: '96th', label: '1/96', beats: 1 / 96, ternary: true },
  { id: '128th', label: '1/128', beats: 1 / 128 },
  { id: '192nd', label: '1/192', beats: 1 / 192, ternary: true },
];

let resolutionId = '64th';
let snapId = 'sixteenth';
const { subscribe: subscribeGrid, emit } = createListeners();
export { subscribeGrid };

export function getResolutionId() {
  return resolutionId;
}

export function getResolution() {
  return (RESOLUTION_CHOICES.find((r) => r.id === resolutionId) ?? RESOLUTION_CHOICES[3]).beats;
}

export function setResolutionId(id) {
  if (id === resolutionId || !RESOLUTION_CHOICES.some((r) => r.id === id)) return;
  resolutionId = id;
  emit();
}

export function getSnapId() {
  return snapId;
}

/**
 * How far apart the snap positions are, in whole notes.
 *
 * Two of the choices are named rather than numbered because their size is the meter's business:
 * `Bar` and `Beat` are whatever the signature currently says, so switching to 3/4 moves them
 * without anyone having to pick a different number. Everything else is a fixed note value.
 */
export function getSnapBeats() {
  const choice = snapById(snapId);
  if (choice.meter === 'bar') return barBeats();
  if (choice.meter === 'pulse') return pulseBeats();
  return choice.beats;
}

export function setSnapId(id) {
  if (id === snapId || !SNAP_CHOICES.some((s) => s.id === id)) return;
  snapId = id;
  emit();
}

/** Any positive length, landed on the resolution. */
export function quantizeLength(beats) {
  if (!Number.isFinite(beats) || beats <= 0) return 0.25;
  const step = getResolution();
  return Math.max(step, Math.round(beats / step) * step);
}

/** Any position, landed on the resolution. Never below zero - the song starts where it starts. */
export function quantizeTime(beats) {
  if (!Number.isFinite(beats) || beats <= 0) return 0;
  const step = getResolution();
  return Math.round(beats / step) * step;
}

/**
 * Where a start goes.
 *
 * Snap Off means "as fine as the grid gets", not "anywhere at all" - there is no useful reading
 * of a start that lands between two resolution steps, and having one door for every start is
 * what keeps a dragged note and a typed one landing in the same place.
 */
export function snapStart(beats) {
  const snap = getSnapBeats();
  if (!snap) return quantizeTime(beats);
  return Math.max(0, Math.round(beats / snap) * snap);
}

/**
 * One notch shorter or longer, in whatever the snap currently is.
 *
 * Tying the keyboard's step to snap rather than to a fixed amount is what keeps it useful across
 * three orders of magnitude: on a 1/16 grid you are trimming a note, on a 1/1 grid you are
 * adding bars to a pad, and it is the same two keys. Snap Off falls back to the resolution,
 * which is a fine-tune rather than a step.
 */
export function nudgeLength(beats, direction) {
  const step = getSnapBeats() || getResolution();
  const units = beats / step;
  // The next grid multiple in the direction of travel. A length already on the grid moves a
  // whole step; a custom one lands on the grid first, so a note dragged to 0.31 and then
  // lengthened comes out at a round 0.5 instead of carrying its offset around forever.
  const next = direction > 0 ? Math.floor(units + 1e-9) + 1 : Math.ceil(units - 1e-9) - 1;
  return quantizeLength(Math.max(step, next * step));
}
