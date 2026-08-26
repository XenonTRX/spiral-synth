// The recording, drawn behind the notes.
//
// A recording under the roll is what makes transcribing reading rather than guessing. See
// reference.js for what the picture is and spectrum.js for how it is made; what happens here is
// only the placing - and the placing is the reason the picture was folded onto a semitone axis in
// the first place. Both of its axes come out linear against the roll's - a column is a fixed slice
// of the file and a row is a fixed fraction of a semitone - so putting it on screen is one
// `drawImage` with a source rectangle and a destination rectangle, and the browser scales it on
// the GPU.
//
// The canvas is the size of the *viewport*, not of the song. A four-minute song at this zoom is
// forty thousand pixels wide, which is past what a canvas will allocate and would be a waste of it
// anyway - so it is parked over the visible area with a transform, exactly the way the ruler and
// the key gutter follow the scroll, and only what can be seen is ever drawn.
//
// It is its own file because it is its own concern: it reads the roll's geometry and writes to one
// canvas, and it touches nothing else the roll owns. The geometry arrives as `metrics` rather than
// being imported, so the roll stays the single owner of what a row is worth in pixels.

import { beatForColumn, columnForBeat, getReferenceParam, referenceImage } from './reference.js';

/**
 * The spectrum layer for one roll.
 *
 * `metrics` is the roll's geometry, read live: `{ rows, rowHeight, midiLow, midiHigh, xForBeat,
 * beatForX, yForMidi }`. Zoom changes what `xForBeat` answers, so these are called rather than
 * captured.
 */
export function createRollSpectrum({ canvas, scroller, metrics }) {
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    canvas.style.transform = `translate(${scroller.scrollLeft}px, ${scroller.scrollTop}px)`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const picture = referenceImage();
    if (!picture) return;

    // The columns that can be seen, clamped to the ones that exist. A file shorter than the song
    // simply stops, and the roll past its end is empty rather than showing the last column smeared
    // across the rest of the bar.
    const left = columnForBeat(metrics.beatForX(scroller.scrollLeft));
    const right = columnForBeat(metrics.beatForX(scroller.scrollLeft + width));
    const from = Math.max(0, Math.floor(left));
    const to = Math.min(picture.columns, Math.ceil(right));
    if (to <= from) return;

    const x0 = metrics.xForBeat(beatForColumn(from)) - scroller.scrollLeft;
    const x1 = metrics.xForBeat(beatForColumn(to)) - scroller.scrollLeft;
    ctx.globalAlpha = picture.opacity;
    // Smoothed when the picture is being shrunk, because then a pixel of screen is several columns
    // and dropping all but one of them would make a note appear and disappear as you scrolled.
    // Crisp when it is being stretched, so a partial stays a line instead of becoming a cloud.
    ctx.imageSmoothingEnabled = x1 - x0 < to - from;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      picture.canvas,
      from,
      0,
      to - from,
      picture.rows,
      x0,
      -scroller.scrollTop,
      x1 - x0,
      metrics.rows * metrics.rowHeight,
    );
    ctx.globalAlpha = 1;
    drawBandEdges(width);
  }

  // Where the band stops, when it is not the whole keyboard. Without them a narrow band looks like
  // a recording that happens to have nothing above or below - the two lines are what say the
  // emptiness was asked for.
  function drawBandEdges(width) {
    const low = getReferenceParam('bandLow');
    const high = getReferenceParam('bandHigh');
    if (low <= metrics.midiLow && high >= metrics.midiHigh) return;
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.45)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (const y of [metrics.yForMidi(high), metrics.yForMidi(low) + metrics.rowHeight]) {
      const at = Math.round(y - scroller.scrollTop) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, at);
      ctx.lineTo(width, at);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** Coalesced to one draw a frame: a scroll fires far more often than the screen refreshes. */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  // The viewport's size is the canvas's size, and nothing else in the roll needs to hear about a
  // window resize - every other layer is laid out by the grid.
  new ResizeObserver(() => schedule()).observe(scroller);

  return { draw, schedule };
}
