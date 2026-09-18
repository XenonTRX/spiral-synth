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
//
// There is a third, and it belongs to **a part** rather than to this module: the step lane's step,
// how wide one cell of the drum grid is - what a drum machine calls its scale. It sat here as
// "whatever snap is", on the argument that a lane with a size of its own would be a second opinion
// about the grid and notes would land somewhere neither surface was showing. That argument was
// correct while a cell was one note or nothing - a note off the lane's grid had no cell to be in, so
// it simply vanished from it. It stopped being correct when a cell became a span of time that counts
// whatever is inside it (see drum-lane.js): a note between two of the lane's lines now has exactly
// one cell and shows up there as the subdivision it is.
//
// It then spent an hour as a setting of this module's, global to the lane, before becoming a
// property of the part - because a kit at a 1/32 under a bassline at a 1/8 is the point of having it
// at all, and one global scale can only ever describe one part. What is left here is the
// *vocabulary*: the list of scales and how each resolves to a length. Which scale a part is on is
// stored on the part, and this module reads that one field - `laneStep` - rather than making every
// caller compose the lookup itself and get the fallback subtly wrong somewhere.

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
let swing = 0.5;
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

/**
 * How wide one cell of the step lane is.
 *
 * A shorter list than the snaps, because the two are not the same question. Snap has to offer `Bar`,
 * `Beat` and `Off`, and none of the three means anything to a grid of cells: a cell a bar wide is
 * four cells in a pattern, and `Off` is a step of zero, which is an infinite number of them. What is
 * left is the note divisions a drum machine actually offers as its scale, triplets included - which
 * are the reason this is worth having at all, since a lane at a 1/12 is a shuffle pattern you can
 * read, and the same figure written on a binary lane is invisible.
 *
 * `snap` is first and is the default: follow the toolbar, which is what the lane has always done.
 */
export const LANE_STEP_CHOICES = [
  { id: 'snap', label: 'Snap' },
  { id: 'quarter', label: '1/4', beats: 1 / 4 },
  { id: 'eighth', label: '1/8', beats: 1 / 8 },
  { id: 'eighth-triplet', label: '1/8T', beats: 1 / 12, ternary: true },
  { id: 'sixteenth', label: '1/16', beats: 1 / 16 },
  { id: 'sixteenth-triplet', label: '1/16T', beats: 1 / 24, ternary: true },
  { id: 'thirtysecond', label: '1/32', beats: 1 / 32 },
];

/** Which scale a part is on, defaulting to - and repairing to - following the toolbar. */
export function trackLaneStepId(track) {
  const id = track?.laneStep;
  return LANE_STEP_CHOICES.some((c) => c.id === id) ? id : 'snap';
}

/**
 * A part's step in whole notes.
 *
 * The fallback when following snap is a 1/4 rather than a 1/16, which is not a choice made here so
 * much as one preserved: `Snap: Off` is a step of zero, the lane has always answered that with a
 * 1/4, and changing it would move every cell of an existing lane for a reason unrelated to this.
 */
export function laneStepBeats(track) {
  const choice = LANE_STEP_CHOICES.find((c) => c.id === trackLaneStepId(track));
  if (!choice || choice.id === 'snap') return getSnapBeats() || 1 / 4;
  return choice.beats;
}

/**
 * Swing, as the fraction of a two-step pair that the first of the pair gets.
 *
 * Expressed this way because it is how every drum machine expresses it and because the numbers then
 * mean something: **0.5 is straight** - the pair splits evenly - and **2/3 is a triplet feel**, since
 * the first note takes two thirds of the pair and the second takes one. Everything between is the
 * continuum people actually dial through, and it is a continuum rather than a switch because the
 * interesting settings are not the round ones.
 *
 * 0.75 is the ceiling, and it is a real boundary rather than a shrug: at three quarters the off-beat
 * sits exactly halfway between its own step and the next, which is a dotted-eighth-plus-sixteenth
 * figure. Past it the off-beat is nearer the *following* downbeat than its own, so it stops reading as
 * a late note and starts reading as an early one - a different rhythm, not a harder shuffle.
 */
export const SWING_STRAIGHT = 0.5;
export const MAX_SWING = 0.75;

export function getSwing() {
  return swing;
}

export function setSwing(fraction) {
  const next = Math.max(SWING_STRAIGHT, Math.min(MAX_SWING, Number(fraction) || SWING_STRAIGHT));
  if (next === swing) return;
  swing = next;
  emit();
}

/**
 * Where a note actually sounds, given a swing and the step it is swung against.
 *
 * **Nothing stores this.** Swing is an interpretation applied by the one walk the transport and the
 * exporter share (see timeline.js), so the notes stay on the straight grid they were written on and
 * the knob can be swept while the song plays. Storing it instead - moving the notes - looks simpler
 * for about a minute and then is not: to change the amount you have to know where each note *would*
 * have been, which means either remembering the swing you last applied or re-deriving a step index
 * from an already-shifted position. The second of those is wrong for the case this lane went out of
 * its way to support, because a ratchet's later hits sit far enough into their step that a shifted
 * one lands in the next, and the re-derivation would tear the ratchet apart. Computing from the
 * stored position cannot make that mistake: the index is exact, always.
 *
 * Which is also why the index is a **floor** rather than a round. A note halfway through its step is
 * *in* that step - it is the second of two hits written there - and it takes that step's shift, so a
 * double or a triplet inside one cell moves as a unit and keeps its internal spacing. Rounding would
 * hand the later hits of every ratchet the *next* step's shift and flatten the figure.
 *
 * Only odd steps move, and only ever later, which is what makes this safe to apply after a window
 * has already been filtered on the straight positions - no note can be moved out of a window it was
 * selected for, or into one it was not.
 */
export function swungStart(start, step, fraction = swing) {
  const shift = (fraction - SWING_STRAIGHT) * 2;
  if (!(shift > 0) || !(step > 0)) return start;
  // The epsilon is for a start that is exactly on a line: sums of thirds and sixteenths can land a
  // hair under it, and a floor would then put the note in the step before its own.
  const index = Math.floor(start / step + 1e-9);
  if (index % 2 === 0) return start;
  return start + shift * step;
}

/** Whether `beat` lands on a multiple of `size`, loosely enough for a third of a bar to count. */
const onGrid = (beat, size) => size > 0 && Math.abs(beat / size - Math.round(beat / size)) < 1e-6;

/**
 * Where one lane cell sits in the bar: on its downbeat, on one of its beats, or neither.
 *
 * Decided by the cell's *time* rather than by counting cells, and that is the whole point of it. The
 * lane used to mark every `bar / step` -th cell, which is only a whole number when the step divides
 * the bar - true for every binary step in 4/4 and false the moment either side is unusual. A 1/8T
 * lane in 5/8 wants a bar line every 7.5 cells; counting rounds that to 8 and the bar lines walk off
 * the bars, slowly, in a way that looks like a rendering glitch rather than like arithmetic. Asking
 * whether this cell's beat is a multiple of the bar cannot drift.
 */
export function stepMark(beat, bar, pulse) {
  if (onGrid(beat, bar)) return 'bar';
  if (onGrid(beat, pulse)) return 'beat';
  return '';
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
