// The picture the worker's numbers become.
//
// Two jobs that have to stay on this side of the thread boundary. Running the analysis - which is
// mostly about *cancelling* it, because every turn of the FFT-size knob asks for a new one and the
// old one is worth nothing the moment it does. And painting the grid, which happens here rather
// than in the worker because what a cell should look like is a display decision: the floor, the
// gain, the colour ramp and the band are all remaps of the same 256 stored steps, so moving any of
// them repaints an image that is already in memory instead of transforming the audio again.
//
// The result is painted into **one canvas the natural size of the grid** - frames across, pitch rows
// down - and the roll draws a rectangle of it with a single scaled `drawImage`. That is the whole
// reason the grid is folded onto the semitone axis in the worker: both axes come out linear, so
// placing the picture on a piano roll is an affine map and the browser does it on the GPU. A
// spectrogram sampled per visible pixel in JavaScript would be a million-iteration loop on every
// scroll event, and a scroll event is not a place to spend a million iterations.

import { createWorkerRunner } from './worker-run.js';

// How far down one stored byte reaches. Everything the worker sends back is relative to the loudest
// moment in the file, over this range, so the display's own floor and gain are a remap of these 256
// steps rather than a reason to transform the audio again. 140dB across 256 steps is 0.55dB a step,
// finer than the eye reads off a colour ramp. The worker is told this number rather than sharing a
// constant with it, because it is a contract about what a byte means and a contract wants one author.
export const STORE_FLOOR_DB = -140;

// Sequential ramps: one journey from dark to light, so that brighter always means louder. Not the
// rainbow a spectrogram usually wears - a rainbow spends hue, which has no order to it, on a
// quantity that is nothing but order, and leaves a reader deciding whether green is more than
// orange. `ice` is the app's own cyan, the same nine stops the voice scope's sweep view uses, so
// the two spectrograms in this program read the same way round.
export const RAMPS = [
  {
    id: 'ice',
    label: 'Ice',
    stops: ['#16263a', '#1b3f5e', '#1e5c85', '#2a7ea9', '#4aa3c9', '#7dd3fc', '#c9edff', '#f0faff'],
  },
  {
    id: 'ember',
    label: 'Ember',
    stops: ['#2a1020', '#5c1436', '#8f1d3a', '#c2410c', '#ea8c1b', '#f5c542', '#fde68a', '#fffaf0'],
  },
  {
    id: 'mono',
    label: 'Mono',
    stops: ['#2a2d36', '#4a4f5c', '#6b7280', '#8e95a3', '#b3b9c6', '#d4d9e3', '#eef1f7', '#ffffff'],
  },
  // The two matplotlib maps, at nine stops each - which is what the three above were reaching for
  // and these two actually are. They were built by measuring perceived lightness rather than by
  // picking colours that looked like a ramp, so equal steps in loudness are equal steps in
  // brightness the whole way up, and neither has a band that reads as an edge where the data is
  // smooth. Both also survive being seen by someone who cannot separate red from green, which the
  // rainbow maps a spectrogram usually wears do not.
  //
  // Their dark ends are much darker than the three above - magma's is nearly black. That costs
  // nothing here because alpha, not colour, is what hides the quiet parts: at the bottom of the
  // range the pixel is transparent, so the roll shows through rather than a near-black wash.
  {
    id: 'viridis',
    label: 'Viridis',
    stops: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21908c', '#27ad81', '#5dc863', '#aadc32', '#fde725'],
  },
  {
    id: 'magma',
    label: 'Magma',
    stops: ['#000004', '#1b1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8861', '#fec287', '#fcfdbf'],
  },
];

const LITTLE_ENDIAN = (() => {
  const probe = new ArrayBuffer(4);
  new Uint32Array(probe)[0] = 1;
  return new Uint8Array(probe)[0] === 1;
})();

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function rampColor(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
}

/**
 * The 256 colours a stored cell can be, given where the display's floor and gain are.
 *
 * Alpha carries the bottom of the range and colour carries the rest. That split is what makes this
 * an overlay rather than a picture pasted over the roll: everything under the floor is *absent*, so
 * the grid, the bar lines and the notes you are writing show through the quiet parts, and the loud
 * parts are opaque enough to read as a shape. A ramp that started at an opaque dark blue would
 * paint the whole roll navy and hide the thing you are transcribing onto.
 */
function buildLut({ floorDb, gainDb, ramp }) {
  const stops = (RAMPS.find((r) => r.id === ramp) ?? RAMPS[0]).stops;
  const lut = new Uint32Array(256);
  const span = Math.max(1, -floorDb);
  for (let v = 1; v < 256; v++) {
    const db = STORE_FLOOR_DB + (v * -STORE_FLOOR_DB) / 255 + gainDb;
    const t = (db - floorDb) / span;
    if (t <= 0) continue;
    const clamped = Math.min(1, t);
    const [r, g, b] = rampColor(stops, clamped);
    // Alpha reaches full a third of the way up, so the top two thirds of the range are read as
    // colour on a solid field rather than as colour and transparency changing together - two
    // channels saying the same thing is one of them wasted.
    const a = Math.round(255 * Math.min(1, clamped * 3));
    lut[v] = LITTLE_ENDIAN ? (a << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | a;
  }
  return lut;
}

/**
 * Which rows of the grid the band lets through.
 *
 * The band is named in notes rather than in hertz, because the axis it is being drawn against is
 * notes - "isolate from C2 to C4" is a thing you can want while looking at a piano roll, and
 * "isolate from 65Hz to 262Hz" is the same sentence with a conversion in the way. The monitor
 * filter is given the same two edges, so what you hear is what is left on screen.
 */
export function bandRows({ bandLow, bandHigh, midiLow, midiHigh, binsPerSemitone }) {
  const from = Math.max(0, (midiHigh - Math.min(bandHigh, midiHigh)) * binsPerSemitone);
  const to = Math.min(
    (midiHigh - midiLow + 1) * binsPerSemitone - 1,
    (midiHigh - Math.max(bandLow, midiLow) + 1) * binsPerSemitone - 1,
  );
  return { from, to };
}

/**
 * Paint an analysis into a canvas of its own natural size. Returns null if there is nothing to draw.
 *
 * The canvas is reused across repaints. Reallocating an 8000x252 canvas every time a slider moves is
 * 8MB of garbage per frame of a drag, which the collector will happily deal with in the middle of the
 * next scroll.
 */
let scratch = null;

export function paintSpectrum(canvas, analysis, view) {
  if (!analysis) return null;
  const { grid, frames, rows } = analysis;
  if (canvas.width !== frames || canvas.height !== rows) {
    canvas.width = frames;
    canvas.height = rows;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  // Kept between repaints. Dragging the floor asks for one of these per slider step, and on a long
  // file that is fifty megabytes of ImageData a step - which the collector will deal with, in the
  // middle of the next scroll. Reused, it has to be cleared first: the band leaves the rows outside
  // it untouched, and untouched here means whatever the last paint left there.
  if (!scratch || scratch.width !== frames || scratch.height !== rows) {
    scratch = ctx.createImageData(frames, rows);
  }
  const image = scratch;
  const out = new Uint32Array(image.data.buffer);
  out.fill(0);
  const lut = buildLut(view);
  const { from, to } = bandRows({ ...view, binsPerSemitone: analysis.binsPerSemitone });

  for (let y = from; y <= to; y++) {
    let gi = y;
    let oi = y * frames;
    for (let x = 0; x < frames; x++) {
      out[oi++] = lut[grid[gi]];
      gi += rows;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Run one analysis, replacing any that is still running.
 *
 * The running and cancelling is worker-run.js's, shared with the beat detector. What is peculiar to
 * this one is the two things the worker is told that it cannot know - what a stored byte means, and
 * how finely the rows were divided - the second of which comes back out again attached to the
 * result, because the painter needs it and the worker has no reason to repeat it.
 */
export function createAnalyser() {
  const runner = createWorkerRunner(
    () => new Worker(new URL('./spectrum-worker.js', import.meta.url), { type: 'module' }),
  );

  return {
    cancel: runner.cancel,
    busy: runner.busy,
    run(request, { onProgress, onDone, onError }) {
      runner.run(
        { ...request, storeFloorDb: STORE_FLOOR_DB },
        {
          transfer: [request.channel.buffer],
          onProgress,
          onDone: (data) => onDone?.({ ...data, binsPerSemitone: request.binsPerSemitone }),
          onError,
        },
      );
    },
  };
}
