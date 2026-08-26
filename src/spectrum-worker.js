// The transform that turns a recording into something the roll can draw, off the main thread.
//
// A four-minute file at a 4096-point FFT with three-quarter overlap is ten thousand transforms.
// On the main thread that is somewhere between five and fifteen seconds of a frozen page, which
// is not a slow feature - it is a broken one, because the freeze lands exactly when you have just
// dropped a file in and are waiting to see whether the import worked at all.
//
// It imports fft.js and nothing else. That is what makes it a module worker rather than a blob:
// the one Fourier transform in the project is the one used here too, so a spectrogram cannot
// disagree with the scope about what a spectrum is.
//
// The windows are declared here rather than imported from analysis.js, which has the same two.
// analysis.js reaches instruments.js on its way in, and dragging a synth's parameter declarations
// into an AudioWorklet-free worker to get twelve lines of cosine is the wrong trade. Two copies of
// a window function is a duplication that cannot go subtly wrong - it is a closed-form definition,
// and a mistyped coefficient shows up as a spectrum that is visibly wrong everywhere at once.

import { fft } from './fft.js';

// Two ceilings, and they are the same ceiling seen from different sides. A canvas wider than about
// 32767px will not allocate in any browser, and the grid is painted into one canvas so that drawing
// it is a single scaled blit rather than a per-pixel loop on every scroll. The cell cap is the memory
// version of the same limit: 16 million cells is 64MB of RGBA once painted, which is a lot and is
// survivable; twice that is not.
//
// Exceeding either widens the hop rather than truncating the file. A recording that is half analysed
// is a bug report waiting to happen; one analysed at 12ms a frame instead of 6 is a readout, and the
// panel says which it got.
const MAX_FRAMES = 32000;
const MAX_CELLS = 16e6;

const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function windowOf(kind, size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const t = (2 * Math.PI * i) / (size - 1);
    if (kind === 'hamming') w[i] = 0.54 - 0.46 * Math.cos(t);
    else if (kind === 'blackman-harris') {
      w[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    } else w[i] = 0.5 - 0.5 * Math.cos(t); // hann
  }
  return w;
}

/**
 * Which FFT bins belong to which row of the picture.
 *
 * The roll's vertical axis is semitones, evenly spaced, which means it is already logarithmic in
 * frequency - so a spectrogram drawn against it has to be folded onto that axis rather than stretched
 * over a linear one. Each row owns a slice of a semitone and takes the **loudest** bin inside it,
 * because the question the row is answering is "is there a note here", not "how much total energy is
 * in this band" - a sum would let the width of the band flatter the high rows, which own more bins.
 *
 * Below about the fifth octave a semitone is narrower than one FFT bin and the slice contains nothing.
 * Those rows interpolate between the two bins either side of their centre instead, which turns the
 * bottom of the picture into a smear rather than into a comb of empty rows - honest about the
 * resolution being gone, and legible, which a striped one is not. Raising the FFT size is what
 * actually fixes it, and that is a control.
 */
function rowPlan({ rows, midiLow, midiHigh, binsPerSemitone, binHz, binCount }) {
  const from = new Int32Array(rows);
  const to = new Int32Array(rows);
  const centre = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    const top = midiHigh + 0.5 - r / binsPerSemitone;
    const bottom = top - 1 / binsPerSemitone;
    const k0 = Math.ceil(midiToFreq(bottom) / binHz);
    const k1 = Math.floor(midiToFreq(top) / binHz);
    from[r] = Math.max(1, k0);
    to[r] = Math.min(binCount - 1, k1);
    centre[r] = midiToFreq((top + bottom) / 2) / binHz;
  }
  return { from, to, centre };
}

self.onmessage = (event) => {
  const {
    channel,
    sampleRate,
    fftSize,
    overlap,
    windowKind,
    binsPerSemitone,
    midiLow,
    midiHigh,
    // How far down one stored byte reaches, decided by the side that has to paint it. Passed in
    // rather than agreed on by two copies of a constant: the byte is a contract between this file
    // and spectrum.js's colour table, and a contract with two definitions has one too many.
    storeFloorDb,
  } = event.data;

  const rows = (midiHigh - midiLow + 1) * binsPerSemitone;
  const asked = Math.max(1, Math.floor(fftSize / overlap));
  // The span the frames have to cover. A frame is centred on its own middle, so the last one starts
  // a window short of the end and the tail of the file still gets looked at.
  const span = Math.max(1, channel.length - fftSize);
  const roomForFrames = Math.min(MAX_FRAMES, Math.floor(MAX_CELLS / rows));
  const hop = Math.max(asked, Math.ceil(span / Math.max(1, roomForFrames - 1)));
  const frames = Math.max(1, Math.floor(span / hop) + 1);

  const win = windowOf(windowKind, fftSize);
  const binCount = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const plan = rowPlan({ rows, midiLow, midiHigh, binsPerSemitone, binHz, binCount });

  // Power rather than magnitude all the way through: the only use for either is a ratio against the
  // loudest cell, and a square root taken ten million times to be undone by a logarithm is ten million
  // square roots spent on nothing.
  const power = new Float32Array(frames * rows);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let peak = 1e-30;

  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = (channel[offset + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);

    const base = frame * rows;
    for (let r = 0; r < rows; r++) {
      let best;
      const k0 = plan.from[r];
      const k1 = plan.to[r];
      if (k1 >= k0) {
        best = 0;
        for (let k = k0; k <= k1; k++) {
          const p = re[k] * re[k] + im[k] * im[k];
          if (p > best) best = p;
        }
      } else {
        const c = plan.centre[r];
        const lo = Math.max(1, Math.min(binCount - 1, Math.floor(c)));
        const hi = Math.min(binCount - 1, lo + 1);
        const t = Math.max(0, Math.min(1, c - lo));
        const a = re[lo] * re[lo] + im[lo] * im[lo];
        const b = re[hi] * re[hi] + im[hi] * im[hi];
        best = a + (b - a) * t;
      }
      power[base + r] = best;
      if (best > peak) peak = best;
    }

    // Often enough that a long file has a moving bar, rarely enough that posting is not the work.
    if ((frame & 63) === 0) self.postMessage({ type: 'progress', done: frame, total: frames });
  }

  const grid = new Uint8Array(frames * rows);
  const scale = 255 / -storeFloorDb;
  for (let i = 0; i < power.length; i++) {
    // 10log10 rather than 20log10 because these are powers, not amplitudes.
    const db = 10 * Math.log10(Math.max(power[i], 1e-30) / peak);
    grid[i] = db <= storeFloorDb ? 0 : Math.round((db - storeFloorDb) * scale);
  }

  self.postMessage(
    {
      type: 'done',
      grid,
      frames,
      rows,
      hop,
      // Where column zero's left edge sits in the file, in seconds. A frame is *centred* on its
      // window, so the picture starts half a window in and each column is one hop wide - which is
      // what lets the roll place the image by two numbers instead of by a per-column lookup.
      t0: (fftSize / 2 - hop / 2) / sampleRate,
      dt: hop / sampleRate,
      binHz,
      truncated: hop > asked,
    },
    [grid.buffer],
  );
};
