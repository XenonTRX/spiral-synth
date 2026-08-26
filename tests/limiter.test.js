// The limiter's promise, as numbers.
//
// Every figure asserted here is one the limiter's own header comment quotes. The point of the file
// is that those numbers can now stop being true loudly instead of quietly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PeakLimiter, LIMITER_DEFAULTS } from '../src/effects/limiter-dsp.js';
import { dbOver, peak, runMono, sine, square } from './helpers.js';

const SR = 44100;
const CEILING = 10 ** (-1 / 20); // -1 dBFS, the default ceiling

function limit(signal, options = {}) {
  const lim = new PeakLimiter(SR, { ...LIMITER_DEFAULTS, ...options });
  return runMono(lim, signal);
}

test('nothing leaves above the ceiling', async (t) => {
  const impulse = new Float32Array(SR);
  impulse[SR / 2] = 4;

  const step = new Float32Array(SR);
  step.fill(1, SR / 2);

  const cases = [
    ['110 Hz sine at full scale', sine(110, SR, 1, 1)],
    ['55 Hz square at full scale', square(55, SR, 1, 1)],
    ['silence, then full scale in one sample', step],
    ['200 Hz sine at 4.0 - 12 dB over', sine(200, SR, 1, 4)],
    ['a single-sample impulse of 4.0', impulse],
  ];

  for (const [name, signal] of cases) {
    await t.test(name, () => {
      const out = peak(limit(signal));
      // The measured table allows up to 0.01 dB past the ceiling on the impulse and 0.00 elsewhere.
      // One hundredth of a dB is the bar for all of them here.
      assert.ok(
        dbOver(out, CEILING) <= 0.01,
        `${name}: peaked at ${out.toFixed(4)}, ${dbOver(out, CEILING).toFixed(3)} dB over`,
      );
    });
  }
});

test('a mix that fits meets nothing but a delay', () => {
  // A 220 Hz sine at 0.8 never reaches the ceiling, so the gain must be exactly 1 and never move:
  // the output is the input, delayed by the lookahead, bit for bit.
  const input = sine(220, SR, 0.5, 0.8);
  const out = limit(input);
  const lookahead = Math.round((LIMITER_DEFAULTS.lookaheadMs / 1000) * SR);

  let worst = 0;
  for (let i = lookahead; i < input.length; i++) {
    worst = Math.max(worst, Math.abs(out[i] - input[i - lookahead]));
  }
  assert.equal(worst, 0, `worst difference from the delayed input was ${worst}`);
});

test('asked for 7.02 dB of reduction on a signal 6 dB over, it holds 7.02 dB', () => {
  const lim = new PeakLimiter(SR, LIMITER_DEFAULTS);
  runMono(lim, sine(220, SR, 1, 2)); // 2.0 is 6 dB over full scale
  const { gainFloor } = lim.readMeter();
  const reduction = -20 * Math.log10(gainFloor);
  assert.ok(
    Math.abs(reduction - 7.02) < 0.05,
    `held ${reduction.toFixed(2)} dB of reduction, expected 7.02`,
  );
});

test('release is one time constant, not a settling time', () => {
  // From 13 dB of reduction the gain is back within 0.01 dB of unity after ~986 ms at a 150 ms
  // release. That is what an exponential does, and it is why a loud transient ducks the next bar.
  const releaseMs = 150;
  const lim = new PeakLimiter(SR, { ...LIMITER_DEFAULTS, releaseMs });

  const hit = new Float32Array(Math.round(SR * 0.05));
  hit.fill(10 ** (13 / 20) * CEILING); // 13 dB over the ceiling
  runMono(lim, hit);

  const tail = new Float32Array(Math.round(SR * 2));
  const out = runMono(lim, tail);
  void out;

  // Walk the tail and find when the gain is within 0.01 dB of unity again.
  const target = 10 ** (-0.01 / 20);
  let recoveredAt = null;
  const probe = new PeakLimiter(SR, { ...LIMITER_DEFAULTS, releaseMs });
  runMono(probe, hit);
  const block = 128;
  const silent = [new Float32Array(block)];
  const sink = [new Float32Array(block)];
  for (let i = 0; i < SR * 2 && recoveredAt === null; i += block) {
    probe.process(silent, sink, block);
    if (probe.gain >= target) recoveredAt = ((i + block) / SR) * 1000;
  }

  assert.ok(recoveredAt !== null, 'gain never returned to unity');
  assert.ok(
    Math.abs(recoveredAt - 986) < 25,
    `recovered after ${recoveredAt.toFixed(0)} ms, expected about 986`,
  );
});

test('bypass keeps the delay and drops only the gain', () => {
  const input = sine(110, SR, 0.2, 1);
  const on = limit(input, { enabled: true });
  const off = limit(input, { enabled: false });
  assert.ok(peak(off) > peak(on), 'bypassed output should not be limited');
  // Same latency either way - the delay line runs regardless, so an A/B is a level change only.
  const lookahead = Math.round((LIMITER_DEFAULTS.lookaheadMs / 1000) * SR);
  let worst = 0;
  for (let i = lookahead; i < input.length; i++) worst = Math.max(worst, Math.abs(off[i] - input[i - lookahead]));
  assert.equal(worst, 0, 'bypassed output should be the delayed input exactly');
});
