// The bowed string: does the stick-slip loop actually oscillate, at the note it was asked for, and
// does it stay bounded when the bow is pushed past what a bow can do.
//
// The first of those is the whole question about this model. There is no oscillator in it - the pitch
// is a consequence of a friction curve and two delay lines - so "it makes a note" is a claim that can
// fail, and it fails silently: a friction curve that is slightly too shallow gives a string that is
// dragged to one side and stays there, which is not a wrong note, it is no note at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBowEngine } from '../src/instruments/bow-dsp.js';
import { bowFriction } from '../src/instruments/string-dsp.js';
import { SR, cents, dbOf, harmonicDb, peak, peakNear, renderNote, rms } from './string-helpers.js';

test('the friction curve grips hardest when nothing is sliding, and lets go', () => {
  // The shape is the instrument. Flat-topped through zero relative velocity - the bow and the string
  // moving together - and then a steep fall, which is the moment the note is made.
  assert.equal(bowFriction(0, 3), 1);
  assert.ok(bowFriction(0.05, 3) > 0.5, 'still gripping at a small difference');
  assert.ok(bowFriction(0.5, 3) < 0.05, 'let go by a large one');
  // Symmetric: a bow drawn the other way is the same bow.
  assert.ok(Math.abs(bowFriction(0.2, 3) - bowFriction(-0.2, 3)) < 0.01);
  // Never a gain, at any pressure - which is what keeps the loop bounded without a limiter in it.
  for (const slope of [0.5, 1, 3, 8]) {
    for (const v of [-2, -0.3, 0, 0.3, 2]) {
      const f = bowFriction(v, slope);
      assert.ok(f >= 0 && f <= 1, `friction ${f} out of range at v=${v}, slope=${slope}`);
    }
  }
});

test('a bowed string oscillates at the note it was asked for', () => {
  for (const [name, freq] of [['G3', 196], ['C4', 261.626], ['A4', 440], ['C5', 523.25], ['C6', 1046.5]]) {
    const out = renderNote(createBowEngine(SR), { freq, seconds: 2 });
    const measured = peakNear(out, freq, Math.round(1.2 * SR));
    assert.ok(
      Math.abs(cents(measured, freq)) < 5,
      `${name}: ${measured.toFixed(2)}Hz is ${cents(measured, freq).toFixed(2)} cents off ${freq}`,
    );
  }
});

test('the fundamental is the strongest partial at the default bow position', () => {
  // Which is the thing a bowed model gets wrong loudly: the string can settle into a higher mode and
  // sound a note nobody asked for. See BOW_DEFAULTS for the sweep these numbers came from.
  for (const freq of [196, 440, 1046.5]) {
    const out = renderNote(createBowEngine(SR), { freq, seconds: 2 });
    const first = harmonicDb(out, freq, 1.2);
    for (let n = 2; n <= 5; n++) {
      assert.ok(
        harmonicDb(out, n * freq, 1.2) < first,
        `at ${freq}Hz, harmonic ${n} came out above the fundamental`,
      );
    }
  }
});

test('it sustains for as long as it is bowed, rather than decaying', () => {
  // The one instrument here whose note does not stop on its own. Level at half a second and at a
  // second and a half should be the same, which is not true of anything else in this project.
  const out = renderNote(createBowEngine(SR), { freq: 440, seconds: 2.5 });
  const early = dbOf(rms(out, Math.round(0.5 * SR), Math.round(0.7 * SR)));
  const late = dbOf(rms(out, Math.round(1.8 * SR), Math.round(2 * SR)));
  assert.ok(Math.abs(early - late) < 3, `held note drifted ${(late - early).toFixed(1)}dB`);
});

test('the note takes time to speak, and it is longer than the bow ramp', () => {
  // The stick-slip cycle needs several trips along the string to establish, so the sound arrives
  // after the arm does. That gap is the thing bowed instruments have and envelopes do not.
  const engine = createBowEngine(SR);
  engine.setParams({ attack: 0.02 });
  const out = renderNote(engine, { freq: 440, seconds: 1 });
  const full = rms(out, Math.round(0.6 * SR), Math.round(0.8 * SR));
  assert.ok(rms(out, 0, Math.round(0.02 * SR)) < full * 0.5, 'not up to speed while the bow still is');
  assert.ok(rms(out, Math.round(0.3 * SR), Math.round(0.5 * SR)) > full * 0.5, 'and there by a third of a second');
});

test('lifting the bow stops the note, and frees the voice', () => {
  const engine = createBowEngine(SR);
  engine.setParams({ release: 0.1 });
  const out = renderNote(engine, { freq: 440, seconds: 2, releaseAt: 0.9 });
  assert.ok(peak(out, Math.round(0.7 * SR), Math.round(0.9 * SR)) > 0.02);
  assert.ok(peak(out, Math.round(1.5 * SR), out.length) < 1e-4);
  assert.equal(engine.sounding(), 0);
});

test('bowing harder past the point where it works breaks the tone rather than the model', () => {
  // Over-pressure is real - it is what pressing too hard on a violin does - so the model is allowed
  // to do it. What it is not allowed to do is diverge, and a friction curve that can only ever take
  // energy away is why it cannot.
  for (const state of [
    { bowPressure: 8, bowSpeed: 0.6, bowPosition: 0.05, damping: 0 },
    { bowPressure: 0.5, bowSpeed: 0.6, bowPosition: 0.3, damping: 0.5 },
    { bowPressure: 8, bowSpeed: 0.02, bowPosition: 0.3, noise: 1, body: 1 },
  ]) {
    for (const freq of [65.406, 440, 2093]) {
      const engine = createBowEngine(SR);
      engine.setParams(state);
      const out = renderNote(engine, { freq, seconds: 2, releaseAt: 1.4 });
      assert.ok(out.every(Number.isFinite), `${JSON.stringify(state)} at ${freq}Hz produced a non-finite sample`);
      assert.ok(peak(out) < 4, `${JSON.stringify(state)} at ${freq}Hz peaked at ${peak(out).toFixed(2)}`);
    }
  }
});

test('bowing nearer the bridge takes the fundamental away', () => {
  // Sul ponticello, and the reason the bow position is not a filter: it splits the string into two
  // unequal halves, and a very short one reinforces the upper modes until the whole string stops
  // moving as one.
  const at = (bowPosition) => {
    const engine = createBowEngine(SR);
    engine.setParams({ bowPosition, bowPressure: 3.4 });
    const out = renderNote(engine, { freq: 440, seconds: 2 });
    return harmonicDb(out, 440, 1.2) - harmonicDb(out, 1320, 1.2);
  };
  assert.ok(at(0.05) < at(0.13) - 10, 'the fundamental should lose ground to the third harmonic by the bridge');
});
