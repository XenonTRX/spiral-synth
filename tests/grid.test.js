// Where the lane's cells sit, and what its step resolves to.
//
// The claims are the two grid.js makes in prose about the step lane: that a cell's bar and beat
// marking is read off its own time rather than counted, so it cannot drift on a step that does not
// divide the bar; and that the step follows snap until it is told not to.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANE_STEP_CHOICES,
  MAX_SWING,
  SWING_STRAIGHT,
  getSwing,
  laneStepBeats,
  setSnapId,
  setSwing,
  stepMark,
  swungStart,
  trackLaneStepId,
} from '../src/grid.js';

/** The marks a strip of `count` cells gets, as one string per cell: B bar, b beat, . neither. */
function strip(count, step, bar, pulse) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const mark = stepMark(i * step, bar, pulse);
    out.push(mark === 'bar' ? 'B' : mark === 'beat' ? 'b' : '.');
  }
  return out.join('');
}

// 4/4 is one whole note to the bar here, and a quarter note to the beat.
const BAR_4_4 = 1;
const BEAT = 1 / 4;

test('a 1/16 lane in 4/4 marks every bar and every beat', () => {
  assert.equal(strip(17, 1 / 16, BAR_4_4, BEAT), 'B...b...b...b...B');
});

test('a triplet lane lands its bar lines on the bars', () => {
  // The case counting gets wrong: a 1/8T step is not a binary fraction, so twelve of them summing
  // to exactly one bar is a claim about floating point as much as about music.
  assert.equal(strip(13, 1 / 12, BAR_4_4, BEAT), 'B..b..b..b..B');
});

test('and it stays on them over a long strip, where drift would show', () => {
  const long = strip(12 * 16 + 1, 1 / 12, BAR_4_4, BEAT);
  for (let i = 0; i <= 12 * 16; i++) {
    const expected = i % 12 === 0 ? 'B' : i % 3 === 0 ? 'b' : '.';
    assert.equal(long[i], expected, `cell ${i}`);
  }
});

test('a bar the step does not divide still gets its lines in the right places', () => {
  // 5/8 is five eighths to the bar, so a 1/8T cell is 7.5 to the bar: the ratio the old
  // count-every-nth-cell rule had to round, and rounding walks the lines off the bars.
  const bar = 5 / 8;
  assert.equal(stepMark(0, bar, 0), 'bar');
  assert.equal(stepMark(bar, bar, 0), 'bar');
  assert.equal(stepMark(2 * bar, bar, 0), 'bar');
  // 7 cells in is 7/12, which is not a bar line, and 7.5 would have been called one.
  assert.equal(stepMark(7 / 12, bar, 0), '');
});

test('a pulse of zero is how a coarse lane says not to mark beats', () => {
  // At a 1/4 step every cell is a beat, and marking all of them says nothing.
  assert.equal(strip(5, 1 / 4, BAR_4_4, 0), 'B...B');
  assert.equal(strip(5, 1 / 4, BAR_4_4, BEAT), 'BbbbB');
});

test('a part follows snap until it is given a scale of its own', () => {
  const track = { laneStep: 'snap' };
  setSnapId('eighth');
  assert.equal(laneStepBeats(track), 1 / 8);
  setSnapId('sixteenth');
  assert.equal(laneStepBeats(track), 1 / 16);
});

test('and once given one, it ignores snap', () => {
  const track = { laneStep: 'eighth' };
  setSnapId('thirtysecond');
  assert.equal(laneStepBeats(track), 1 / 8);
  assert.equal(trackLaneStepId(track), 'eighth');
});

test('two parts can be on different scales at once', () => {
  // The whole reason the setting stopped being global: one step size can only describe one part.
  setSnapId('sixteenth');
  assert.equal(laneStepBeats({ laneStep: 'thirtysecond' }), 1 / 32);
  assert.equal(laneStepBeats({ laneStep: 'eighth' }), 1 / 8);
});

test('Snap Off leaves a following part on a 1/4 rather than on a step of nothing', () => {
  setSnapId('off');
  assert.equal(laneStepBeats({ laneStep: 'snap' }), 1 / 4);
  setSnapId('sixteenth');
});

test('every choice but Snap names a size, and none of them is zero', () => {
  for (const choice of LANE_STEP_CHOICES) {
    if (choice.id === 'snap') continue;
    assert.ok(choice.beats > 0, `${choice.id} has a size`);
  }
  assert.equal(LANE_STEP_CHOICES[0].id, 'snap', 'Snap is the default, so it is first');
});

test('a part naming a scale this build has never heard of reads as following snap', () => {
  // The same repair every other named choice here gets, rather than a part with no step at all.
  for (const bad of ['nonesuch', '', null, undefined, 7]) {
    assert.equal(trackLaneStepId({ laneStep: bad }), 'snap', `${String(bad)} repairs to snap`);
  }
  assert.equal(trackLaneStepId(undefined), 'snap', 'and so does no part at all');
});

// --- swing --------------------------------------------------------------------------------------
//
// The claims grid.js makes about it: straight is straight, two thirds is a triplet feel, only odd
// steps move and only ever later, a ratchet moves as a unit, and the whole thing is computed from the
// straight position so it can be applied and re-applied without drifting.

const STEP = 1 / 16;
const near = (a, b) => Math.abs(a - b) < 1e-12;

test('straight is the identity, at every position', () => {
  for (let i = 0; i < 16; i++) {
    assert.equal(swungStart(i * STEP, STEP, SWING_STRAIGHT), i * STEP);
  }
});

test('two thirds is a triplet feel: the odd sixteenth lands on a 1/12', () => {
  // The pair spans a 1/8 and divides into three, so the second hit is 2/24 = 1/12. This is the one
  // number that makes the percentage mean something.
  assert.ok(near(swungStart(STEP, STEP, 2 / 3), 1 / 12));
  assert.ok(near(swungStart(3 * STEP, STEP, 2 / 3), 1 / 12 + 1 / 8));
});

test('only odd steps move', () => {
  for (let i = 0; i < 16; i += 2) {
    assert.equal(swungStart(i * STEP, STEP, MAX_SWING), i * STEP, `step ${i} stayed`);
  }
  for (let i = 1; i < 16; i += 2) {
    assert.ok(swungStart(i * STEP, STEP, MAX_SWING) > i * STEP, `step ${i} moved`);
  }
});

test('and only ever later — which is what makes it safe after a window has been filtered', () => {
  for (let i = 0; i < 32; i++) {
    for (const amount of [0.5, 0.55, 2 / 3, 0.7, MAX_SWING]) {
      assert.ok(swungStart(i * STEP, STEP, amount) >= i * STEP);
    }
  }
});

test('the ceiling puts the off-beat exactly halfway to the next step', () => {
  assert.ok(near(swungStart(STEP, STEP, MAX_SWING), STEP + STEP / 2));
});

test('a ratchet inside one step moves as a unit and keeps its spacing', () => {
  // Three hits written in step 1, at the step's own thirds. All three belong to step 1, so all three
  // take its shift - rounding to the nearest step instead would hand the later two step 2's shift
  // (which is none) and tear the figure apart.
  const hits = [0, 1 / 3, 2 / 3].map((f) => STEP + f * STEP);
  const swung = hits.map((h) => swungStart(h, STEP, 2 / 3));
  const shift = swung[0] - hits[0];
  assert.ok(shift > 0);
  for (const [i, hit] of hits.entries()) {
    assert.ok(near(swung[i] - hit, shift), `hit ${i} took the same shift`);
  }
});

test('a hit exactly on a line is in that step, not the one before it', () => {
  // Sums of thirds and sixteenths land a hair either side of a line, and a bare floor would put such
  // a note in the previous step - which for an odd step is the difference between moving and not.
  const onTheLine = 3 * (1 / 48) + 3 * (1 / 48); // 1/8, reached the awkward way
  assert.ok(near(onTheLine, 1 / 8));
  // 1/8 is step 2 of a 1/16 grid, which is even, so it must not move.
  assert.equal(swungStart(onTheLine, STEP, MAX_SWING), onTheLine);
});

test('a step of nothing is left alone rather than dividing by it', () => {
  assert.equal(swungStart(0.25, 0, 2 / 3), 0.25);
});

test('the setting is clamped to the range the slider offers', () => {
  setSwing(0.2);
  assert.equal(getSwing(), SWING_STRAIGHT);
  setSwing(5);
  assert.equal(getSwing(), MAX_SWING);
  setSwing(2 / 3);
  assert.ok(near(getSwing(), 2 / 3));
  setSwing(SWING_STRAIGHT);
});
