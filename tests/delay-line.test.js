// The fractional ring buffer, and the saturator that has to keep a feedback loop bounded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DelayLine, MIN_DELAY_SAMPLES, softSaturate } from '../src/effects/delay-line.js';

test('an integer delay returns the sample written that many steps ago', () => {
  const line = new DelayLine(64);
  const seen = [];
  for (let i = 0; i < 32; i++) {
    // Read before write, which is the order a feedback path requires.
    seen.push(line.readAt(8));
    line.write(i + 1);
  }
  for (let i = 8; i < 32; i++) assert.equal(seen[i], i - 8 + 1, `step ${i}`);
});

test('a fractional delay interpolates between neighbours', () => {
  const line = new DelayLine(64);
  for (let i = 0; i < 32; i++) line.write(i);
  // Halfway between the samples at 4 and 5 back.
  const mid = line.readAt(4.5);
  assert.ok(Math.abs(mid - (line.readAt(4) + line.readAt(5)) / 2) < 1e-5, `read ${mid}`);
});

test('the read distance never collapses to zero', () => {
  // A read position that catches the write pointer is a loop with no delay in it.
  const line = new DelayLine(64);
  for (let i = 0; i < 32; i++) line.write(i);
  assert.ok(MIN_DELAY_SAMPLES >= 1);
  assert.equal(line.readAt(0), line.readAt(MIN_DELAY_SAMPLES));
});

test('reset empties the line', () => {
  const line = new DelayLine(64);
  for (let i = 0; i < 32; i++) line.write(1);
  line.reset();
  assert.equal(line.readAt(4), 0);
});

test('saturation can only ever take level away', () => {
  // The slope through zero is exactly 1 at every amount, so the shape cannot add gain and the loop
  // stays bounded by the feedback knob alone. This is the fix for a delay that self-oscillated.
  for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
    for (const x of [-1, -0.6, -0.2, 0.2, 0.6, 1]) {
      const y = softSaturate(x, amount);
      assert.ok(Math.abs(y) <= Math.abs(x) + 1e-9, `|f(${x})| grew at amount ${amount}: ${y}`);
    }
    // Slope through zero is unity regardless of amount.
    const h = 1e-6;
    const slope = (softSaturate(h, amount) - softSaturate(-h, amount)) / (2 * h);
    assert.ok(Math.abs(slope - 1) < 1e-4, `slope through zero was ${slope} at amount ${amount}`);
  }
});

test('at full amount a full-scale sample comes back as 0.44', () => {
  // Hard saturation is also quiet, which is what a tape loop driven hard actually does.
  assert.ok(Math.abs(softSaturate(1, 1) - 0.44) < 0.01, `read ${softSaturate(1, 1)}`);
});

test('amount 0 is the identity', () => {
  for (const x of [-1, -0.3, 0, 0.3, 1]) assert.equal(softSaturate(x, 0), x);
});
