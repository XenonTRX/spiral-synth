// Song time versus material time - the fold that two silent bugs came out of.
//
// These were unreachable from a test while they lived inside `createSong`. They are pure functions
// of one track, so now they are just arithmetic with names.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAT_EPSILON, fadeOf, repeatOffsets, sourceBeat, trackBegin, trackCovers,
  trackEnd, trackExtent, trackIsPinned, trackPasses, trackPeriod, trackSpan,
} from '../src/track-time.js';

// Four quarter notes: material that runs to one whole note.
const material = [
  { start: 0, length: 0.25 },
  { start: 0.25, length: 0.25 },
  { start: 0.5, length: 0.25 },
  { start: 0.75, length: 0.25 },
];
const part = (over = {}) => ({ notes: material, begin: 0, end: null, ...over });

test('an unarranged part is exactly as long as what is in it', () => {
  assert.equal(trackExtent(part()), 1);
  assert.equal(trackSpan(part()), 1);
  assert.equal(trackEnd(part()), 1);
});

test('an unset end is not an end of zero', () => {
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious reading of an optional end
  // makes every unarranged part a part of no length - which drops every note in it. This is that
  // bug, and it went in twice.
  for (const end of [null, undefined]) {
    const track = part({ end });
    assert.equal(trackIsPinned(track), false, `end: ${end} should not read as pinned`);
    assert.equal(trackSpan(track), 1, `end: ${end} collapsed the span`);
    assert.ok(trackSpan(track) > 0, `end: ${end} dropped every note`);
  }
});

test('an explicit end wins, and is measured from the beginning', () => {
  const track = part({ begin: 4, end: 6 });
  assert.equal(trackBegin(track), 4);
  assert.equal(trackSpan(track), 2);
  assert.equal(trackEnd(track), 6);
  assert.equal(trackIsPinned(track), true);
});

test('a negative or absent begin is zero rather than a negative offset', () => {
  assert.equal(trackBegin({ notes: [] }), 0);
  assert.equal(trackBegin({ notes: [], begin: -3 }), 0);
  assert.equal(trackBegin({ notes: [], begin: NaN }), 0);
});

test('a legacy repeat count resolves to a span', () => {
  // Old saves carry `repeat: N` and no region, resolved on demand rather than at load time so the
  // loader never has to know the bar length.
  const track = part({ end: null, legacyRepeat: 3 });
  assert.equal(trackIsPinned(track), true);
  assert.equal(trackSpan(track), trackPeriod(track) * 3);
});

test('a period is a whole number of bars', () => {
  // A repeat that came back a seventeenth of a bar early would be a mistake rather than a feature.
  const ragged = { notes: [{ start: 0, length: 0.3 }], begin: 0, end: null };
  const period = trackPeriod(ragged);
  assert.ok(period >= trackExtent(ragged), 'a period must contain the material');
  assert.equal(trackPeriod({ notes: [], begin: 0, end: null }), 0, 'empty material has no period');
});

test('sourceBeat folds song time onto the material', () => {
  const track = part({ begin: 4, end: 8 }); // enters at bar 2, four whole notes long
  // Inside the first pass, material time is song time less the offset.
  assert.ok(Math.abs(sourceBeat(track, 4) - 0) < BEAT_EPSILON);
  assert.ok(Math.abs(sourceBeat(track, 4.5) - 0.5) < BEAT_EPSILON);
  // Inside the second pass, it folds back onto the material rather than running past it.
  const period = trackPeriod(track);
  assert.ok(Math.abs(sourceBeat(track, 4 + period + 0.5) - 0.5) < BEAT_EPSILON);
});

test('past the region there is no pass to fold onto', () => {
  // Which is what lets you write notes beyond where a part stops, and hear them by moving its end.
  const track = part({ begin: 4, end: 6 });
  const beyond = sourceBeat(track, 10);
  assert.ok(Math.abs(beyond - 6) < BEAT_EPSILON, `read ${beyond}`);
});

test('a part with no begin folds the same way', () => {
  const track = part();
  assert.ok(Math.abs(sourceBeat(track, 0.5) - 0.5) < BEAT_EPSILON);
  assert.equal(sourceBeat(null, 3), 3);
});

test('coverage is half-open, so butted parts do not overlap', () => {
  const track = part({ begin: 4, end: 6 });
  assert.equal(trackCovers(track, 3.9), false);
  assert.equal(trackCovers(track, 4), true);
  assert.equal(trackCovers(track, 5.9), true);
  assert.equal(trackCovers(track, 6), false, 'a part has already stopped at its end');
});

test('passes are derived from the span, and the last one may be partial', () => {
  const track = part({ begin: 0, end: 2.5 });
  const period = trackPeriod(track);
  assert.equal(trackPasses(track), Math.max(1, Math.ceil(2.5 / period - BEAT_EPSILON)));
  assert.ok(trackPasses(part()) >= 1, 'a part always plays at least once');
});

test('repeat offsets start at the beginning and step by a period', () => {
  const track = part({ begin: 4, end: 7 });
  const offsets = repeatOffsets(track);
  assert.equal(offsets[0], 4);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(Math.abs(offsets[i] - offsets[i - 1] - trackPeriod(track)) < BEAT_EPSILON);
  }
  // Even a part with nothing in it gets one offset, so callers never see an empty list.
  assert.deepEqual(repeatOffsets({ notes: [], begin: 2, end: null }), [2]);
});

test('a fade is clamped to something the region can contain', () => {
  // A fade longer than the part is a number with no meaning, and the rack must not show a figure
  // the audio is not using.
  const track = part({ begin: 0, end: 2 });
  assert.equal(fadeOf(track, 'fadeIn'), 0, 'absent is zero');
  assert.equal(fadeOf({ ...track, fadeIn: 0.5 }, 'fadeIn'), 0.5);
  assert.equal(fadeOf({ ...track, fadeIn: 99 }, 'fadeIn'), 2, 'clamped to the span');
  assert.equal(fadeOf({ ...track, fadeIn: -1 }, 'fadeIn'), 0);
});
