// The rig the three string instruments' tests share: render a note, and measure it.
//
// Everything here is possible only because the engines are plain objects in `*-dsp.js` rather than
// `AudioWorkletProcessor` subclasses - the whole reason for the split. `render` does what the
// processor's `process` does, in a loop, against a clock it counts itself.

import { fft } from '../src/fft.js';

export const SR = 44100;

/** One note through an engine, in the 128-sample blocks the audio thread would ask for. */
export function renderNote(engine, { freq, midi = 69, velocity = 1, seconds = 2, releaseAt = null } = {}) {
  const total = Math.round(seconds * SR);
  const out = new Float32Array(total);
  const block = new Float32Array(128);
  engine.message({ type: 'noteOn', id: 1, midi, freq, velocity, time: 0.0005 });
  if (releaseAt !== null) engine.message({ type: 'noteOff', id: 1, time: releaseAt });
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i);
    engine.render(block, n, i / SR);
    out.set(block.subarray(0, n), i);
  }
  return out;
}

export function peak(signal, from = 0, to = signal.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(signal[i]));
  return m;
}

export function rms(signal, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

export const dbOf = (x) => 20 * Math.log10(x + 1e-300);
export const cents = (a, b) => 1200 * Math.log2(a / b);

/** The magnitude spectrum of a Hann-windowed slice, so a partial is a peak rather than a smear. */
function spectrum(signal, offset, N) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (signal[offset + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im, false);
  return { re, im, at: (k) => Math.hypot(re[k], im[k]) };
}

/**
 * The frequency of the strongest peak near `expect`, to a fraction of a bin.
 *
 * Parabolic interpolation on the log magnitudes, which is what makes this a *tuning* measurement: at
 * N=131072 a bin is a third of a hertz, and one cent at 65Hz is four hundredths of one. Without the
 * interpolation the answer would be quantised far coarser than the thing being asked about, which is
 * how a first attempt at this "measured" a perfectly tuned string as eight cents flat.
 */
export function peakNear(signal, expect, offset = 0, N = 131072) {
  const { at } = spectrum(signal, offset, N);
  const centre = Math.round((expect * N) / SR);
  const span = Math.max(4, Math.round(centre * 0.06));
  let best = centre;
  for (let k = Math.max(1, centre - span); k <= centre + span; k++) if (at(k) > at(best)) best = k;
  const a = Math.log(at(best - 1) + 1e-300);
  const b = Math.log(at(best) + 1e-300);
  const c = Math.log(at(best + 1) + 1e-300);
  return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / N;
}

/** The level of one harmonic at one moment, in dB. */
export function harmonicDb(signal, hz, atSeconds, N = 8192) {
  const { at } = spectrum(signal, Math.round(atSeconds * SR), N);
  const bin = Math.round((hz * N) / SR);
  let m = 0;
  for (let k = bin - 3; k <= bin + 3; k++) m = Math.max(m, at(k));
  return dbOf(m);
}

/** How fast something at `hz` is decaying, in dB per second, between two moments. */
export function decayRate(signal, hz, from, to) {
  return (harmonicDb(signal, hz, from) - harmonicDb(signal, hz, to)) / (to - from);
}
