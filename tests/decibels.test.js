import test from 'node:test';
import assert from 'node:assert/strict';
import { dbLabel, dbToGain, dbfs, gainToDb } from '../src/decibels.js';

test('gain and dB are inverses', () => {
  for (const db of [-60, -24, -12, -6, -3, 0, 3.5, 6]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9, `${db} dB did not round-trip`);
  }
});

test('unity is 0 dB, and half power is -6', () => {
  assert.equal(gainToDb(1), 0);
  assert.ok(Math.abs(gainToDb(0.5) + 6.0206) < 1e-3);
});

test('silence is a real answer rather than -Infinity', () => {
  // Clamped only far enough to keep -Infinity out of a readout.
  assert.ok(Number.isFinite(gainToDb(0)));
  assert.ok(gainToDb(0) < -200);
  assert.equal(dbfs(0), 'silent');
});

test('a control label carries its sign', () => {
  // The plus is not decoration: a part Level goes above unity, so "1.4 dB" without it reads as an
  // absolute level rather than as a boost.
  assert.equal(dbLabel(1.4), '+1.4 dB');
  assert.equal(dbLabel(0), '0.0 dB');
  assert.equal(dbLabel(-3.25), '−3.3 dB'); // a true minus sign, not a hyphen
  assert.equal(dbLabel(-Infinity), '−∞ dB');
});
