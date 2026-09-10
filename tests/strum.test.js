// What a strum does to a chord, and what doing it twice does.
//
// The claims here are the ones src/strum.js makes in prose: the notes come out in pitch order, the
// earliest attack does not move, the opposite stroke cancels the first exactly, and nothing is ever
// pushed earlier than it was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SPREAD, MAX_SPREAD, MIN_SPREAD, strumShifts } from '../src/strum.js';

/** A chord as the song would hold it: sorted by start, then pitch. */
const chord = (start, pitches) => pitches.map((midi, i) => ({ id: `n${i}`, midi, start }));

/** Apply a stroke and hand back notes shaped the way the next one wants them. */
function stroke(notes, direction, spread = DEFAULT_SPREAD) {
  const shifts = strumShifts(notes, { direction, spread });
  const byId = new Map(shifts.map((shift) => [shift.id, shift.start]));
  return notes.map((note) => ({ ...note, start: byId.get(note.id) }));
}

const starts = (notes) => notes.map((note) => note.start);

test('an upward stroke spaces the chord in pitch order, one spread apart', () => {
  const after = stroke(chord(1, [60, 64, 67]), 1);
  assert.deepEqual(starts(after), [1, 1 + DEFAULT_SPREAD, 1 + 2 * DEFAULT_SPREAD]);
});

test('a downward stroke is the same stroke the other way up', () => {
  const after = stroke(chord(1, [60, 64, 67]), -1);
  assert.deepEqual(starts(after), [1 + 2 * DEFAULT_SPREAD, 1 + DEFAULT_SPREAD, 1]);
});

test('pitch order, not the order the notes are stored in', () => {
  // Stored low-to-high, so an inversion is the case that tells the two apart: the top note of the
  // chord is C5 rather than the last one in the list.
  const notes = [
    { id: 'e', midi: 64, start: 0 },
    { id: 'g', midi: 67, start: 0 },
    { id: 'c', midi: 72, start: 0 },
  ];
  const after = stroke(notes, 1);
  assert.deepEqual(starts(after), [0, DEFAULT_SPREAD, 2 * DEFAULT_SPREAD]);
});

test('the earliest attack does not move, however many times it is strummed', () => {
  let notes = chord(2, [48, 55, 60, 64]);
  for (let i = 0; i < 5; i++) {
    notes = stroke(notes, 1);
    assert.equal(Math.min(...starts(notes)), 2);
  }
});

test('strumming again widens it by one more spread', () => {
  const once = stroke(chord(0, [60, 64, 67]), 1);
  const twice = stroke(once, 1);
  assert.deepEqual(starts(twice), [0, 2 * DEFAULT_SPREAD, 4 * DEFAULT_SPREAD]);
});

test('the opposite stroke cancels the first exactly', () => {
  const before = chord(1.5, [55, 59, 62, 67, 71]);
  const back = stroke(stroke(before, 1), -1);
  for (const [i, note] of back.entries()) {
    assert.ok(Math.abs(note.start - before[i].start) < 1e-12, `${note.id} came back to its start`);
  }
});

test('nothing is ever pushed earlier than the chord began', () => {
  // A chord on the first beat of the song is the case that matters: an offset applied without the
  // re-anchor would be fine, but the re-anchor subtracts, and subtracting past zero would be a note
  // the song has no room for.
  for (const direction of [1, -1]) {
    const after = stroke(chord(0, [36, 43, 48, 52, 55]), direction, MAX_SPREAD);
    assert.ok(Math.min(...starts(after)) >= 0);
    assert.equal(Math.min(...starts(after)), 0);
  }
});

test('a selection spanning two chords moves each note a little, and none of it far', () => {
  const notes = [...chord(0, [60, 64, 67]), ...chord(1, [62, 65, 69])].map((note, i) => ({ ...note, id: `n${i}` }));
  const after = stroke(notes, 1);
  // Six notes, so the widest offset is five spreads - and the re-anchor can only take some of that
  // back, never add to it.
  for (const [i, note] of after.entries()) {
    assert.ok(Math.abs(note.start - notes[i].start) <= 5 * DEFAULT_SPREAD + 1e-12);
  }
  assert.equal(Math.min(...starts(after)), 0);
});

test('one note is left alone — a strum of one is a nudge', () => {
  const after = stroke(chord(3, [60]), 1);
  assert.deepEqual(starts(after), [3]);
});

test('a spread of nothing does nothing, since the shift is relative', () => {
  const before = chord(1, [60, 64, 67]);
  assert.deepEqual(starts(stroke(before, 1, 0)), [1, 1, 1]);
});

test('the spread is clamped to what the panel can ask for', () => {
  const wide = stroke(chord(0, [60, 64]), 1, 10);
  assert.equal(wide[1].start, MAX_SPREAD);
  const narrow = stroke(chord(0, [60, 64]), 1, MIN_SPREAD);
  assert.equal(narrow[1].start, MIN_SPREAD);
});
