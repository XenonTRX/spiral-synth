// The drive curve's two promises: it is normalised so the knob is a timbre control rather than a
// volume, and it never answers a constant to silence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS, CURVE_POINTS, buildDriveCurve, readCurve, sineRms } from '../src/effects/drive-curve.js';
import { gainToDb } from '../src/decibels.js';

const characters = Object.keys(CHARACTERS);

test('every character normalises a full-scale sine to unity', () => {
  // "A full-scale sine in comes out at the level it went in at, which is the level a mix is balanced
  // by, so turning the knob changes the timbre and leaves the balance alone."
  for (const character of characters) {
    for (const driveDb of [0, 6, 9, 18, 24, 30]) {
      const curve = buildDriveCurve({ character, driveDb });
      const rms = sineRms(curve);
      assert.ok(
        Math.abs(gainToDb(rms / Math.SQRT1_2)) < 0.05,
        `${character} at ${driveDb} dB read ${gainToDb(rms / Math.SQRT1_2).toFixed(3)} dB off unity`,
      );
    }
  }
});

test('silence in, silence out, at any bias', () => {
  // A shaper that answers a constant to an input of zero thumps every time it is switched in, and a
  // DC blocker downstream cannot undo a step it has already passed.
  for (const character of characters) {
    for (const bias of [-0.5, -0.2, 0, 0.2, 0.5]) {
      const curve = buildDriveCurve({ character, driveDb: 12, bias });
      assert.ok(
        Math.abs(readCurve(curve, 0)) < 1e-6,
        `${character} at bias ${bias} answered ${readCurve(curve, 0)} to zero`,
      );
    }
  }
});

test('quieter material still gets louder - that is saturation, not a flaw', () => {
  // Measured at 9 dB of Tape: a full-scale sine comes out at -0.0 dB and a -20 dBFS one at +7.0.
  // At 24 dB the same pair reads 0.0 and +17.5.
  const quietGain = 10 ** (-20 / 20);
  const rmsOf = (curve, amp) => {
    const n = 4096;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += readCurve(curve, amp * Math.sin((2 * Math.PI * i) / n)) ** 2;
    return Math.sqrt(sum / n);
  };

  for (const [driveDb, expected] of [[9, 7.0], [24, 17.5]]) {
    const curve = buildDriveCurve({ character: 'tape', driveDb });
    const loud = gainToDb(rmsOf(curve, 1) / Math.SQRT1_2);
    const quiet = gainToDb(rmsOf(curve, quietGain) / (Math.SQRT1_2 * quietGain));
    assert.ok(Math.abs(loud) < 0.1, `full scale at ${driveDb} dB read ${loud.toFixed(1)} dB`);
    assert.ok(
      Math.abs(quiet - expected) < 0.6,
      `-20 dBFS at ${driveDb} dB read +${quiet.toFixed(1)} dB, expected +${expected}`,
    );
  }
});

test('mix at 0 is the identity', () => {
  const curve = buildDriveCurve({ character: 'tape', driveDb: 24, mix: 0 });
  for (const x of [-1, -0.5, -0.1, 0, 0.1, 0.5, 1]) {
    assert.ok(Math.abs(readCurve(curve, x) - x) < 1e-3, `dry curve bent ${x} to ${readCurve(curve, x)}`);
  }
});

test('the shaping curves are monotonic, and the wavefolder is not', () => {
  // A clipper shapes: the output never turns round, so loud stays louder than quiet. `fold` is the
  // deliberate exception - "past the peak the output turns round and comes back" is what a
  // wavefolder is, and it is why it aliases so much harder than the others.
  for (const character of characters.filter((c) => c !== 'fold')) {
    const curve = buildDriveCurve({ character, driveDb: 18 });
    for (let i = 1; i < CURVE_POINTS; i++) {
      assert.ok(curve[i] >= curve[i - 1] - 1e-7, `${character} folded back at point ${i}`);
    }
  }

  const folded = buildDriveCurve({ character: 'fold', driveDb: 18 });
  const turnsRound = Array.from({ length: CURVE_POINTS - 1 }, (_, i) => folded[i + 1] < folded[i] - 1e-7).some(Boolean);
  assert.ok(turnsRound, 'fold should turn round past the peak');
});
