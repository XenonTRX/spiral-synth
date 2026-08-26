export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiFromOctavePc(octave, pc) {
  return (octave + 1) * 12 + pc;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(octave, pc) {
  return `${PITCH_CLASSES[pc]}${octave}`;
}

export function pcFromMidi(midi) {
  return ((midi % 12) + 12) % 12;
}

export function octaveFromMidi(midi) {
  return Math.floor(midi / 12) - 1;
}

// Scales as semitone offsets from the tonic, same convention as CHORD_TYPES. Chromatic is
// the identity case: every pitch is "in scale", which is what an unkeyed spiral shows.
// `short` is for the narrow flag a key marker collapses to once the lane is a time axis: a
// marker takes no time, so it cannot be given width in proportion to one, and a 34px stripe
// has room for a tonic and three letters.
export const SCALES = [
  { id: 'chromatic', label: 'Chromatic', short: 'chr', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major', label: 'Major (Ionian)', short: 'maj', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian', label: 'Dorian', short: 'dor', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', short: 'phr', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', short: 'lyd', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', short: 'mix', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'aeolian', label: 'Minor (Aeolian)', short: 'min', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian', label: 'Locrian', short: 'loc', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonic-minor', label: 'Harmonic minor', short: 'hm', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', label: 'Melodic minor', short: 'mm', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'major-pentatonic', label: 'Major pentatonic', short: 'maj5', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', label: 'Minor pentatonic', short: 'min5', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', short: 'blu', intervals: [0, 3, 5, 6, 7, 10] },
];

export function scaleById(id) {
  return SCALES.find((s) => s.id === id) ?? SCALES[0];
}

// What a spiral assumes when no key element precedes it: C tonic, nothing out of scale.
// `explicit` is false here so an unkeyed spiral renders exactly as it always has, with no
// scale shading at all - the shading is a signal that a key is in force, not decoration.
export const DEFAULT_KEY_CONTEXT = { tonicPc: 0, scaleId: 'chromatic', explicit: false };

export function keyContextLabel({ tonicPc, scaleId }) {
  return `${PITCH_CLASSES[tonicPc]} ${scaleById(scaleId).label}`;
}

// 1-based position within the scale, or null when the pitch isn't a member of it.
export function scaleDegree(scale, semitonesFromTonic) {
  const rel = ((semitonesFromTonic % 12) + 12) % 12;
  const i = scale.intervals.indexOf(rel);
  return i === -1 ? null : i + 1;
}

// Every chord is a set of semitone offsets from a root (offset 0 is always the root).
// Because the spiral has a fixed 30deg-per-semitone angle and a fixed radius-per-semitone
// step, this exact offset list produces the exact same geometric shape no matter which
// note it's rooted on - that congruence is what the chord reference sidebar illustrates.
//
// `symbol` is the chord written on a lead sheet once it has a root under it, `figure` is what it
// adds to a roman numeral, and `quality` decides that numeral's case - the three things the key
// picket needs to name a chord it has found sitting inside a mode.
export const CHORD_TYPES = [
  { id: 'major', label: 'Major', symbol: '', figure: '', quality: 'major', intervals: [0, 4, 7] },
  { id: 'minor', label: 'Minor', symbol: 'm', figure: '', quality: 'minor', intervals: [0, 3, 7] },
  { id: 'dim', label: 'Diminished', symbol: 'dim', figure: '\u00b0', quality: 'diminished', intervals: [0, 3, 6] },
  { id: 'aug', label: 'Augmented', symbol: 'aug', figure: '+', quality: 'augmented', intervals: [0, 4, 8] },
  { id: 'maj7', label: 'Major 7', symbol: 'maj7', figure: 'maj7', quality: 'major', intervals: [0, 4, 7, 11] },
  { id: 'min7', label: 'Minor 7', symbol: 'm7', figure: '7', quality: 'minor', intervals: [0, 3, 7, 10] },
  { id: 'dom7', label: 'Dominant 7', symbol: '7', figure: '7', quality: 'major', intervals: [0, 4, 7, 10] },
  // The two sevenths the palette was missing, and it only became obvious once something started
  // listing what a mode contains: stack thirds on the seventh degree of a major scale and you get
  // a half-diminished chord, on the seventh of a harmonic minor a fully diminished one, and
  // neither had a shape here. A palette that cannot draw the vii of the most ordinary key in
  // music was quietly telling the picket that degree had nothing on it.
  { id: 'm7b5', label: 'Half-diminished 7', symbol: 'm7\u266d5', figure: '\u00f87', quality: 'diminished', intervals: [0, 3, 6, 10] },
  { id: 'dim7', label: 'Diminished 7', symbol: 'dim7', figure: '\u00b07', quality: 'diminished', intervals: [0, 3, 6, 9] },
  { id: 'sus2', label: 'Sus2', symbol: 'sus2', figure: 'sus2', quality: 'suspended', intervals: [0, 2, 7] },
  { id: 'sus4', label: 'Sus4', symbol: 'sus4', figure: 'sus4', quality: 'suspended', intervals: [0, 5, 7] },
];

// A chord's own name, once a root is under it.
export function chordSymbol(rootPc, chord) {
  return `${PITCH_CLASSES[rootPc]}${chord.symbol}`;
}

// And its name relative to the key: the degree in roman, cased by quality - upper for major and
// anything built on a major third, lower for minor and diminished - with the chord's figure after
// it. Only offered for seven-note scales, because that is what the numerals mean: I through VII
// number the steps of a heptatonic scale, and calling the third tone of a pentatonic `iii` would
// borrow an analysis the scale does not support.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// `caseQuality` is for the chords that have no third to be cased by. A sus chord's quality is the
// absence of one, so on its own it can only default to upper case - which puts `IIsus4` next to
// `ii` in the same column and reads as a mistake. Given the quality of the degree's own triad it
// takes that instead, and a degree keeps one case across everything built on it.
export function romanNumeral(degree, chord, caseQuality = chord.quality) {
  const base = ROMAN[degree - 1];
  if (!base) return null;
  const lower = caseQuality === 'minor' || caseQuality === 'diminished';
  return `${lower ? base.toLowerCase() : base}${chord.figure}`;
}

/** The pitch classes a key contains, tonic first. */
export function scalePitchClasses(tonicPc, scale) {
  return scale.intervals.map((offset) => (tonicPc + offset) % 12);
}

/**
 * What a mode has to offer, degree by degree.
 *
 * Not by stacking thirds, which is the textbook construction and only works on a seven-note
 * scale: skip-a-tone on a pentatonic produces intervals nobody would call a triad, and on the
 * chromatic it produces the same three chords twelve times. This asks the question the palette
 * can actually answer - which of the shapes you can press fit inside this key, rooted on each of
 * its tones - and that question has a sensible answer for every scale in the list. On a major
 * scale it returns exactly the diatonic set, numerals and all, because those are precisely the
 * chords that fit.
 */
export function chordsInKey(tonicPc, scale) {
  const inScale = new Set(scale.intervals);
  const heptatonic = scale.intervals.length === 7;
  return scale.intervals.map((rootOffset, index) => {
    const degree = index + 1;
    const fitting = CHORD_TYPES.filter((chord) =>
      chord.intervals.every((interval) => inScale.has((rootOffset + interval) % 12))
    );
    // Whatever plain triad the degree carries. It cases the chords that have no third of their
    // own - and only those: a degree can perfectly well hold both a major and a minor chord (the
    // sixth of a harmonic minor holds G# and G#m alike), and each of those still has to be cased
    // by what it is rather than by whichever of the two was found first.
    const triad = fitting.find((c) => c.intervals.length === 3 && c.quality !== 'suspended');
    const chords = fitting.map((chord) => ({
      chord,
      rootOffset,
      symbol: chordSymbol((tonicPc + rootOffset) % 12, chord),
      roman: heptatonic
        ? romanNumeral(
            degree,
            chord,
            chord.quality === 'suspended' ? triad?.quality ?? chord.quality : chord.quality
          )
        : null,
    }));
    return { degree, rootOffset, rootPc: (tonicPc + rootOffset) % 12, chords };
  });
}

// A duration is a base note value times a modifier, which is how notation itself encodes
// this and the reason triplets need no second timing system: a triplet eighth is just an
// eighth taken at 2/3 (three in the space of two), and a dotted eighth is one at 3/2.
// Everything downstream still reads a single `beats` number - the note's length as a
// fraction of a whole note, matching its label directly (a quarter really is 0.25) - so
// this is also the unit the step-position readout and the transport's dwell time use.
export const DURATION_BASES = [
  { id: '64th', label: '1/64', den: 64 },
  { id: '32nd', label: '1/32', den: 32 },
  { id: '16th', label: '1/16', den: 16 },
  { id: '8th', label: '1/8', den: 8 },
  { id: 'quarter', label: '1/4', den: 4 },
  { id: 'half', label: '1/2', den: 2 },
  { id: 'whole', label: '1/1', den: 1 },
];

export const DEFAULT_BASE_INDEX = DURATION_BASES.findIndex((b) => b.id === 'quarter');

// Mutually exclusive: a dotted triplet is theoretically expressible and practically never
// what anyone means, so the UI treats these as one four-way choice.
//
// The double dot earns its place by where it lands rather than by how often it is written. The
// lattice is geometric, so its gaps widen towards the long end - between a quarter and a dotted
// quarter there is nothing, and between a dotted quarter and a half there is nothing either. A
// double dot (7/4) sits in the second of those gaps at every note value, which halves the
// coarsest steps the lattice has.
export const DURATION_MODIFIERS = [
  { id: 'plain', suffix: '', num: 1, den: 1, name: 'plain' },
  { id: 'dotted', suffix: '.', num: 3, den: 2, name: 'dotted' },
  { id: 'double-dotted', suffix: '..', num: 7, den: 4, name: 'double dotted' },
  { id: 'triplet', suffix: 'T', num: 2, den: 3, name: 'triplet' },
];

export function modifierById(id) {
  return DURATION_MODIFIERS.find((m) => m.id === id) ?? DURATION_MODIFIERS[0];
}

function baseAt(index) {
  return DURATION_BASES[Math.max(0, Math.min(DURATION_BASES.length - 1, index))];
}

export function durationBeats(baseIndex, modifierId) {
  const mod = modifierById(modifierId);
  return (mod.num / mod.den) / baseAt(baseIndex).den;
}

// What the step shows: the note value plus its modifier mark, e.g. `1/8T`, `1/4.`.
export function durationLabel(baseIndex, modifierId) {
  return `${baseAt(baseIndex).label}${modifierById(modifierId).suffix}`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

// The same length written as a plain fraction of a whole note, which is the form that makes
// a triplet legible: 1/8T is 1/12, and three of them fill a quarter exactly.
export function durationFraction(baseIndex, modifierId) {
  const mod = modifierById(modifierId);
  const num = mod.num;
  const den = baseAt(baseIndex).den * mod.den;
  const d = gcd(num, den);
  return `${num / d}/${den / d}`;
}

// Every length the notation can express, shortest first. Durations are a discrete set - six
// note values times three modifiers - so dragging a step's edge is a snap to the nearest member
// of this list rather than a free resize, and a step can never end up a length it has no name
// for.
export const DURATION_CHOICES = DURATION_BASES.flatMap((base, baseIndex) =>
  DURATION_MODIFIERS.map((mod) => ({
    baseIndex,
    modifierId: mod.id,
    beats: durationBeats(baseIndex, mod.id),
  }))
).sort((a, b) => a.beats - b.beats);

// Nearest in *ratio*, not in difference: the choices are geometric, so at the long end plain
// subtraction would snap everything to 1/1 (a 1/2 is 0.5 away from a whole note and a 1/32 is
// 0.03 away from a 1/16), and a drag near the top of the range would have nowhere else to land.
export function nearestDuration(beats) {
  const target = Math.log(Math.max(beats, 1e-6));
  let best = DURATION_CHOICES[0];
  let bestError = Infinity;
  for (const choice of DURATION_CHOICES) {
    const error = Math.abs(Math.log(choice.beats) - target);
    if (error < bestError) {
      bestError = error;
      best = choice;
    }
  }
  return best;
}

// Once a note carries its length as a plain number, this is how it gets its name back - or
// doesn't.
//
// Lengths are free, so most of them have no name, and inventing one for them would be worse
// than useless: writing 0.4921875 as 63/128 is arithmetically true and tells a musician
// nothing. The label is therefore either a real note value or the word `custom`, and the exact
// number goes in the tooltip where it can be checked without being read all the time.
const LENGTH_LABELS = new Map();
export const CUSTOM_LENGTH_LABEL = 'custom';

// Generous enough to absorb the resolution floor's rounding, tight enough that a length a
// thousandth of a bar off a quarter is not called a quarter.
const NAMED_TOLERANCE = 1e-6;

function exactChoice(beats) {
  return DURATION_CHOICES.find((c) => Math.abs(c.beats - beats) < NAMED_TOLERANCE) ?? null;
}

/** True when a length lands on something the notation can write down. */
export function isNamedLength(beats) {
  return exactChoice(beats) !== null;
}

// Called for every note on every render, so the answer is cached; songs reuse a handful of
// lengths over and over.
export function labelForBeats(beats) {
  const cached = LENGTH_LABELS.get(beats);
  if (cached) return cached;
  const choice = exactChoice(beats);
  const label = choice ? durationLabel(choice.baseIndex, choice.modifierId) : CUSTOM_LENGTH_LABEL;
  LENGTH_LABELS.set(beats, label);
  return label;
}

export function titleForBeats(beats) {
  const choice = exactChoice(beats);
  if (choice) return durationTitle(choice.baseIndex, choice.modifierId);
  // In whole notes rather than in bars: a bar is whatever the meter says it is, and a length is
  // a note value, which is the one thing a change of signature does not touch.
  return `custom · ${beats.toFixed(3)} of a whole note`;
}

export function durationTitle(baseIndex, modifierId) {
  const mod = modifierById(modifierId);
  // A plain note value already is the fraction, so spelling it out twice reads like a bug.
  if (mod.id === 'plain') return `${baseAt(baseIndex).label} of a whole note`;
  return `${baseAt(baseIndex).label} ${mod.name} · ${durationFraction(baseIndex, modifierId)} of a whole note`;
}

// beats is a fraction of a whole note; BPM is quarter-notes-per-minute (the standard
// meaning), so a whole note lasts 4 quarter-beats and everything else scales from that.
export function secondsForBeats(beats, bpm) {
  return (beats * 4 * 60) / bpm;
}

export function beatsForSeconds(seconds, bpm) {
  return (seconds * bpm) / (4 * 60);
}

// Where a start position is allowed to land.
//
// These are fractions of a **whole note**, not of a bar, which used to be the same statement and
// stopped being one when meters arrived: a 1/2 divides a 4/4 bar evenly and cuts a 3/4 bar in a
// place nothing else lands on. That is why the first two entries are named rather than numbered -
// `Bar` and `Beat` are resolved against the meter (see grid.js), so there is always a snap that
// agrees with the bar lines whatever the signature is, and the fractions stay available for when
// you want the note value rather than the metre.
export const SNAP_CHOICES = [
  { id: 'bar', label: 'Bar', meter: 'bar' },
  { id: 'beat', label: 'Beat', meter: 'pulse' },
  { id: 'half', label: '1/2', beats: 1 / 2 },
  { id: 'quarter', label: '1/4', beats: 1 / 4 },
  { id: 'eighth', label: '1/8', beats: 1 / 8 },
  { id: 'sixteenth', label: '1/16', beats: 1 / 16 },
  { id: 'thirtysecond', label: '1/32', beats: 1 / 32 },
  { id: 'quarter-triplet', label: '1/4T', beats: 1 / 6 },
  { id: 'eighth-triplet', label: '1/8T', beats: 1 / 12 },
  { id: 'sixteenth-triplet', label: '1/16T', beats: 1 / 24 },
  { id: 'off', label: 'Off', beats: 0 },
];

// `positionLabel` used to live here, next to the constant that said a bar was a whole note. Both
// moved to meter.js when that stopped being true - where a beat falls in a bar is a question
// about the metre, and this file knows about note values.

export function snapById(id) {
  return SNAP_CHOICES.find((s) => s.id === id) ?? SNAP_CHOICES.find((s) => s.id === 'sixteenth');
}

// Snapping is rounding to the nearest multiple, and it is deliberately not clamped to zero
// at the low end by the caller: a note dragged left off the start of the song wants to stop
// at 0, but the cursor arithmetic wants to know it went negative first.
export function snapBeats(beats, snapSize) {
  if (!snapSize) return beats;
  return Math.round(beats / snapSize) * snapSize;
}
