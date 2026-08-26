// The gain computer, which is the half of a compressor that can be checked without listening.

import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPRESSOR_DEFAULTS, Compressor } from '../src/effects/compressor-dsp.js';

const SR = 44100;
const make = (options) => new Compressor(SR, { ...COMPRESSOR_DEFAULTS, ...options });

test('below the knee nothing is touched', () => {
  const comp = make({ thresholdDb: -18, ratio: 4, kneeDb: 6 });
  // The knee spans 6 dB centred on the threshold, so -21 and below is untouched. The lower edge
  // lands on exactly -0, which is 0 to every reader except Object.is - hence the tolerance.
  for (const level of [-60, -40, -25, -21]) {
    assert.ok(Math.abs(comp.reductionFor(level)) === 0, `${level} dB should be untouched`);
  }
});

test('above the knee the ratio is exactly the ratio', () => {
  const comp = make({ thresholdDb: -18, ratio: 4, kneeDb: 6 });
  // 4:1 means 4 dB in over threshold becomes 1 dB out, so 3 of every 4 are removed.
  const at = (level) => level + comp.reductionFor(level);
  const outA = at(-6); // 12 dB over
  const outB = at(-2); // 16 dB over
  assert.ok(Math.abs((outB - outA) - 1) < 1e-9, `4 dB in moved the output by ${(outB - outA).toFixed(4)} dB`);
});

test('the knee is continuous and smooth through the threshold', () => {
  const comp = make({ thresholdDb: -18, ratio: 4, kneeDb: 6 });
  let previous = comp.reductionFor(-30);
  for (let level = -30; level <= 0; level += 0.05) {
    const value = comp.reductionFor(level);
    assert.ok(value <= previous + 1e-9, `reduction increased at ${level.toFixed(2)} dB`);
    assert.ok(Math.abs(value - previous) < 0.05, `a step at ${level.toFixed(2)} dB: ${previous} -> ${value}`);
    previous = value;
  }
});

test('a hard knee is the textbook corner', () => {
  const comp = make({ thresholdDb: -20, ratio: 2, kneeDb: 0 });
  assert.equal(comp.reductionFor(-21), 0);
  assert.equal(comp.reductionFor(-20), 0);
  // 10 dB over at 2:1 removes 5.
  assert.ok(Math.abs(comp.reductionFor(-10) + 5) < 1e-9, `read ${comp.reductionFor(-10)}`);
});

test('a ratio of 1 is a bypass at every level', () => {
  const comp = make({ ratio: 1, kneeDb: 6 });
  for (const level of [-40, -18, -6, 0]) {
    assert.ok(Math.abs(comp.reductionFor(level)) < 1e-12, `${level} dB was touched`);
  }
});

test('ratio is clamped to at least 1, so a knob cannot invert the curve', () => {
  const comp = make({ ratio: 0.2 });
  assert.equal(comp.ratio, 1);
});

test('attack is one time constant, so 10-to-90 is ln(9) of them', () => {
  // A 10 ms attack covers 10% to 90% in 22.0 ms. The two conventions differ by more than a factor
  // of two and every manufacturer picks one silently, so it is worth pinning down.
  const expected = 10 * Math.log(9);
  assert.ok(Math.abs(expected - 22.0) < 0.05, `ln(9) time constants is ${expected.toFixed(2)} ms`);
});
