// The plucked string: is it in tune, does it stop when it says it will, and does the pick do
// anything.
//
// These are the claims instruments/pluck-dsp.js and string-dsp.js make in prose, and each of them
// was a bug first. The tuning one is why the loop filter is a one-zero; the decay one is why the
// loss is split rather than set in two places; the pick one is the difference between a comb filter
// and a comment claiming there is one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPluckEngine } from '../src/instruments/pluck-dsp.js';
import { SR, cents, decayRate, harmonicDb, peak, peakNear, renderNote } from './string-helpers.js';

const NOTES = [
  ['C1', 32.703],
  ['C2', 65.406],
  ['A2', 110],
  ['A3', 220],
  ['A4', 440],
  ['C6', 1046.5],
  ['C7', 2093],
];

test('a plucked string sounds the note it was asked for, within a cent, over six octaves', () => {
  for (const [name, freq] of NOTES) {
    const out = renderNote(createPluckEngine(SR), { freq, seconds: 2 });
    const measured = peakNear(out, freq, Math.round(0.12 * SR));
    assert.ok(
      Math.abs(cents(measured, freq)) < 1,
      `${name}: ${measured.toFixed(3)}Hz is ${cents(measured, freq).toFixed(2)} cents off ${freq}`,
    );
  }
});

test('the damping control does not retune the string', () => {
  // The whole reason the loop filter is a one-zero rather than the one-pole everything else here
  // uses: a one-zero's phase delay is exactly its coefficient in samples, whatever that coefficient
  // is, so the string can subtract it and stay in tune while the knob moves. A one-pole would have
  // pulled the pitch by about a quarter tone across this range.
  const measure = (damping) => {
    const engine = createPluckEngine(SR);
    engine.setParams({ damping });
    return peakNear(renderNote(engine, { freq: 220, seconds: 2 }), 220, Math.round(0.12 * SR));
  };
  const bright = measure(0);
  for (const damping of [0.1, 0.25, 0.4, 0.5]) {
    assert.ok(
      Math.abs(cents(measure(damping), bright)) < 0.5,
      `damping ${damping} moved the pitch by ${cents(measure(damping), bright).toFixed(2)} cents`,
    );
  }
});

test('the fundamental decays at the rate the Decay knob asks for, whatever the damping', () => {
  // The bug this pins down: the loop filter is applied once per round trip, so its loss compounds
  // with pitch, and at the default damping it was costing 95dB a second at the top C - which meant
  // the Decay knob was being quietly overruled by a filter nobody thought of as a loss. The
  // fundamental's rate now comes out of the knob alone.
  //
  // 24dB/s is what a 3.4s decay comes to at A3 once the tilt is applied: the knob is quoted at
  // 110Hz, and an A3 an octave above that rings (110/220)^0.45 as long, which is 2.49s.
  for (const damping of [0, 0.2, 0.5]) {
    const engine = createPluckEngine(SR);
    engine.setParams({ damping });
    const out = renderNote(engine, { freq: 220, seconds: 3 });
    const rate = decayRate(out, 220, 0.15, 1);
    assert.ok(Math.abs(rate - 24) < 2, `damping ${damping}: fundamental decayed at ${rate.toFixed(1)}dB/s, wanted 24`);
  }
});

test('damping makes the harmonics die faster than the fundamental, and only them', () => {
  const rates = (damping) => {
    const engine = createPluckEngine(SR);
    engine.setParams({ damping });
    const out = renderNote(engine, { freq: 220, seconds: 3 });
    return { h1: decayRate(out, 220, 0.15, 1), h8: decayRate(out, 1760, 0.15, 0.4) };
  };
  const flat = rates(0);
  const damped = rates(0.5);
  // At zero the whole spectrum decays together, which is a bell rather than a string.
  assert.ok(Math.abs(flat.h8 - flat.h1) < 3, `undamped: h8 ${flat.h8.toFixed(1)} vs h1 ${flat.h1.toFixed(1)}`);
  assert.ok(damped.h8 > damped.h1 + 10, `damped: h8 ${damped.h8.toFixed(1)} should outrun h1 ${damped.h1.toFixed(1)}`);
  assert.ok(Math.abs(damped.h1 - flat.h1) < 2, 'the fundamental should not care');
});

test('the pick position puts a notch where it says it does', () => {
  // A pick cannot excite a harmonic with a node under it, so picking at exactly half way should take
  // the even harmonics out. This is the comb filter in the excitation path, and it is the difference
  // between "pick position" being a distance and being a tone control with a suggestive name.
  const engine = createPluckEngine(SR);
  engine.setParams({ pluckPosition: 0.5, pickHardness: 1 });
  const out = renderNote(engine, { freq: 220, seconds: 1 });
  const at = 0.05;
  const odd = harmonicDb(out, 220, at);
  const even = harmonicDb(out, 440, at);
  assert.ok(even < odd - 20, `picked at the halfway point, h2 (${even.toFixed(1)}dB) should be far under h1 (${odd.toFixed(1)}dB)`);

  const near = createPluckEngine(SR);
  near.setParams({ pluckPosition: 0.02, pickHardness: 1 });
  const bridge = renderNote(near, { freq: 220, seconds: 1 });
  assert.ok(
    harmonicDb(bridge, 440, at) > harmonicDb(bridge, 220, at) - 12,
    'picked by the bridge, nothing should be missing',
  );
});

test('the partials are harmonics — which is what makes the scope’s headline number mean anything', () => {
  const out = renderNote(createPluckEngine(SR), { freq: 220, seconds: 2 });
  for (let n = 2; n <= 8; n++) {
    const measured = peakNear(out, n * 220, Math.round(0.12 * SR));
    assert.ok(
      Math.abs(cents(measured, n * 220)) < 3,
      `harmonic ${n}: ${measured.toFixed(1)}Hz is ${cents(measured, n * 220).toFixed(2)} cents off`,
    );
  }
});

test('a released string is damped rather than faded, and then the voice is freed', () => {
  const engine = createPluckEngine(SR);
  engine.setParams({ release: 0.08, decay: 8 });
  const out = renderNote(engine, { freq: 220, seconds: 2, releaseAt: 0.5 });
  // Ringing before, gone after, and the pool has the slot back - the last of which is the thing that
  // stops a long decay from eating every voice.
  assert.ok(peak(out, Math.round(0.4 * SR), Math.round(0.5 * SR)) > 0.01);
  assert.ok(peak(out, Math.round(1.2 * SR), out.length) < 1e-4);
  assert.equal(engine.sounding(), 0);
});

test('harder plucks are brighter, not just louder', () => {
  const spectrum = (velocity) => {
    const out = renderNote(createPluckEngine(SR), { freq: 220, velocity, seconds: 1 });
    return harmonicDb(out, 1760, 0.03) - harmonicDb(out, 220, 0.03);
  };
  assert.ok(spectrum(1) > spectrum(0.2) + 2, 'the eighth harmonic should be relatively stronger at full velocity');
});

test('nothing ever leaves the string that is not a finite number', () => {
  // A feedback loop with a nonlinearity nowhere in it still has two ways to blow up: a gain at or
  // above unity, and a delay length that collapses. Both clamps are in the model; this is the check
  // that the extremes of every knob stay on the right side of them.
  for (const state of [
    { damping: 0, decay: 12, decayTilt: 0, release: 2 },
    { damping: 0.5, decay: 0.2, decayTilt: 1, release: 0.02 },
    { pluckPosition: 0.02, pickHardness: 1, body: 1, bodySize: 0.4 },
    { pluckPosition: 0.5, pickHardness: 0, body: 1, bodySize: 2.5 },
  ]) {
    for (const freq of [32.703, 2093]) {
      const engine = createPluckEngine(SR);
      engine.setParams(state);
      const out = renderNote(engine, { freq, seconds: 2, releaseAt: 1 });
      assert.ok(out.every(Number.isFinite), `${JSON.stringify(state)} at ${freq}Hz produced a non-finite sample`);
      assert.ok(peak(out) < 4, `${JSON.stringify(state)} at ${freq}Hz peaked at ${peak(out).toFixed(2)}`);
    }
  }
});
