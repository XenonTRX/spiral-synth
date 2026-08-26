// The scope's three pictures: the spectrum, one frame of a sweep, and the whole sweep as a map.
//
// Four hundred lines of canvas work that answer to three pieces of data - a spectrum `result`, a
// `sweep`, and the smoothing accumulator that belongs to the sweep animation. They came out of
// analysis-panel.js because that is all they answer to: everything else in the panel is about
// *getting* the measurement (the debounce, the ticket, the note picker, the stats table), and this
// is about drawing one once it exists.
//
// The canvas is created here rather than passed in, because its size is a fact about the drawing:
// PAD, the axis labels and the heat ramp are all laid out against WIDTH and HEIGHT, and a caller
// free to resize it would be free to break the axes silently. The panel appends `view.canvas`.
//
// `smoothed` lives here for the same reason. It is a rolling average across sweep frames, so it is
// part of how the picture is drawn rather than part of what was measured - the panel only needs to
// say `resetSmoothing()` when it restarts the animation.

import { cssVar } from '../theme.js';

const WIDTH = 392;
const HEIGHT = 210;
const PAD = { left: 30, right: 6, top: 10, bottom: 18 };

const F_MIN = 20;
const DB_FLOOR = -120;

// The sweep view's colour is a magnitude, so it takes a sequential ramp: one hue, stepped
// monotonically in lightness, anchored dark because the surface is dark. Not one of the
// multi-hue maps a spectrogram usually wears - those read as a rainbow, which spends hue on
// something that has no categories in it, and leaves a reader deciding whether green is more
// or less than orange. Nine stops of the app's own cyan, checked for monotonic lightness
// (OKLCH L 0.184 rising to 0.979) so that brighter always means louder and never the reverse.
const HEAT = ['#10121a', '#16263a', '#1b3f5e', '#1e5c85', '#2a7ea9', '#4aa3c9', '#7dd3fc', '#c9edff', '#f0faff']
  .map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

// How far down the ramp reaches. Past this everything is the floor colour, which keeps the
// quiet parts as background rather than as a field of faint noise to read through.
const HEAT_FLOOR_DB = -66;

/** A frequency for an axis label: kilohertz above 1000, and never more digits than fit. */
export function formatHz(hz) {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}k`;
  return `${Math.round(hz)}`;
}

export { HEAT_FLOOR_DB, WIDTH, HEIGHT };

/**
 * One scope canvas and the three ways of drawing on it.
 *
 * Feed it with `setData({ result, sweep })` after a measurement, then call whichever of the three
 * draws the current view wants.
 */
export function createScopeView() {
  const canvas = document.createElement('canvas');
  canvas.className = 'analysis__canvas';
  canvas.width = WIDTH * (window.devicePixelRatio || 1);
  canvas.height = HEIGHT * (window.devicePixelRatio || 1);
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;

  const ctx2d = canvas.getContext('2d');
  // Built once and reused: the map is drawn by filling this a pixel-row at a time and blitting it,
  // which is a great deal cheaper than a fillRect per cell.
  const heatCanvas = document.createElement('canvas');

  let result = null;
  let sweep = null;
  // The displayed curve, smoothed across frames. A single 23ms frame of FFT is a spiky thing, and
  // drawing it raw is what makes a home-made analyser look home-made - every real one applies
  // ballistics. Fast up and slow down, so a transient still arrives on the frame it happened and
  // only the decay is eased; smoothing the rise instead would blunt exactly what you are watching
  // for. This is a display choice and nothing measured is smoothed - the numbers under the plot
  // and everything the Spectrum view reports come from the unsmoothed data.
  let smoothed = null;
  const RISE = 0.55;
  const FALL = 0.14;

  function drawAxes(fMax) {
    const dpr = window.devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, WIDTH, HEIGHT);

    const w = WIDTH - PAD.left - PAD.right;
    const h = HEIGHT - PAD.top - PAD.bottom;
    const span = Math.log(fMax / F_MIN);
    const xFor = (hz) => PAD.left + (Math.log(Math.max(hz, F_MIN) / F_MIN) / span) * w;
    const yFor = (db) => PAD.top + (Math.min(0, Math.max(DB_FLOOR, db)) / DB_FLOOR) * h;

    ctx2d.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx2d.strokeStyle = cssVar('--grid-beat', 'rgba(255,255,255,0.08)');
    ctx2d.fillStyle = cssVar('--text-dim', '#9aa0b0');
    ctx2d.lineWidth = 1;

    for (const db of [0, -20, -40, -60, -80, -100, -120]) {
      const y = yFor(db);
      ctx2d.beginPath();
      ctx2d.moveTo(PAD.left, y);
      ctx2d.lineTo(PAD.left + w, y);
      ctx2d.stroke();
      ctx2d.textAlign = 'right';
      ctx2d.fillText(`${db}`, PAD.left - 4, y + 3);
    }
    for (const hz of [100, 1000, 10000]) {
      const x = xFor(hz);
      ctx2d.beginPath();
      ctx2d.moveTo(x, PAD.top);
      ctx2d.lineTo(x, PAD.top + h);
      ctx2d.stroke();
      ctx2d.textAlign = 'center';
      ctx2d.fillText(formatHz(hz), x, HEIGHT - 6);
    }
    return { w, h, xFor, yFor };
  }

  /**
   * One spectrum as a line.
   *
   * Reduced to one value per pixel column, and that value is the *loudest* bin in the column
   * rather than a sample of it: near Nyquist a column can cover thirty bins, and picking one of
   * them would step straight over a narrow spur, which is exactly the shape aliasing has.
   */
  function traceSpectrum(db, binHz, geom, style, alpha = 1, from = 1) {
    const columns = new Float32Array(Math.ceil(geom.w) + 1).fill(-Infinity);
    for (let k = from; k < db.length; k++) {
      const hz = k * binHz;
      if (hz < F_MIN) continue;
      const x = Math.round(geom.xFor(hz) - PAD.left);
      if (x < 0 || x >= columns.length) continue;
      if (db[k] > columns[x]) columns[x] = db[k];
    }
    ctx2d.save();
    ctx2d.globalAlpha = alpha;
    ctx2d.strokeStyle = style;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    let started = false;
    let carried = DB_FLOOR;
    for (let x = 0; x < columns.length; x++) {
      // Low frequencies have fewer bins than columns, leaving gaps with nothing in them; carrying
      // the last value across keeps the trace continuous instead of dropping it to the floor.
      if (columns[x] > -Infinity) carried = columns[x];
      const y = geom.yFor(carried);
      if (!started) {
        ctx2d.moveTo(PAD.left + x, y);
        started = true;
      } else {
        ctx2d.lineTo(PAD.left + x, y);
      }
    }
    ctx2d.stroke();
    ctx2d.restore();
  }

  /**
   * The sweep, the way every other analyser shows it: an ordinary spectrum that moves.
   *
   * This was a spectrogram first, and a spectrogram is the more complete picture - the whole
   * gesture at once, comparable across time. It is also not what anyone reads fluently, and it
   * spends colour on magnitude, which is the channel least able to carry a number: nobody reads
   * -38dB off a shade of blue. Here power is a height again, so the y axis answers "how loud" the
   * way it does everywhere else, and time is carried by the thing actually moving.
   *
   * What that gives up is memory, so the maximum each bin ever reached is held behind the live
   * trace. Between them you get the instant and the envelope of the whole note on one pair of
   * axes, which is what the spectrogram was for.
   */
  function drawSweepFrame(frame) {
    const geom = drawAxes(20000);
    const dim = cssVar('--text-dim', '#9aa0b0');

    if (!sweep) {
      ctx2d.fillStyle = dim;
      ctx2d.textAlign = 'center';
      ctx2d.fillText('Press Measure', PAD.left + geom.w / 2, PAD.top + geom.h / 2);
      return;
    }

    const index = Math.max(0, Math.min(sweep.frameCount - 1, frame));
    const live = sweep.db.subarray(index * sweep.bins, (index + 1) * sweep.bins);
    if (!smoothed || smoothed.length !== sweep.bins) {
      smoothed = Float32Array.from(live);
    } else {
      for (let k = 0; k < sweep.bins; k++) {
        const target = live[k];
        smoothed[k] += (target - smoothed[k]) * (target > smoothed[k] ? RISE : FALL);
      }
    }

    traceSpectrum(sweep.peakHold, sweep.binHz, geom, dim, 0.4);
    traceSpectrum(smoothed, sweep.binHz, geom, cssVar('--accent', '#7dd3fc'));

    // With frequency along the bottom the asked-for cutoff is a vertical line that slides right
    // and back, which reads far more directly than the diagonal it was on the spectrogram.
    const t = index * sweep.frameSeconds;
    const hz = trajectoryAt(t);
    if (hz) {
      const x = geom.xFor(hz);
      ctx2d.strokeStyle = cssVar('--cursor', '#c4b5fd');
      ctx2d.setLineDash([3, 3]);
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.moveTo(x, PAD.top);
      ctx2d.lineTo(x, PAD.top + geom.h);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.lineWidth = 1;
    }

    ctx2d.fillStyle = dim;
    ctx2d.textAlign = 'left';
    ctx2d.fillText(`${t.toFixed(2)}s${t >= sweep.releaseAt ? ' — released' : ''}`, PAD.left + 4, PAD.top + 10);
  }

  /** Where the instrument says the cutoff is at time `t`, interpolated between its own corners. */
  function trajectoryAt(t) {
    const points = sweep?.trajectory?.points;
    if (!points?.length) return null;
    for (let i = 1; i < points.length; i++) {
      const [t0, hz0] = points[i - 1];
      const [t1, hz1] = points[i];
      if (t <= t1) {
        const span = t1 - t0;
        const mix = span > 0 ? (t - t0) / span : 0;
        // Interpolated in octaves, because that is the axis it is about to be drawn on and the
        // straight line between two frequencies is not straight once the axis is logarithmic.
        return hz0 * (hz1 / hz0) ** Math.max(0, Math.min(1, mix));
      }
    }
    return points[points.length - 1][1];
  }

  function drawSpectrum() {
    const dpr = window.devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, WIDTH, HEIGHT);

    const w = WIDTH - PAD.left - PAD.right;
    const h = HEIGHT - PAD.top - PAD.bottom;
    const dim = cssVar('--text-dim', '#9aa0b0');
    const accent = cssVar('--accent', '#7dd3fc');
    const grid = cssVar('--grid-beat', 'rgba(255,255,255,0.08)');

    const fMax = result ? result.sampleRate / 2 : 22050;
    const span = Math.log(fMax / F_MIN);
    const xFor = (hz) => PAD.left + (Math.log(Math.max(hz, F_MIN) / F_MIN) / span) * w;
    const yFor = (db) => PAD.top + (Math.min(0, Math.max(DB_FLOOR, db)) / DB_FLOOR) * h;

    ctx2d.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx2d.strokeStyle = grid;
    ctx2d.fillStyle = dim;
    ctx2d.lineWidth = 1;

    for (const db of [0, -20, -40, -60, -80, -100, -120]) {
      const y = yFor(db);
      ctx2d.beginPath();
      ctx2d.moveTo(PAD.left, y);
      ctx2d.lineTo(PAD.left + w, y);
      ctx2d.stroke();
      ctx2d.textAlign = 'right';
      ctx2d.fillText(`${db}`, PAD.left - 4, y + 3);
    }

    for (const hz of [100, 1000, 10000]) {
      const x = xFor(hz);
      ctx2d.beginPath();
      ctx2d.moveTo(x, PAD.top);
      ctx2d.lineTo(x, PAD.top + h);
      ctx2d.stroke();
      ctx2d.textAlign = 'center';
      ctx2d.fillText(formatHz(hz), x, HEIGHT - 6);
    }

    if (!result) {
      ctx2d.textAlign = 'center';
      ctx2d.fillStyle = dim;
      ctx2d.fillText('Press Measure', PAD.left + w / 2, PAD.top + h / 2);
      return;
    }

    // One value per pixel column, and it has to be the *loudest* bin in that column rather than
    // a sample of it: at this width a column can cover thirty bins near Nyquist, and picking one
    // of them would step straight over a narrow spur, which is exactly the shape aliasing has.
    const columns = new Float32Array(Math.ceil(w) + 1).fill(-Infinity);
    for (let k = 1; k < result.db.length; k++) {
      const hz = k * result.binHz;
      if (hz < F_MIN) continue;
      const x = Math.round(xFor(hz) - PAD.left);
      if (x < 0 || x >= columns.length) continue;
      if (result.db[k] > columns[x]) columns[x] = result.db[k];
    }

    ctx2d.strokeStyle = accent;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    let started = false;
    let carried = DB_FLOOR;
    for (let x = 0; x < columns.length; x++) {
      // Low frequencies have fewer bins than columns, leaving gaps with nothing in them; carrying
      // the last value across keeps the trace continuous instead of dropping it to the floor.
      if (columns[x] > -Infinity) carried = columns[x];
      const y = yFor(carried);
      if (!started) {
        ctx2d.moveTo(PAD.left + x, y);
        started = true;
      } else {
        ctx2d.lineTo(PAD.left + x, y);
      }
    }
    ctx2d.stroke();

    // The partials that were asked for, as ticks along the top - so what's between them reads as
    // the anomaly it is without needing a legend.
    //
    // They stop once they are too close together to be separate marks. On a log axis a harmonic
    // series crowds towards the top end until the ticks merge into a bar, which says nothing; the
    // number under the plot covers the whole range either way, so this only gives up the drawing.
    // Individual ticks while they are far enough apart to mean something, and past that a solid
    // band instead. Thinning them out was the first attempt and it was a quiet lie: a tick every
    // few pixels looks like a complete list, so a partial that had no tick of its own appeared to
    // be sitting in a gap between two legitimate ones. A band claims what is true - somewhere in
    // here everything is expected - and claims nothing else.
    ctx2d.strokeStyle = dim;
    let lastTickX = -Infinity;
    let crowdedFrom = 0;
    for (const freq of result.partials) {
      if (freq >= fMax) break;
      const x = xFor(freq);
      if (x - lastTickX < 4) {
        crowdedFrom = freq;
        break;
      }
      lastTickX = x;
      ctx2d.beginPath();
      ctx2d.moveTo(x, PAD.top);
      ctx2d.lineTo(x, PAD.top + 4);
      ctx2d.stroke();
    }

    if (crowdedFrom) {
      const from = xFor(crowdedFrom);
      ctx2d.fillStyle = dim;
      ctx2d.globalAlpha = 0.35;
      ctx2d.fillRect(from, PAD.top, PAD.left + w - from, 3);
      ctx2d.globalAlpha = 1;
    }

    if (Number.isFinite(result.alias.db) && result.alias.freq > 0) {
      const x = xFor(result.alias.freq);
      ctx2d.strokeStyle = cssVar('--cursor', '#c4b5fd');
      ctx2d.setLineDash([2, 2]);
      ctx2d.beginPath();
      ctx2d.moveTo(x, PAD.top);
      ctx2d.lineTo(x, PAD.top + h);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
    }
  }

  /**
   * The spectrogram: time across, frequency up, brightness for level.
   *
   * Painted as a bitmap rather than as rectangles. There are more frames than there are pixel
   * columns and more bins than rows, so every pixel is a *maximum* over whatever fell into it -
   * the same rule the spectrum trace uses, and for the same reason: sampling one of them instead
   * would step over exactly the narrow, brief events that are worth seeing.
   */
  function drawSweep() {
    const dpr = window.devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, WIDTH, HEIGHT);

    const w = WIDTH - PAD.left - PAD.right;
    const h = HEIGHT - PAD.top - PAD.bottom;
    const dim = cssVar('--text-dim', '#9aa0b0');
    ctx2d.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';

    if (!sweep) {
      ctx2d.fillStyle = dim;
      ctx2d.textAlign = 'center';
      ctx2d.fillText('Press Measure', PAD.left + w / 2, PAD.top + h / 2);
      return;
    }

    const fMax = 20000;
    const span = Math.log(fMax / F_MIN);
    // Frequency up the page, so it reads the same way round as the roll beside it.
    const hzForRow = (row, rows) => F_MIN * Math.exp((1 - row / rows) * span);
    const yForHz = (hz) => PAD.top + (1 - Math.log(Math.max(hz, F_MIN) / F_MIN) / span) * h;
    const xForTime = (t) => PAD.left + (t / sweep.duration) * w;

    const pxW = Math.max(1, Math.round(w * dpr));
    const pxH = Math.max(1, Math.round(h * dpr));
    heatCanvas.width = pxW;
    heatCanvas.height = pxH;
    const heatCtx = heatCanvas.getContext('2d');
    const image = heatCtx.createImageData(pxW, pxH);

    const framesPerColumn = sweep.frameCount / pxW;
    for (let x = 0; x < pxW; x++) {
      const firstFrame = Math.floor(x * framesPerColumn);
      const lastFrame = Math.max(firstFrame, Math.min(sweep.frameCount - 1, Math.floor((x + 1) * framesPerColumn)));
      for (let y = 0; y < pxH; y++) {
        const hiBin = Math.min(sweep.bins - 1, Math.round(hzForRow(y, pxH) / sweep.binHz));
        const loBin = Math.min(hiBin, Math.round(hzForRow(y + 1, pxH) / sweep.binHz));
        let best = -Infinity;
        for (let frame = firstFrame; frame <= lastFrame; frame++) {
          const row = frame * sweep.bins;
          for (let bin = loBin; bin <= hiBin; bin++) {
            const value = sweep.db[row + bin];
            if (value > best) best = value;
          }
        }
        const unit = Math.max(0, Math.min(1, 1 - best / HEAT_FLOOR_DB));
        const at = unit * (HEAT.length - 1);
        const low = HEAT[Math.floor(at)];
        const high = HEAT[Math.min(HEAT.length - 1, Math.ceil(at))];
        const mix = at - Math.floor(at);
        const i = (y * pxW + x) * 4;
        image.data[i] = low[0] + (high[0] - low[0]) * mix;
        image.data[i + 1] = low[1] + (high[1] - low[1]) * mix;
        image.data[i + 2] = low[2] + (high[2] - low[2]) * mix;
        image.data[i + 3] = 255;
      }
    }
    heatCtx.putImageData(image, 0, 0);
    ctx2d.drawImage(heatCanvas, PAD.left, PAD.top, w, h);

    ctx2d.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx2d.fillStyle = dim;
    for (const hz of [100, 1000, 10000]) {
      const y = yForHz(hz);
      ctx2d.beginPath();
      ctx2d.moveTo(PAD.left, y);
      ctx2d.lineTo(PAD.left + w, y);
      ctx2d.stroke();
      ctx2d.textAlign = 'right';
      ctx2d.fillText(formatHz(hz), PAD.left - 4, y + 3);
    }
    for (const t of [0, 0.5, 1.0]) {
      ctx2d.textAlign = 'center';
      ctx2d.fillText(`${t.toFixed(1)}s`, xForTime(t), HEIGHT - 6);
    }

    // Where the note was let go, so the tail is readable as a release rather than as a fade.
    const releaseX = xForTime(sweep.releaseAt);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx2d.setLineDash([3, 3]);
    ctx2d.beginPath();
    ctx2d.moveTo(releaseX, PAD.top);
    ctx2d.lineTo(releaseX, PAD.top + h);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    ctx2d.fillStyle = dim;
    ctx2d.textAlign = 'right';
    ctx2d.fillText('let go', releaseX - 3, PAD.top + 9);

    // The instrument's own account of where it sent the cutoff, over the sound that resulted.
    // Drawn as a dashed line and labelled, because it is the intention rather than a measurement,
    // and the only interesting question is whether the two agree.
    if (sweep.trajectory?.points?.length) {
      ctx2d.strokeStyle = cssVar('--cursor', '#c4b5fd');
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash([4, 3]);
      ctx2d.beginPath();
      sweep.trajectory.points.forEach(([t, hz], index) => {
        const x = xForTime(Math.min(t, sweep.duration));
        const y = yForHz(hz);
        if (index === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      });
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.lineWidth = 1;
    }
  }


  return {
    canvas,
    /** What the last measurement produced. A sweep and a spectrum arrive from different renders. */
    setData(next) {
      if (next.sweep !== undefined) sweep = next.sweep;
      if (next.result !== undefined) result = next.result;
    },
    /** Start the rolling average again - the animation restarting is a new picture, not a continuation. */
    resetSmoothing() {
      smoothed = null;
    },
    hasSweep: () => Boolean(sweep),
    sweepDuration: () => sweep?.duration ?? 0,
    sweepFrameSeconds: () => sweep?.frameSeconds ?? 0,
    drawSpectrum,
    drawSweep,
    drawSweepFrame,
  };
}
