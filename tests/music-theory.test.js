import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DURATION_BASES, PITCH_CLASSES, chordsInKey, durationBeats, midiToFreq,
  nearestDuration, pcFromMidi, scaleById, scalePitchClasses, snapBeats,
} from '../src/music-theory.js';

const baseIndex = (id) => DURATION_BASES.findIndex((b) => b.id === id);

test('A4 is 440 Hz and an octave doubles', () => {
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToFreq(81) - 880) < 1e-9);
});

test('pitch class wraps every twelve semitones', () => {
  assert.equal(PITCH_CLASSES.length, 12);
  for (const midi of [0, 12, 60, 72, 120]) assert.equal(pcFromMidi(midi), 0);
  assert.equal(pcFromMidi(69), 9); // A
});

test('three triplet eighths fill a quarter exactly', () => {
  // The duration lattice is fractions, not floats that nearly agree - this is the assertion that
  // says so. Lengths are fractions of a whole note, so a quarter is 0.25 and 1/8T is 1/12.
  const triplet = durationBeats(baseIndex('8th'), 'triplet');
  assert.ok(Math.abs(triplet - 1 / 12) < 1e-12, `1/8T read ${triplet}`);
  assert.ok(Math.abs(triplet * 3 - durationBeats(baseIndex('quarter'), 'plain')) < 1e-12);
});

test('a dot is one and a half', () => {
  const plain = durationBeats(baseIndex('quarter'), 'plain');
  const dotted = durationBeats(baseIndex('quarter'), 'dotted');
  assert.ok(Math.abs(dotted - plain * 1.5) < 1e-12);
});

test('nearestDuration is exact on the lattice and sane off it', () => {
  const quarter = durationBeats(baseIndex('quarter'), 'plain');
  assert.ok(Math.abs(nearestDuration(quarter).beats - quarter) < 1e-12);
  // Slightly sharp of a quarter still reads as a quarter.
  assert.ok(Math.abs(nearestDuration(quarter * 1.02).beats - quarter) < 1e-12);
});

test('snapping lands on the grid and never moves a value already on it', () => {
  assert.equal(snapBeats(0.26, 0.25), 0.25);
  assert.equal(snapBeats(0.25, 0.25), 0.25);
  assert.equal(snapBeats(1.7, 0.5), 1.5);
  // No snap size means no snapping, rather than snapping to zero.
  assert.equal(snapBeats(0.37, 0), 0.37);
});

test('C major has no accidentals, and its chords are the ones everybody knows', () => {
  const major = scaleById('major');
  assert.deepEqual(scalePitchClasses(0, major), [0, 2, 4, 5, 7, 9, 11]);

  // One entry per degree, each carrying the chords that will fit on it.
  const degrees = chordsInKey(0, major);
  assert.equal(degrees.length, 7);
  assert.deepEqual(degrees.map((d) => d.degree), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(degrees.map((d) => d.rootPc), [0, 2, 4, 5, 7, 9, 11]);

  // The triad every degree is named for: I major, ii minor, iii minor.
  const triad = (d) => degrees[d].chords[0];
  assert.equal(triad(0).roman, 'I');
  assert.equal(triad(0).symbol, 'C');
  assert.equal(triad(0).chord.quality, 'major');
  assert.equal(triad(1).chord.quality, 'minor');
  assert.equal(triad(2).chord.quality, 'minor');
});

test('the chromatic scale is the default and holds every pitch class', () => {
  assert.equal(scalePitchClasses(0, scaleById('chromatic')).length, 12);
});
