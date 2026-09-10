// The piano: are its partials where the arithmetic says, do they decay at their own rates, and does
// the hammer position do what it claims.
//
// Everything worth checking about this instrument is a statement about partials, which is also the
// whole of its design - so unlike the two waveguides, where the tests are about tuning and stability,
// these are about the spectrum. In particular the inharmonicity is worth pinning down twice: once as
// a measurement of the sound, and once as agreement between the sound and what instruments/piano.js
// *declares* to the analyser, because a scope told the wrong partial positions reports a correct
// piano as broken.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PIANO_DEFAULTS, createPianoEngine } from '../src/instruments/piano-dsp.js';
import { SR, cents, decayRate, harmonicDb, peak, peakNear, renderNote } from './string-helpers.js';

const C4 = 261.626;

/** Where the model says partial `n` of `f0` sits. The same expression the voice and the scope use. */
function stretched(f0, n, amount = 1) {
  const B = 1e-4 * (f0 / 261.626) ** 1.5 * amount;
  return n * f0 * Math.sqrt(1 + B * n * n);
}

test('the partials are progressively sharp of the harmonic series', () => {
  // The single thing that most makes a piano sound like a piano, and the reason pianos are tuned
  // stretched. These are the numbers quoted in instruments/piano.js.
  const out = renderNote(createPianoEngine(SR), { freq: C4, midi: 60, seconds: 3 });
  const off = [];
  for (const n of [1, 4, 8, 12, 16]) {
    const measured = peakNear(out, stretched(C4, n), Math.round(0.1 * SR), 32768);
    off.push({ n, cents: cents(measured, n * C4) });
  }
  // Sharp, and increasingly so - a monotone climb rather than a constant offset, which is what
  // distinguishes stiffness from mistuning.
  for (let i = 1; i < off.length; i++) {
    assert.ok(off[i].cents > off[i - 1].cents, `partial ${off[i].n} should be sharper than ${off[i - 1].n}`);
  }
  assert.ok(Math.abs(off[0].cents) < 3, `the fundamental should be on the note, was ${off[0].cents.toFixed(1)} cents`);
  const top = off[off.length - 1];
  assert.ok(top.cents > 15 && top.cents < 26, `the 16th partial should be about 20 cents sharp, was ${top.cents.toFixed(1)}`);
});

test('turning inharmonicity off makes it a harmonic series', () => {
  const engine = createPianoEngine(SR);
  engine.setParams({ inharmonic: 0, detune: 0 });
  const out = renderNote(engine, { freq: C4, midi: 60, seconds: 3 });
  for (const n of [4, 8, 16]) {
    const measured = peakNear(out, n * C4, Math.round(0.1 * SR), 32768);
    assert.ok(Math.abs(cents(measured, n * C4)) < 3, `partial ${n} is ${cents(measured, n * C4).toFixed(1)} cents off`);
  }
});

test('what the scope is told matches what the voice does', () => {
  // Two copies of an inharmonicity formula that drift apart is a scope reporting a fault that is not
  // there, so the declaration is checked against the sound rather than against itself.
  const engine = createPianoEngine(SR);
  engine.setParams({ detune: 0 });
  const out = renderNote(engine, { freq: C4, midi: 60, seconds: 3 });
  for (const n of [2, 6, 10, 14]) {
    const declared = stretched(C4, n, PIANO_DEFAULTS.inharmonic);
    const measured = peakNear(out, declared, Math.round(0.1 * SR), 32768);
    assert.ok(
      Math.abs(cents(measured, declared)) < 2,
      `partial ${n}: declared ${declared.toFixed(1)}Hz, measured ${measured.toFixed(1)}Hz`,
    );
  }
});

test('high partials die faster than low ones, by however much the tilt says', () => {
  // What turns a clang into a sine over the first second, and what a single envelope cannot do.
  //
  // Measured with the unison detune off, deliberately: the two strings of a partial beat at twelve
  // times the rate at the twelfth partial as at the first, so a level read half a second apart is
  // read at a different point of the beat and the rate comes out wrong by a few dB. The tilt is what
  // is being measured here, and the beating is measured on its own further down.
  const ratio = (decayTilt) => {
    const engine = createPianoEngine(SR);
    engine.setParams({ decayTilt, detune: 0 });
    const out = renderNote(engine, { freq: C4, midi: 60, seconds: 4 });
    return decayRate(out, stretched(C4, 12), 0.1, 0.6) / decayRate(out, C4, 0.1, 1.5);
  };
  // At zero the whole spectrum decays together, which is a struck bar rather than a piano string.
  assert.ok(Math.abs(ratio(0) - 1) < 0.15, `tilt 0 gave a ratio of ${ratio(0).toFixed(2)}`);
  assert.ok(ratio(PIANO_DEFAULTS.decayTilt) > 3, `the default tilt gave only ${ratio(PIANO_DEFAULTS.decayTilt).toFixed(2)}`);
  assert.ok(ratio(1.5) > ratio(0.6), 'and more tilt should mean more of it');
});

test('the hammer position leaves a notch at the partial it sits on', () => {
  // A hammer at a nodal point of the eighth partial cannot excite it. This is the specific hollowness
  // of a piano's low register, and it is a position rather than a filter.
  const engine = createPianoEngine(SR);
  engine.setParams({ hammer: 0.125, detune: 0, hardness: 1 });
  const out = renderNote(engine, { freq: C4, midi: 60, seconds: 2 });
  const eighth = harmonicDb(out, stretched(C4, 8), 0.05);
  const seventh = harmonicDb(out, stretched(C4, 7), 0.05);
  const ninth = harmonicDb(out, stretched(C4, 9), 0.05);
  assert.ok(eighth < seventh - 15 && eighth < ninth - 15, `the eighth partial (${eighth.toFixed(1)}dB) should be missing`);
});

test('the level does not jump when the partial count or the hammer moves', () => {
  // The bank is normalised, so those two knobs are tone controls rather than volume controls - which
  // is what makes it possible to have a measured output trim at all.
  const at = (state) => {
    const engine = createPianoEngine(SR);
    engine.setParams(state);
    return peak(renderNote(engine, { freq: C4, midi: 60, seconds: 1 }));
  };
  const base = at({});
  for (const state of [{ partials: 4 }, { partials: 32 }, { hammer: 0.02 }, { hammer: 0.4 }]) {
    const level = at(state);
    assert.ok(
      Math.abs(20 * Math.log10(level / base)) < 6,
      `${JSON.stringify(state)} moved the peak by ${(20 * Math.log10(level / base)).toFixed(1)}dB`,
    );
  }
});

test('harder strikes are brighter, and the hammer hardness decides by how much', () => {
  const tilt = (velocity, hardness) => {
    const engine = createPianoEngine(SR);
    engine.setParams({ hardness, detune: 0 });
    const out = renderNote(engine, { freq: C4, midi: 60, velocity, seconds: 1 });
    return harmonicDb(out, stretched(C4, 10), 0.05) - harmonicDb(out, C4, 0.05);
  };
  assert.ok(tilt(1, 0.5) > tilt(0.15, 0.5) + 6, 'a hard strike should have relatively more top');
  // A soft hammer flattens the difference, which is what a hardness control is for.
  const soft = tilt(1, 0) - tilt(0.15, 0);
  const hard = tilt(1, 1) - tilt(0.15, 1);
  assert.ok(soft > hard, `a soft hammer should spread velocity further (${soft.toFixed(1)}dB vs ${hard.toFixed(1)}dB)`);
});

test('the damper stops a ringing string, and the voice is freed', () => {
  const engine = createPianoEngine(SR);
  engine.setParams({ release: 0.1, decay: 20 });
  const out = renderNote(engine, { freq: C4, midi: 60, seconds: 3, releaseAt: 1 });
  assert.ok(peak(out, Math.round(0.9 * SR), Math.round(1 * SR)) > 0.005);
  assert.ok(peak(out, Math.round(2 * SR), out.length) < 1e-4);
  assert.equal(engine.sounding(), 0);
});

test('the unison pair beats without cancelling', () => {
  // Two partials of equal amplitude a few cents apart null each other completely once per beat, which
  // measured as 17dB of swing on a held middle C. The pair is uneven in both amplitude and decay for
  // exactly that reason.
  const engine = createPianoEngine(SR);
  engine.setParams({ partials: 1, decay: 20, detune: 6 });
  const out = renderNote(engine, { freq: C4, midi: 60, seconds: 3 });
  let low = Infinity;
  let high = 0;
  // Over one beat period, in windows short enough to see into it.
  for (let t = 0.3; t < 1.6; t += 0.02) {
    const level = peak(out, Math.round(t * SR), Math.round((t + 0.02) * SR));
    low = Math.min(low, level);
    high = Math.max(high, level);
  }
  const swing = 20 * Math.log10(high / low);
  assert.ok(swing > 1, `there should be an audible beat, got ${swing.toFixed(1)}dB`);
  assert.ok(swing < 14, `but not a null, got ${swing.toFixed(1)}dB`);
});

test('every setting stays finite, at the bottom of the keyboard and the top', () => {
  for (const state of [
    { partials: 32, inharmonic: 4, detune: 14, decay: 20, decayTilt: 0, thump: 1, board: 1 },
    { partials: 4, inharmonic: 0, detune: 0, decay: 0.5, decayTilt: 1.5, thump: 0, board: 0 },
  ]) {
    for (const [midi, freq] of [[24, 32.703], [60, C4], [107, 3951]]) {
      const engine = createPianoEngine(SR);
      engine.setParams(state);
      const out = renderNote(engine, { freq, midi, seconds: 2, releaseAt: 1.2 });
      assert.ok(out.every(Number.isFinite), `${JSON.stringify(state)} at ${freq}Hz produced a non-finite sample`);
      assert.ok(peak(out) < 4, `${JSON.stringify(state)} at ${freq}Hz peaked at ${peak(out).toFixed(2)}`);
    }
  }
});
