import { createListeners } from './observable.js';
// How much horizontal room one whole note is worth - the roll's only zoom.
//
// Width follows duration everywhere, with no equal-width mode to fall back to. The step
// sequencer needed one, because a spiral had a size below which it stopped being worth drawing
// and a lane of them could not honestly be to scale and legible at once. Nothing in the roll
// has that floor: a note is a rectangle, and a rectangle is still a rectangle at three pixels,
// so the axis can just be an axis.

const DEFAULT_PX_PER_WHOLE = 480; // a 1/4 comes out 120px, a 1/16 comes out 30px
export const MIN_PX_PER_WHOLE = 96;
export const MAX_PX_PER_WHOLE = 3840;
const ZOOM_STEP = 1.25;

let pxPerWhole = DEFAULT_PX_PER_WHOLE;
const { subscribe: subscribeTimeScale, emit } = createListeners();
export { subscribeTimeScale };

export function getPxPerWhole() {
  return pxPerWhole;
}

export function setPxPerWhole(value) {
  const next = Math.max(MIN_PX_PER_WHOLE, Math.min(MAX_PX_PER_WHOLE, Math.round(value)));
  if (next === pxPerWhole) return;
  pxPerWhole = next;
  emit(pxPerWhole);
}

/** One notch in or out. Geometric, so each press changes the view by the same proportion. */
export function zoomBy(direction) {
  setPxPerWhole(direction > 0 ? pxPerWhole * ZOOM_STEP : pxPerWhole / ZOOM_STEP);
}

export { DEFAULT_PX_PER_WHOLE };
