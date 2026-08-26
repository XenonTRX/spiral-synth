// A part's two fades, drawn as the part.
//
// These were a pair of steppers reading `in 2` and `out –`, and the complaint that replaced them -
// that the design was unwieldy - is worth writing down, because it is about the *kind* of value a
// fade is. What you want to know about one is a proportion: is the part fully in before the chorus,
// does it take half of its last pass to leave. A length in bars only answers that after arithmetic,
// and setting it meant clicking `+` once per bar and then imagining the result. So the part is drawn
// as a box, its fades are the two corners, and you drag them.
//
// **The curve on screen is `fadeGainAt` itself, sampled** - not a straight line standing in for it.
// That is the whole reason to draw rather than to illustrate: the function the audio schedules is the
// function you are looking at, so the picture cannot drift from the sound. Two things fall out of it.
// A pair of fades too long for the part draws as the squeezed shape the audio really plays, instead of
// as two numbers that look fine and silently mean something else. And the drawing had to pick a
// vertical axis, which forced the honest question of what a fade's shape even is - see `yFor`.
//
// **One widget at two scales.** The rack row shows the part in 112px, which is a summary you can read
// four of at a glance and drag to the nearest bar. The roll shows the same part at the roll's own
// scale, where a bar is as wide as the grid says and the fade can be placed on the beat. They are the
// same code with a different width and a different snap, which is the only reason the two can never
// disagree - the first version of this had the 112px box only, and setting a fade to anything but a
// whole bar meant doing it in a control four pixels wide per beat.
//
// Nothing in here knows what a song or a track is. It is handed a span and two lengths, in whole
// notes, and reports back a length in whole notes; the caller owns the track, the undo entry and the
// snap. That is the same split the level fader next to it uses, and it is what makes this file
// testable in a page of its own with three numbers.

import { FADE_FLOOR_DB, fadeGainAt, fadesWithin } from './automation.js';
import { gainToDb } from './decibels.js';
import { barBeats, pulseBeats } from './meter.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// The box in CSS pixels, and the drawing's user units, are deliberately the same numbers - the viewBox
// tracks the element's size - so no gesture here has to convert between what is drawn and where the
// pointer is. The defaults are the rack's summary size.
const DEFAULT_WIDTH = 112;
const DEFAULT_HEIGHT = 22;
// Where full level sits. Not the very top: the grips are centred on it and need somewhere to be that
// is not the border.
const TOP = 3.5;
// Enough to draw a straight line straight and a bend as a bend. The curve is redrawn on every render
// of whatever is showing it, so this is 49 points and not 4096.
const POINTS = 49;
// A ramp narrower than this gets no number over it: the digits would collide with the corner, and at
// that size the shape is the better readout anyway.
const MIN_LABEL_PX = 17;
// Bar lines closer together than this are a texture rather than a count, so they thin out to every
// second bar, every fourth, and so on.
const MIN_TICK_PX = 7;
// A press that never travels this far is a press, not a drag. See the pointerdown handler.
const DRAG_SLOP_PX = 2;

const OTHER = { fadeIn: 'fadeOut', fadeOut: 'fadeIn' };

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The default grid a dragged corner lands on: bars, or the felt pulse with ⇧ held.
 *
 * Bars are the unit an arrangement is written in and the unit the region steppers move in, and a fade
 * of two bars and a bit is almost always a mistake - but "half a bar" is a real fade on a two-bar part,
 * so there is a finer grid a modifier away. A caller drawing at a scale where finer than that is
 * legible passes its own; the roll passes the Snap menu.
 */
export function barSnap(event) {
  return (event?.shiftKey ? pulseBeats() : barBeats()) || 1;
}

/** A length in bars, as the rack writes every other length: exact when it is whole. */
function barsText(beats, bar) {
  const bars = beats / bar;
  return Number.isInteger(bars) ? String(bars) : bars.toFixed(2);
}

function lengthText(beats, bar) {
  if (!(beats > 0)) return 'none';
  const bars = beats / bar;
  return `${barsText(beats, bar)} bar${bars === 1 ? '' : 's'}`;
}

/**
 * Where a gain sits on the box, vertically.
 *
 * **The axis is decibels**, from full level at the top to the fade's own floor at the bottom, which is
 * the one choice in this file that changes what you see. A fade is linear in dB (see `fadeGainAt`), so
 * on a linear *amplitude* axis it draws as a hockey stick - flat along the bottom for three quarters
 * of its length, because the first 30 of its 60dB happen in the top thirtieth of the amplitude range.
 * That drawing is not wrong, it is just answering a question nobody asked. On a dB axis the same
 * function is a straight diagonal, and the slope of it is dB per bar - which is what a fade *is*, and
 * the same axis as the level fader sitting two inches to the right in the same row.
 *
 * So a bend in this drawing means the arithmetic bent, and today exactly one thing bends it: two fades
 * that do not fit, which are summed in dB and therefore draw as a triangle with its apex short of the
 * top. That is the case the numbers hid.
 */
function yFor(gain, height) {
  const unit = clamp01(1 - (gain > 0 ? gainToDb(gain) : FADE_FLOOR_DB) / FADE_FLOOR_DB);
  return TOP + (1 - unit) * (height - TOP);
}

/**
 * One fade control.
 *
 * `onFade(key, beats)` is called with 'fadeIn' or 'fadeOut' and a length in whole notes, continuously
 * during a drag. `onGesture()` is called once per gesture, before the first write, which is where the
 * caller puts its undo entry - once for the whole drag rather than once per pointermove. `snapFor` is
 * handed the event and returns the grid to land on, in whole notes.
 */
export function createFadeLane({
  onFade,
  onGesture,
  snapFor = barSnap,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
} = {}) {
  const element = document.createElement('div');
  element.className = 'fade-lane';

  // aria-hidden: the drawing is a picture of the two values the grips already report, and a screen
  // reader hearing it twice would be worse than not hearing it at all.
  const svg = svgEl('svg', { class: 'fade-lane__plot', 'aria-hidden': 'true' });
  const fill = svgEl('path', { class: 'fade-lane__fill' });
  const line = svgEl('path', { class: 'fade-lane__line' });
  svg.append(fill, line);

  const grips = {};
  const readouts = {};
  for (const key of ['fadeIn', 'fadeOut']) {
    const readout = svgEl('text', { class: 'fade-lane__read', 'text-anchor': 'middle' });
    svg.appendChild(readout);
    readouts[key] = readout;

    // A real focusable control per corner, so the fades are still reachable and settable from the
    // keyboard now that the four stepper buttons are gone. `role="slider"` rather than a range input
    // because there is no laying a range input on a diagonal, and because the two of them share one
    // pointer surface: every gesture is handled by the box, which is the only thing that knows which
    // corner you were nearer to. Hence pointer-events: none in the stylesheet.
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'fade-lane__grip';
    grip.dataset.fade = key;
    grip.setAttribute('role', 'slider');
    grip.setAttribute('aria-label', key === 'fadeIn' ? 'Fade in, bars' : 'Fade out, bars');
    grip.setAttribute('aria-valuemin', '0');
    grip.addEventListener('keydown', (event) => onKey(key, event));
    grips[key] = grip;
  }

  element.append(svg, grips.fadeIn, grips.fadeOut);

  // What was last shown, so a gesture can answer "how far can this one go" without asking the song
  // again. Both lengths are already clamped to the span by whoever showed them.
  let span = 0;
  let shown = { fadeIn: 0, fadeOut: 0 };
  let box = { width: 0, height: 0 };

  const xFor = (beats) => (span > 0 ? box.width * clamp01(beats / span) : 0);

  /** How long this fade may be: whatever the other one has left of the region. */
  const room = (key) => Math.max(0, span - Math.max(0, shown[OTHER[key]]));

  function resize(nextWidth, nextHeight) {
    if (box.width === nextWidth && box.height === nextHeight) return;
    box = { width: nextWidth, height: nextHeight };
    element.style.width = `${nextWidth}px`;
    element.style.height = `${nextHeight}px`;
    svg.setAttribute('viewBox', `0 0 ${nextWidth} ${nextHeight}`);
    for (const key of ['fadeIn', 'fadeOut']) {
      // Just above the middle, in the open half of whichever wedge the number belongs to.
      readouts[key].setAttribute('y', (nextHeight * 0.55).toFixed(2));
    }
  }

  resize(width, height);

  function show({ span: nextSpan = 0, fadeIn = 0, fadeOut = 0, width: nextWidth, height: nextHeight } = {}) {
    resize(nextWidth ?? box.width, nextHeight ?? box.height);
    span = Number.isFinite(nextSpan) && nextSpan > 0 ? nextSpan : 0;
    shown = { fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut) };

    const bar = barBeats() || 1;
    // Drawn from the *effective* pair rather than the stored one, because that is what is playing.
    const [into, outOf] = fadesWithin(0, span, shown.fadeIn, shown.fadeOut);
    const usable = span > 0;

    element.classList.toggle('is-empty', !usable);
    element.classList.toggle('is-on', into > 0 || outOf > 0);
    element.title = usable
      ? `Fade in ${lengthText(into, bar)}, fade out ${lengthText(outOf, bar)}`
        + ' — drag a corner, ⇧ for a finer grid, double-click to clear'
      : 'This part has no length yet, so there is nothing to fade';

    // Bar lines, thinned until they are legible. The stride is decided here because the stylesheet
    // cannot know how many bars the box is showing.
    const perBar = usable ? (box.width * bar) / span : 0;
    const stride = perBar > 0 ? Math.max(1, Math.ceil(MIN_TICK_PX / perBar)) : 0;
    element.style.setProperty('--fade-tick', stride > 0 ? `${(perBar * stride).toFixed(2)}px` : '0');

    if (usable) {
      const points = [];
      for (let i = 0; i < POINTS; i++) {
        const beat = (span * i) / (POINTS - 1);
        const gain = fadeGainAt(beat, { begin: 0, end: span, fadeIn: into, fadeOut: outOf });
        points.push(`${((box.width * i) / (POINTS - 1)).toFixed(2)},${yFor(gain, box.height).toFixed(2)}`);
      }
      line.setAttribute('d', `M${points.join('L')}`);
      fill.setAttribute('d', `M0,${box.height}L${points.join('L')}L${box.width},${box.height}Z`);
    } else {
      line.removeAttribute('d');
      fill.removeAttribute('d');
    }

    for (const [key, value] of [['fadeIn', into], ['fadeOut', outOf]]) {
      const ramp = xFor(value);
      const grip = grips[key];
      grip.style.left = `${(key === 'fadeIn' ? ramp : box.width - ramp).toFixed(2)}px`;
      grip.disabled = !usable;
      grip.title = `${key === 'fadeIn' ? 'Fade in' : 'Fade out'} — ${lengthText(value, bar)}`;
      grip.setAttribute('aria-valuemax', barsText(room(key), bar));
      grip.setAttribute('aria-valuenow', barsText(value, bar));
      grip.setAttribute('aria-valuetext', lengthText(value, bar));
      // Only over a ramp wide enough to hold it, and only when there is a fade to count.
      readouts[key].textContent = value > 0 && ramp >= MIN_LABEL_PX ? barsText(value, bar) : '';
      readouts[key].setAttribute('x', (key === 'fadeIn' ? ramp / 2 : box.width - ramp / 2).toFixed(2));
    }
  }

  const ratioAt = (event) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 ? clamp01((event.clientX - rect.left) / rect.width) : 0;
  };

  /** Snap, then fit. In that order: `End` on a part that is 1.88 bars long has to land on 1.88. */
  function commit(key, beats, unit) {
    const step = unit > 0 ? unit : 1;
    const snapped = Math.round(beats / step) * step;
    onFade?.(key, Math.max(0, Math.min(room(key), snapped)));
  }

  /**
   * Which corner a press at `t` across the box meant: the nearer of the two, in song time.
   *
   * With no fades set both grips are in the corners, so this is "the left half is the fade in" - which
   * is what anyone dragging inwards from an edge expects. With a long fade in already set, the press
   * that lands just inside it belongs to it rather than to the corner it started from.
   */
  function nearest(t) {
    const [into, outOf] = fadesWithin(0, span, shown.fadeIn, shown.fadeOut);
    return Math.abs(t * span - into) <= Math.abs((1 - t) * span - outOf) ? 'fadeIn' : 'fadeOut';
  }

  let drag = null;

  element.addEventListener('pointerdown', (event) => {
    if (!(span > 0) || event.button !== 0) return;
    // Armed here, committed on the first real movement - the roll's rule for every gesture on it, and
    // here it is what stops a stray click in the middle of the box from inventing a four-bar fade.
    // The press still does one useful thing: it focuses the corner it was nearest to, so the arrow
    // keys pick up where the pointer left off. Focusing from a pointerdown handler on an element whose
    // grips are `pointer-events: none` does survive the mouse events that follow it - checked, because
    // the whole keyboard path hangs off it.
    event.preventDefault();
    const key = nearest(ratioAt(event));
    drag = { key, from: event.clientX, live: false };
    element.setPointerCapture(event.pointerId);
    grips[key].focus();
  });

  element.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (!drag.live) {
      if (Math.abs(event.clientX - drag.from) < DRAG_SLOP_PX) return;
      drag.live = true;
      element.classList.add('is-dragging');
      onGesture?.();
    }
    const t = ratioAt(event);
    commit(drag.key, (drag.key === 'fadeIn' ? t : 1 - t) * span, snapFor(event));
  });

  const release = (event) => {
    if (!drag) return;
    drag = null;
    element.classList.remove('is-dragging');
    if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };
  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);

  // The way back to none, which a drag can only approximate: a fade of a third of a bar looks a lot
  // like no fade at all and sounds nothing like it.
  element.addEventListener('dblclick', (event) => {
    if (!(span > 0)) return;
    const key = nearest(ratioAt(event));
    if (!(shown[key] > 0)) return;
    onGesture?.();
    onFade?.(key, 0);
  });

  function onKey(key, event) {
    if (!(span > 0)) return;
    const unit = snapFor(event);
    const current = Math.max(0, shown[key]);
    let next;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - unit;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + unit;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = room(key);
    else return;
    event.preventDefault();
    onGesture?.();
    commit(key, next, unit);
  }

  return { element, show };
}
