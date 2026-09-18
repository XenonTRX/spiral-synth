// Operations that more than one surface reaches, and the unit confusion they all shared.
//
// A note's `start` is measured from the part it is in; a cursor is a moment in the *song*. On a part
// beginning at bar 1 those are the same number, which is why handing one straight to the other went
// unnoticed for as long as every part began at bar 1. These are the cases where they differ.
//
// Only the operations that do not audition are here: `audition` reaches the audio engine, and there
// is no AudioContext in Node. `selectAdjacentNote` and `buildChord` carry the same fix and are
// checked in a browser instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSong } from '../src/song.js';
import { chordRoot, duplicateSelection, nudgeSelection } from '../src/edits.js';
import { barBeats } from '../src/meter.js';

const BAR = barBeats();

/** A song with one part beginning `bars` bars in, holding one note a quarter into its material. */
function offsetPart(bars, { start = 0.25, length = 0.25 } = {}) {
  const song = createSong();
  const track = song.addTrack();
  song.setTrackRegion(track.id, { begin: bars * BAR, end: (bars + 4) * BAR });
  const note = song.addNote(track.id, { midi: 60, start, length });
  song.setSelection([note.id]);
  // Where a user looking at that note would have left the cursor.
  song.setCursor(bars * BAR + start);
  return { song, track, note };
}

test('duplicating a note leaves the cursor on the copy, not four bars back', () => {
  // The reported bug: the cursor was set to the copy's *material* start, so on a part beginning at
  // bar 5 it jumped to bar 1 - and the keyboard reveals the cursor after duplicating, so the roll's
  // viewport went with it.
  const { song } = offsetPart(4);
  duplicateSelection(song);
  assert.equal(song.getCursor(), 4 * BAR + 0.5);
});

test('and on a part at the front of the song, which is why it went unnoticed', () => {
  const { song } = offsetPart(0);
  duplicateSelection(song);
  assert.equal(song.getCursor(), 0.5);
});

test('the copy itself was always in the right place', () => {
  // Only the cursor was wrong, so the fix must not move the note.
  const { song, track } = offsetPart(4);
  duplicateSelection(song);
  assert.deepEqual(track.notes.map((n) => n.start), [0.25, 0.5]);
});

test('duplicating inside a later pass stays in that pass', () => {
  const { song, track } = offsetPart(4);
  // Two bars of material, so the part repeats twice over its four bars.
  song.addNote(track.id, { midi: 60, start: 1.5, length: 0.25 });
  song.setSelection([track.notes[0].id]);
  song.setCursor(6 * BAR + 0.25); // the second pass
  duplicateSelection(song);
  assert.equal(song.getCursor(), 6 * BAR + 0.5, 'the pass you were in, not the first');
});

test('nudging keeps the cursor with the notes', () => {
  // This one was already right, because it moves the cursor by a delta rather than setting it to a
  // note's position - worth pinning so it stays that way.
  const { song } = offsetPart(4);
  nudgeSelection(song, 0.25);
  assert.equal(song.getCursor(), 4 * BAR + 0.5);
});

test('a chord root is in song time whether it comes from a note or from the cursor', () => {
  // The two branches of chordRoot disagreed by the part's own offset: one returned a note's material
  // start and the other returned the cursor. buildChord feeds the result to both `sourceBeat` and
  // the cursor, so either the chord or the cursor had to be wrong.
  const { song, note } = offsetPart(4);
  const fromNote = chordRoot(song);
  assert.equal(fromNote.start, 4 * BAR + 0.25);
  assert.equal(fromNote.midi, note.midi);

  song.clearSelection();
  song.setCursor(4 * BAR + 0.75);
  const fromCursor = chordRoot(song);
  assert.equal(fromCursor.start, 4 * BAR + 0.75);
});

test('a chord root still folds back onto the material it is built in', () => {
  // The round trip buildChord actually performs: song time out of chordRoot, material time in.
  const { song, track } = offsetPart(4);
  const root = chordRoot(song);
  assert.equal(song.sourceBeat(track.id, root.start), 0.25);
});
