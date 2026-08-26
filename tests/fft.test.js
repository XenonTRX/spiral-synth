import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, ifft } from '../src/fft.js';

const impulseAt = (n, k) => {
  const re = new Float64Array(n);
  re[k] = 1;
  return re;
};

test('forward then inverse returns the signal', () => {
  // The failure mode of a bad transform is a spectrum that looks plausible, so the round trip is
  // the assertion worth having.
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 5 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 17 * i) / n);
  const original = Float64Array.from(re);

  fft(re, im);
  ifft(re, im);

  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(re[i] - original[i]));
  assert.ok(worst < 1e-12, `worst round-trip error ${worst}`);
});

test('a pure bin transforms to a pure tone', () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 4 * i) / n);
  fft(re, im);

  const mag = (k) => Math.hypot(re[k], im[k]);
  assert.ok(mag(4) > n / 2 - 1e-6, `bin 4 read ${mag(4)}`);
  for (let k = 0; k < n / 2; k++) {
    if (k === 4) continue;
    assert.ok(mag(k) < 1e-9, `bin ${k} should be empty, read ${mag(k)}`);
  }
});

test('an impulse is flat', () => {
  const n = 128;
  const re = impulseAt(n, 0);
  const im = new Float64Array(n);
  fft(re, im);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(Math.hypot(re[k], im[k]) - 1) < 1e-12, `bin ${k} was not unity`);
  }
});
