// The part of a worklet instrument that is not the sound: the pool, the queue and the matrix.
//
// This is the first thing in this project to test an *architecture* rather than an arithmetic, and it
// is worth it for one reason: the three instruments built on it all sound different, so a mistake in
// here shows up as three vaguely wrong instruments rather than as one obviously broken one. The voice
// below makes no sound at all - it records what it was told and when - which is what lets the
// questions be asked directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MOD_SUBBLOCK, PolyEngine } from '../src/instruments/poly-engine.js';

const SR = 44100;

/** A voice that records rather than sounds. `tick` returns a constant so the mix is countable. */
class Probe {
  constructor() {
    this.active = false;
    this.starts = [];
    this.frequencies = [];
    this.released = 0;
    this.ticks = 0;
    this.life = Infinity;
  }

  start(velocity) {
    this.active = true;
    this.ticks = 0;
    this.starts.push({ velocity, freq: this.freq, midi: this.midi, at: this.startTime });
  }

  setFrequency(hz) {
    this.frequencies.push(hz);
  }

  release() {
    this.released++;
    this.life = this.ticks + 1;
  }

  tick() {
    if (++this.ticks >= this.life) this.active = false;
    return 1;
  }
}

function engineWith(count, extra = {}) {
  const voices = [];
  for (let i = 0; i < count; i++) voices.push(new Probe());
  const engine = new PolyEngine({
    sampleRate: SR,
    defaults: { gain: 1, tune: 0, mod: [], ...extra },
    targets: ['gain', 'tune'],
    voices,
  });
  return { engine, voices };
}

/** Render `frames` samples starting at `from` seconds, block by block as a processor would. */
function run(engine, frames, from = 0) {
  const out = new Float32Array(frames);
  const block = new Float32Array(128);
  for (let i = 0; i < frames; i += 128) {
    const n = Math.min(128, frames - i);
    engine.render(block, n, from + i / SR);
    out.set(block.subarray(0, n), i);
  }
  return out;
}

test('a note starts at the sample it was scheduled for, not at the block edge', () => {
  // 128 samples is 2.9ms, and two parts disagreeing by that much is exactly the flamming the whole
  // scheduler exists to avoid. So this is the claim that the queue is drained per sample.
  const { engine } = engineWith(1);
  const at = 300 / SR;
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: at });
  const out = run(engine, 512);
  assert.equal(out[299], 0, 'silent the sample before');
  assert.equal(out[300], 1, 'sounding on the sample itself');
});

test('everything a note carries arrives with it', () => {
  const { engine, voices } = engineWith(1);
  engine.message({ type: 'noteOn', id: 7, freq: 220, midi: 57, velocity: 0.4, time: 0 });
  run(engine, 128);
  assert.deepEqual(voices[0].starts, [{ velocity: 0.4, freq: 220, midi: 57, at: 0 }]);
  assert.equal(voices[0].id, 7);
});

test('the pool fills up before it steals, and then steals the oldest', () => {
  const { engine, voices } = engineWith(3);
  for (let i = 0; i < 3; i++) {
    engine.message({ type: 'noteOn', id: i + 1, freq: 100 + i, midi: 60 + i, velocity: 1, time: (i * 200) / SR });
  }
  run(engine, 1024);
  assert.deepEqual(voices.map((v) => v.starts.length), [1, 1, 1], 'three notes should take three slots');
  // A fourth with nothing free takes the one that has been going longest, which is the first.
  engine.message({ type: 'noteOn', id: 4, freq: 999, midi: 70, velocity: 1, time: 1024 / SR });
  run(engine, 256, 1024 / SR);
  assert.equal(voices[0].starts.length, 2, 'the oldest voice should have been restarted');
  assert.equal(voices[1].starts.length, 1);
});

test('a note-off reaches the voice that has that id, and only once', () => {
  const { engine, voices } = engineWith(2);
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 });
  engine.message({ type: 'noteOn', id: 2, freq: 550, midi: 71, velocity: 1, time: 0 });
  engine.message({ type: 'noteOff', id: 2, time: 100 / SR });
  // The same id again, which a doubled release would act on twice.
  engine.message({ type: 'noteOff', id: 2, time: 200 / SR });
  run(engine, 512);
  assert.equal(voices[0].released, 0, 'the note that was not let go');
  assert.equal(voices[1].released, 1, 'the one that was, once');
});

test('the tune knob reaches the voice as a frequency, in semitones', () => {
  const { engine, voices } = engineWith(1, { tune: 12 });
  engine.message({ type: 'noteOn', id: 1, freq: 220, midi: 57, velocity: 1, time: 0 });
  run(engine, 128);
  assert.ok(Math.abs(voices[0].frequencies.at(-1) - 440) < 1e-9, 'an octave up is twice the frequency');
});

test('a slide arrives at its pitch, geometrically, and then stops costing anything', () => {
  const { engine, voices } = engineWith(1);
  engine.message({
    type: 'noteOn',
    id: 1,
    freq: 440,
    midi: 69,
    velocity: 1,
    time: 0,
    glideFrom: 220,
    glideSeconds: 0.1,
  });
  run(engine, Math.round(0.2 * SR));
  const seen = voices[0].frequencies;
  assert.ok(Math.abs(seen[0] - 220) < 1e-9, 'starts where it came from');
  assert.ok(Math.abs(seen.at(-1) - 440) < 1e-9, 'lands exactly on the target');
  // Halfway in time is halfway in *semitones*, which is the geometric mean rather than the average -
  // a linear ramp through Hz would spend most of the journey sounding like the destination.
  const middle = seen[Math.round(seen.length / 2)];
  assert.ok(Math.abs(middle - Math.sqrt(220 * 440)) < 12, `halfway was ${middle.toFixed(1)}Hz`);
  assert.equal(voices[0].glideSeconds, 0, 'and the slide switches itself off on arrival');
});

test('a routing reaches the array the voice reads, on its own coarser clock', () => {
  const { engine, voices } = engineWith(1, {
    lfo1Rate: 5,
    lfo1Shape: 'sine',
    lfo1Fade: 0,
    mod: [{ source: 'lfo1', target: 'gain', depth: 0.5 }],
  });
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 });
  const seen = [];
  const block = new Float32Array(MOD_SUBBLOCK * 4);
  for (let i = 0; i < 8; i++) {
    engine.render(block, block.length, (i * block.length) / SR);
    seen.push(voices[0].mod[0]);
  }
  assert.ok(seen.some((v) => v !== 0), 'something should have moved');
  assert.ok(Math.max(...seen.map(Math.abs)) <= 0.5 + 1e-9, 'and never past the depth it was given');
});

test('a routing naming something this build has not got is dropped, not defaulted', () => {
  const { engine, voices } = engineWith(1, {
    mod: [
      { source: 'nonesuch', target: 'gain', depth: 0.5 },
      { source: 'lfo1', target: 'nonesuch', depth: 0.5 },
      { source: 'lfo1', target: 'gain', depth: 0 },
    ],
  });
  assert.equal(engine.routeCount, 0);
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 });
  run(engine, 512);
  assert.equal(voices[0].mod[0], 0);
});

test('panic silences everything and forgets what was queued', () => {
  const { engine } = engineWith(2);
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 });
  engine.message({ type: 'noteOn', id: 2, freq: 550, midi: 71, velocity: 1, time: 1 });
  run(engine, 128);
  assert.equal(engine.sounding(), 1);
  engine.message({ type: 'panic' });
  assert.equal(engine.sounding(), 0);
  const out = run(engine, Math.round(1.2 * SR));
  assert.ok(out.every((v) => v === 0), 'and the note that was still queued never arrives');
});

test('anything in the initial payload without a time is ignored rather than blocking the queue', () => {
  // This went wrong once already, in a way that produced a silent render and a scope reporting a
  // flawless synth: a params message with no `time` sat at the head of the queue, `undefined <= now`
  // is false, and every note behind it waited forever.
  const { engine } = engineWith(1);
  engine.init({
    state: { gain: 1 },
    events: [
      { type: 'params', state: { gain: 1 } },
      { type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 },
    ],
  });
  const out = run(engine, 256);
  assert.equal(out[0], 1, 'the note should sound');
});

test('the gain knob scales the mix, and only the mix', () => {
  const { engine } = engineWith(2, { gain: 0.25 });
  engine.message({ type: 'noteOn', id: 1, freq: 440, midi: 69, velocity: 1, time: 0 });
  engine.message({ type: 'noteOn', id: 2, freq: 550, midi: 71, velocity: 1, time: 0 });
  const out = run(engine, 128);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-6, 'two voices of 1 at a quarter gain');
});
