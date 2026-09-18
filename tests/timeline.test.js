// What the transport and the exporter are actually handed.
//
// The one walk both of them share, so anything asserted here is asserted about playback *and* about
// an exported file at once - which is the reason the walk was factored out in the first place.
//
// These were measured in a browser console when they were written, because the walk reaches the
// instrument registry and that looked like it needed a browser. It does not: nothing in `notesInWindow`
// touches Web Audio, and the registry is plain data until someone asks it to make a sound. So the
// numbers that were prose in a comment are assertions here instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSong } from '../src/song.js';
import { songNotes } from '../src/timeline.js';
import { SWING_STRAIGHT, setSwing } from '../src/grid.js';

const STEP = 1 / 16;

/** A song with one kit part carrying `count` sixteenths, and whatever else the test adds. */
function kitSong(count, { midi = 36, scale = 'sixteenth' } = {}) {
  const song = createSong();
  const track = song.addTrack();
  song.setInstrument(track.id, 'drums');
  // Stated rather than left to follow the toolbar, so the test does not depend on a snap setting
  // another file in the same run may have moved.
  song.setTrackLaneStep(track.id, scale);
  for (let i = 0; i < count; i++) song.addNote(track.id, { midi, start: i * STEP, length: 1 / 64 });
  return { song, track };
}

/** Every note the walk yields, as `[song position, material position]` in step units. */
const walk = (song) => [...songNotes(song)].map((n) => [
  Math.round(n.start / STEP * 1000) / 1000,
  Math.round(n.note.start / STEP * 1000) / 1000,
]);

const songSteps = (song) => walk(song).map(([at]) => at);

test.beforeEach(() => {
  setSwing(SWING_STRAIGHT);
});

// --- the pattern's last step --------------------------------------------------------------------

test('with no length set, every step plays where it was written', () => {
  const { song } = kitSong(16);
  assert.deepEqual(walk(song), Array.from({ length: 16 }, (_, i) => [i, i]));
});

test('a twelve-step pattern comes round after twelve, against a 4/4 bar', () => {
  // The polyrhythm a derived period cannot express: song steps 12-15 are the second pass playing
  // material steps 0-3, not the material's own 12-15.
  const { song, track } = kitSong(16);
  song.setTrackPeriod(track.id, 12 * STEP);
  assert.deepEqual(walk(song), [
    [0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11],
    [12, 0], [13, 1], [14, 2], [15, 3],
  ]);
});

test('steps past the last one are silent but not gone', () => {
  const { song, track } = kitSong(16);
  song.setTrackPeriod(track.id, 12 * STEP);
  // Nothing beyond step 11 of the *material* is ever played.
  assert.equal(walk(song).every(([, material]) => material < 12), true);
  // And the notes are still there, so lengthening brings them back.
  assert.equal(track.notes.length, 16);
  song.setTrackPeriod(track.id, null);
  assert.deepEqual(walk(song), Array.from({ length: 16 }, (_, i) => [i, i]));
});

test('a pattern pinned to its own length plays once', () => {
  const { song, track } = kitSong(16);
  song.setTrackPeriod(track.id, 12 * STEP);
  song.setTrackRegion(track.id, { end: 12 * STEP });
  assert.deepEqual(songSteps(song), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

// --- swing --------------------------------------------------------------------------------------

test('swing moves the odd steps late and leaves the even ones', () => {
  const { song } = kitSong(8);
  setSwing(2 / 3);
  assert.deepEqual(songSteps(song), [0, 4 / 3, 2, 3 + 1 / 3, 4, 5 + 1 / 3, 6, 7 + 1 / 3].map(
    (v) => Math.round(v * 1000) / 1000,
  ));
});

test('and drops nothing: the same notes come out either way', () => {
  const { song } = kitSong(8);
  const straight = walk(song).length;
  setSwing(2 / 3);
  assert.equal(walk(song).length, straight, 'same count swung as straight');
});

test('a ratchet inside one step travels as a unit', () => {
  // Two hits written in step 3, at the step and at its half.
  const { song, track } = kitSong(0);
  song.addNote(track.id, { midi: 42, start: 3 * STEP, length: 1 / 64 });
  song.addNote(track.id, { midi: 42, start: 3.5 * STEP, length: 1 / 64 });
  setSwing(2 / 3);
  const [first, second] = songSteps(song);
  assert.equal(first, Math.round((3 + 1 / 3) * 1000) / 1000);
  assert.equal(second, Math.round((3.5 + 1 / 3) * 1000) / 1000);
  assert.ok(Math.abs(second - first - 0.5) < 1e-9, 'the half-step gap survives');
});

test('swing is the drum machine’s, not the song’s', () => {
  const { song, track } = kitSong(8);
  const tonal = song.addTrack();
  song.setInstrument(tonal.id, 'subtractive');
  for (let i = 0; i < 8; i++) song.addNote(tonal.id, { midi: 60, start: i * STEP, length: 1 / 64 });
  setSwing(2 / 3);
  const bySong = [...songNotes(song)];
  const kitSteps = bySong.filter((n) => n.track.id === track.id).map((n) => n.start / STEP);
  const tonalSteps = bySong.filter((n) => n.track.id === tonal.id).map((n) => n.start / STEP);
  assert.ok(kitSteps.some((v) => Math.abs(v - Math.round(v)) > 1e-6), 'the kit shuffled');
  for (const [i, at] of tonalSteps.entries()) {
    assert.ok(Math.abs(at - i) < 1e-9, `the pitched part stayed on step ${i}`);
  }
});

test('straight is straight', () => {
  const { song } = kitSong(8);
  setSwing(SWING_STRAIGHT);
  assert.deepEqual(songSteps(song), [0, 1, 2, 3, 4, 5, 6, 7]);
});

// --- the two together ---------------------------------------------------------------------------

test('a swung twelve-step pattern shuffles inside every pass', () => {
  const { song, track } = kitSong(16);
  song.setTrackPeriod(track.id, 12 * STEP);
  setSwing(2 / 3);
  const rows = walk(song);
  assert.equal(rows.length, 16);
  // Swing is read off song time, so it is the song step's parity that decides - and because this
  // pattern is an even number of steps long, that is the material's parity too, in every pass.
  for (const [at, material] of rows) {
    const step = Math.floor(at + 1e-6);
    const expected = Math.round((step % 2 === 0 ? step : step + 1 / 3) * 1000) / 1000;
    assert.equal(at, expected, `material step ${material} sounds at song step ${at}`);
  }
  // And the fold still happened: the last four are the second pass replaying the first four steps.
  assert.deepEqual(rows.slice(12).map(([, material]) => material), [0, 1, 2, 3]);
});

// --- one swing, each part against its own scale --------------------------------------------------

test('two kits on different scales shuffle against their own', () => {
  // A 1/8 part and a 1/16 part, the same eight notes on each, one swing setting. The 1/8 part pairs
  // its notes two sixteenths apart, so its *even* sixteenths are the ones that move; the 1/16 part
  // pairs them one apart, so its odd ones do. Both shuffle; neither is shuffled at the other's
  // resolution, which a single global step size could not have expressed.
  const { song, track: fine } = kitSong(8, { scale: 'sixteenth' });
  const coarse = song.addTrack();
  song.setInstrument(coarse.id, 'drums');
  song.setTrackLaneStep(coarse.id, 'eighth');
  for (let i = 0; i < 8; i++) song.addNote(coarse.id, { midi: 42, start: i * STEP, length: 1 / 64 });

  setSwing(2 / 3);
  const rows = [...songNotes(song)];
  const at = (id) => rows.filter((n) => n.track.id === id).map((n) => Math.round(n.start / STEP * 1000) / 1000);

  // 1/16 scale: step index is the sixteenth, so odd sixteenths are late by a third of a 1/16.
  assert.deepEqual(at(fine.id), [0, 1.333, 2, 3.333, 4, 5.333, 6, 7.333]);
  // 1/8 scale: step index is the eighth, so sixteenths 2-3 and 6-7 are in the odd eighths, and they
  // are late by a third of a 1/8 - twice as far, which is the point.
  assert.deepEqual(at(coarse.id), [0, 1, 2.667, 3.667, 4, 5, 6.667, 7.667]);
});

// --- a part's own offset ------------------------------------------------------------------------
//
// The one duration here that is in milliseconds rather than in whole notes, because it models a
// physical lag rather than a musical value - see MAX_TRACK_OFFSET_MS.

import { getBpm, setBpm } from '../src/tempo.js';
import { secondsForBeats } from '../src/music-theory.js';
import { MAX_TRACK_OFFSET_MS } from '../src/track-time.js';

/**
 * When each note sounds, in milliseconds of song time.
 *
 * Through the app's own conversion rather than by hand: the first version of this had the tempo
 * written into it as a constant, which made the one test that changes the tempo measure nonsense.
 */
const millis = (song) => [...songNotes(song)].map((n) => Math.round(secondsForBeats(n.start, getBpm()) * 1000));

test('an offset moves the whole part, late and early alike', () => {
  setBpm(100);
  // Away from beat zero, so an early offset has somewhere to go.
  const { song, track } = kitSong(0);
  for (let i = 0; i < 4; i++) song.addNote(track.id, { midi: 36, start: 0.25 + i * STEP, length: 1 / 64 });
  assert.deepEqual(millis(song), [600, 750, 900, 1050]);
  song.setTrackOffsetMs(track.id, 20);
  assert.deepEqual(millis(song), [620, 770, 920, 1070]);
  song.setTrackOffsetMs(track.id, -20);
  assert.deepEqual(millis(song), [580, 730, 880, 1030]);
});

test('it is milliseconds, so it does not scale with the tempo', () => {
  const { song, track } = kitSong(0);
  song.addNote(track.id, { midi: 36, start: 0.25, length: 1 / 64 });
  song.setTrackOffsetMs(track.id, 20);
  setBpm(100);
  assert.equal(millis(song)[0], 620, 'a quarter in at 100bpm is 600ms, plus the 20ms lag');
  setBpm(200);
  // A beat is half as long at twice the tempo, so the note itself halves - and the lag does not.
  assert.equal(millis(song)[0], 320, 'the same note is 300ms in, and the lag is still 20ms');
  setBpm(100);
});

test('a part with no offset is left exactly alone', () => {
  setBpm(100);
  const { song } = kitSong(4);
  assert.deepEqual(millis(song), [0, 150, 300, 450]);
});

test('nothing is pushed before the start of the song', () => {
  setBpm(100);
  const { song, track } = kitSong(2);
  song.setTrackOffsetMs(track.id, -MAX_TRACK_OFFSET_MS);
  const out = millis(song);
  // The note on beat zero has no earlier to go to, so it stays; the one after it moves.
  assert.equal(out[0], 0);
  assert.equal(out[1], 150 - MAX_TRACK_OFFSET_MS);
  assert.ok(out.every((v) => v >= 0));
});

test('the offset is clamped to what the scheduler can still schedule ahead of time', () => {
  const { song, track } = kitSong(1);
  song.setTrackOffsetMs(track.id, -999);
  assert.equal(song.trackOffsetMs(track), -MAX_TRACK_OFFSET_MS);
  song.setTrackOffsetMs(track.id, 999);
  assert.equal(song.trackOffsetMs(track), MAX_TRACK_OFFSET_MS);
  song.setTrackOffsetMs(track.id, Number.NaN);
  assert.equal(song.trackOffsetMs(track), 0);
});

test('one part can be offset against another', () => {
  // The thing it is for: drums a touch behind the chords, both written on the same beat.
  setBpm(100);
  const { song, track: drums } = kitSong(0);
  song.addNote(drums.id, { midi: 36, start: 0.25, length: 1 / 64 });
  const chords = song.addTrack();
  song.setInstrument(chords.id, 'subtractive');
  song.addNote(chords.id, { midi: 60, start: 0.25, length: 1 / 8 });
  song.setTrackOffsetMs(drums.id, 15);
  const rows = [...songNotes(song)];
  const at = (id) => Math.round(rows.find((n) => n.track.id === id).start * 4 * 60 * 1000 / 100);
  assert.equal(at(chords.id), 600);
  assert.equal(at(drums.id), 615);
});
