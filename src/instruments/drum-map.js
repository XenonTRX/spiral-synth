// Which note is which drum.
//
// A kit is the first instrument here where pitch does not mean pitch. A note at 38 is not a D2 that
// happens to sound like a snare - it *is* the snare, and playing it an octave up would be a
// different instrument rather than the same one higher. So this file is the translation, and it has
// to be the only one: the processor picks a voice from it, the panel labels the key gutter from it,
// the scope offers measurement notes from it, and the step lane draws its rows from it. Four
// readers, one table, no chance of the lane writing a note the processor calls something else.
//
// The numbers are General MIDI's, not ours. Nothing in this project needs them to be - a contiguous
// block from C2 would sit more neatly on the roll and be easier to read - but a drum map is exactly
// the kind of thing that leaves the app: a pattern written here should land on the right drums in
// any other DAW, and one imported from anywhere else should land on the right drums here. That is
// worth more than tidy spacing, and the gutter labels make the gaps a non-issue anyway.
//
// No imports, so it loads on the main thread and inside AudioWorkletGlobalScope alike.

/** Voice kinds, as small integers, because the processor dispatches on them. */
export const KICK = 0;
export const RIM = 1;
export const SNARE = 2;
export const CLAP = 3;
export const TOM_LO = 4;
export const HAT_CLOSED = 5;
export const TOM_MID = 6;
export const HAT_OPEN = 7;
export const TOM_HI = 8;
export const CRASH = 9;
export const RIDE = 10;
export const COWBELL = 11;

/**
 * The kit, in the order the step lane stacks it.
 *
 * Low drums at the bottom, and the order here is the order of the rows - which is deliberately not
 * ascending note number. A drummer reads a kit by what the limbs do, so kick sits under snare and
 * the hats sit above both, and that is worth more on a grid than sorting by a number nobody is
 * looking at. The roll still shows them in pitch order, because the roll is a pitch axis.
 *
 * Twelve rows now. Adding one costs exactly this entry, a voice kind above, and the arithmetic that
 * makes the sound - the lane, the gutter, the scope's note list and the processor's dispatch all read
 * this table, so none of them had to be told.
 */
export const DRUMS = [
  { midi: 49, kind: CRASH, name: 'Crash', short: 'Crs' },
  { midi: 51, kind: RIDE, name: 'Ride', short: 'Rid' },
  // Mounted rather than struck with a limb, which is why it sits above the cymbals rather than
  // between the drums: it is the one voice here that is not part of the kit proper.
  { midi: 56, kind: COWBELL, name: 'Cowbell', short: 'Cow' },
  { midi: 46, kind: HAT_OPEN, name: 'Open Hat', short: 'OH' },
  { midi: 42, kind: HAT_CLOSED, name: 'Closed Hat', short: 'CH' },
  { midi: 48, kind: TOM_HI, name: 'Hi Tom', short: 'T-Hi' },
  { midi: 45, kind: TOM_MID, name: 'Mid Tom', short: 'T-Md' },
  { midi: 41, kind: TOM_LO, name: 'Low Tom', short: 'T-Lo' },
  { midi: 39, kind: CLAP, name: 'Clap', short: 'Clp' },
  { midi: 37, kind: RIM, name: 'Rim', short: 'Rim' },
  { midi: 38, kind: SNARE, name: 'Snare', short: 'Snr' },
  { midi: 36, kind: KICK, name: 'Kick', short: 'Kck' },
];

const BY_MIDI = new Map(DRUMS.map((drum) => [drum.midi, drum]));

export function drumForMidi(midi) {
  return BY_MIDI.get(midi) ?? null;
}

/**
 * The voice kind for a note, or -1 for a note this kit has nothing on.
 *
 * -1 rather than a fallback to the kick, because a pattern written for a bigger kit should be
 * silent on the drums this one lacks rather than turning every unknown percussion note into a bass
 * drum, which is the single worst-sounding way to be wrong about a drum map.
 */
export function kindForMidi(midi) {
  return BY_MIDI.get(midi)?.kind ?? -1;
}

/** The lowest and highest notes the kit answers to, for anything that wants to frame the range. */
export const DRUM_LOW = Math.min(...DRUMS.map((d) => d.midi));
export const DRUM_HIGH = Math.max(...DRUMS.map((d) => d.midi));
