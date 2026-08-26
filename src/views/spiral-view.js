// The spiral: 36 semitones as a 3-turn chromatic dial. Angle is pitch class, radius is octave,
// and because both advance together one slot is a semitone and 30 degrees at once.
//
// It used to draw a step - a thing with its own duration and its own set of lit slots. It now
// draws a *moment*: whatever sounds at the cursor. That is a smaller job and a more honest one,
// because the spiral was never good at time and this arrangement asks it to carry none. What it
// gains in exchange is that there is only ever one of it on screen, so it can be full size.
//
// The view knows nothing about the song. It is handed a frame - 36 slots, each already told
// whether it sounds, whether it is a ghost, and where it sits in the key - and it reports
// gestures back as slot indices. Everything about what a gesture *means* is the panel's.

import {
  turnRingRadius,
  slotShapePath,
  pointForIndex,
  radiusForIndex,
  turnSpacing,
  indexAtPoint,
  STEP_ANGLE,
  TOTAL_NOTES,
  NOTES_PER_OCTAVE,
} from '../spiral-geometry.js';
import { getSetting } from '../settings.js';
import { svgEl, slotColor, hueForSlot, appendSpokeFade, SLOT_TINTS } from './common.js';

const SIZE = 200;
const CX = SIZE / 2;
const CY = SIZE / 2;
// The hole in the middle carries no information, so it's kept only as wide as the innermost
// turn needs to stay readable: a slot's arc length is proportional to its radius, and below
// roughly this radius a 22deg slot is shorter than its own stroke width and reads as a blob
// rather than a segment.
const R_INNER = 34;
const R_OUTER = 94;
const SLOT_SPAN = 22; // degrees; leaves an 8deg gap (4 each side) to the next slot
const SPOKE_RADIUS = 97; // just past the outer edge of the outermost slot

// How far the pointer has to travel before a press on a lit slot stops being a click that
// deletes it and becomes a drag that moves it. Generous, because the two gestures have
// opposite outcomes and a shaky hand should not delete a note it meant to move.
const DRAG_THRESHOLD = 5; // viewBox units

// How thick a slot is drawn, in viewBox units. Two things are going on.
//
// `falloff` compensates for the spiral's own geometry. A slot spans a fixed angle, so its arc
// length is proportional to its radius: at a constant thickness the innermost slot carries
// barely a third of the ink of an outermost one, and the same note reads as less significant
// the lower it's played, which is a signal the notation doesn't mean to send. Thickness
// therefore falls off as radius rises. It cannot fully cancel out, though - constant *area*
// needs thickness proportional to 1/r, which works out to about 22 units at the inner turn
// against a 20-unit turn spacing: wider than the gap it has to live in, and nearly twice its
// own arc length, so it stops reading as a segment at all. Half compensation is the most that
// still looks like a spiral.
const SLOT_WIDTH = {
  atInner: 14.5,
  falloff: 0.5, // 0 = every slot the same thickness, 1 = every slot the same area
  refBump: 1.06, // the reference octave stays a touch heavier than its neighbours
  sizeScale: { small: 1.12, medium: 1.06, large: 1 },
};

// The point at the leading end of each slot. Its length is set from the slot's own thickness
// rather than from its angular span, so the point is equally sharp on every turn, and it stops
// at `blunt` of full width rather than running out to a needle - see slotShapePath.
const SLOT_TIP = { lengthPerWidth: 0.2, maxFraction: 0.5, blunt: 0.2 };

/** An empty frame - every slot dark, no key in force. */
export function emptyFrame() {
  return {
    explicit: false,
    slots: Array.from({ length: TOTAL_NOTES }, (_, n) => ({
      pc: n % NOTES_PER_OCTAVE,
      active: false,
      ghost: false,
      degree: null,
      title: '',
    })),
  };
}

/**
 * @param interactive  whether slots respond to the pointer at all
 * @param sizeKey      which slot-thickness compensation to use
 * @param gestures     { toggle(n), dragStart(n), dragTo(from, to), dragEnd(from, to) }
 */
export function createSpiralView({ interactive = true, sizeKey = 'large', gestures = {} } = {}) {
  const svg = svgEl('svg', { class: 'spiral-view', viewBox: `0 0 ${SIZE} ${SIZE}` });
  if (!interactive) svg.classList.add('view--readonly');
  const spokeStroke = appendSpokeFade(svg, CX, CY, SPOKE_RADIUS);

  const guideGroup = svgEl('g', { class: 'guide-group' });
  guideGroup.append(
    svgEl('circle', { class: 'turn-ring', cx: CX, cy: CY, r: turnRingRadius(1, R_INNER, R_OUTER) }),
    svgEl('circle', { class: 'turn-ring', cx: CX, cy: CY, r: turnRingRadius(2, R_INNER, R_OUTER) })
  );
  svg.appendChild(guideGroup);

  const notesGroup = svgEl('g', { class: 'notes-group' });
  svg.appendChild(notesGroup);

  // Over the slots rather than under them: the slots are opaque, lit or not, so a guide drawn
  // underneath would survive only in the gaps and read as a row of ticks instead of a line.
  const spokeGroup = svgEl('g', { class: 'spoke-group' });
  svg.appendChild(spokeGroup);

  // Drawn last so the dots sit above the unlit tracks.
  const ghostGroup = svgEl('g', { class: 'ghost-group' });
  svg.appendChild(ghostGroup);

  const noteEls = [];
  let frame = emptyFrame();
  let cursor = null;

  function slotWidth(n) {
    const r = radiusForIndex(n, R_INNER, R_OUTER);
    const scale = SLOT_WIDTH.sizeScale[sizeKey] ?? 1;
    const isRef = Math.floor(n / NOTES_PER_OCTAVE) === 1;
    return (
      SLOT_WIDTH.atInner *
      Math.pow(R_INNER / r, SLOT_WIDTH.falloff) *
      scale *
      (isRef ? SLOT_WIDTH.refBump : 1)
    );
  }

  // The outline depends on the slot's thickness, so shape and width are one step.
  //
  // The hit target is the note's whole cell rather than the drawn slot: the full 30 degrees it
  // owns and the full radial distance to the turn either side of it, square-ended, so the gaps
  // count as part of whichever note they sit next to and nothing on the spiral is dead space.
  // Cells tile the annulus exactly - a cell is one semitone wide and one octave's radius deep,
  // which is precisely the spacing between neighbours - so no two ever fight over a click.
  function applyNoteGeometry(n) {
    const width = slotWidth(n);
    noteEls[n].shape = slotShapePath(n, CX, CY, R_INNER, R_OUTER, SLOT_SPAN, width, SLOT_TIP);
    noteEls[n].track.setAttribute('d', noteEls[n].shape);
    noteEls[n].hit.setAttribute(
      'd',
      slotShapePath(n, CX, CY, R_INNER, R_OUTER, STEP_ANGLE, turnSpacing(R_INNER, R_OUTER), null)
    );
  }

  function applyNoteColors(n) {
    const slot = frame.slots[n];
    const isRef = Math.floor(n / NOTES_PER_OCTAVE) === 1;
    const hue = hueForSlot(n, slot.pc);
    const isTonic = frame.explicit && slot.degree === 1;
    const trackTint = isTonic ? SLOT_TINTS.tonicTrack : SLOT_TINTS.track;
    noteEls[n].track.setAttribute('fill', slotColor(trackTint, hue, isRef));
    noteEls[n].fill.setAttribute('fill', slotColor(SLOT_TINTS.fill, hue, isRef));
  }

  // Three tiers, and only once a key is actually in force: tonic slots sit a touch above the
  // rest, ordinary scale tones stay as they are, and everything outside the scale fades back.
  function applyScaleMarks(n) {
    const degree = frame.explicit ? frame.slots[n].degree : null;
    noteEls[n].g.classList.toggle('note-slot--off-scale', frame.explicit && degree === null);
    noteEls[n].g.classList.toggle('note-slot--tonic', degree === 1);
  }

  function renderNoteState(n) {
    const slot = frame.slots[n];
    // The fill always covers the whole slot - it marks the note as sounding here, it doesn't
    // encode length, so it's the same outline as the track underneath it.
    if (slot.active) noteEls[n].fill.setAttribute('d', noteEls[n].shape);
    else noteEls[n].fill.removeAttribute('d');
    noteEls[n].g.classList.toggle('note-slot--active', slot.active);
    noteEls[n].title.textContent = slot.title;
  }

  // A hairline from the centre out through each angle that has a note on it. Angle is pitch
  // class and nothing else, so what these draw is the chord's shape stripped of its voicing:
  // the same chord rooted somewhere else is the same figure, just rotated, and that is easier
  // to see in a handful of straight lines than in arcs at three different radii.
  //
  // Octaves collapse: the set is keyed on the angle, so a pitch lit on two turns contributes
  // one line and not a darker one.
  function renderSpokes() {
    spokeGroup.replaceChildren();
    if (getSetting('angleGuides') !== 'on') return;
    const angles = new Set();
    for (let n = 0; n < TOTAL_NOTES; n++) {
      if (frame.slots[n].active) angles.add(n % NOTES_PER_OCTAVE);
    }
    for (const angle of angles) {
      // Equal radii make radiusForIndex constant, so this is just "that angle, that far out".
      const { x, y } = pointForIndex(angle, CX, CY, SPOKE_RADIUS, SPOKE_RADIUS);
      spokeGroup.appendChild(
        svgEl('line', {
          class: 'note-spoke',
          stroke: spokeStroke,
          x1: CX,
          y1: CY,
          x2: x.toFixed(2),
          y2: y.toFixed(2),
        })
      );
    }
  }

  function renderGhosts() {
    ghostGroup.replaceChildren();
    if (getSetting('ghostNotes') !== 'on') return;
    for (let n = 0; n < TOTAL_NOTES; n++) {
      if (!frame.slots[n].ghost || frame.slots[n].active) continue;
      const { x, y } = pointForIndex(n, CX, CY, R_INNER, R_OUTER);
      ghostGroup.appendChild(
        svgEl('circle', { class: 'ghost-note', cx: x.toFixed(2), cy: y.toFixed(2), r: 2.1 })
      );
    }
  }

  function render(next) {
    frame = next;
    for (let n = 0; n < TOTAL_NOTES; n++) {
      applyNoteColors(n);
      applyScaleMarks(n);
      renderNoteState(n);
    }
    renderSpokes();
    renderGhosts();
  }

  // --- pointer ------------------------------------------------------------------------------

  // Client pixels to viewBox units. The SVG is drawn with the default preserveAspectRatio, so
  // it is centred and uniformly scaled inside whatever box CSS gave it; the short side sets the
  // scale and the long one gets the slack split evenly.
  function toViewBox(event) {
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width, rect.height) / SIZE;
    return {
      x: (event.clientX - rect.left - (rect.width - SIZE * scale) / 2) / scale,
      y: (event.clientY - rect.top - (rect.height - SIZE * scale) / 2) / scale,
    };
  }

  function slotAtEvent(event) {
    const { x, y } = toViewBox(event);
    const n = indexAtPoint(x, y, CX, CY, R_INNER, R_OUTER);
    return Math.max(0, Math.min(TOTAL_NOTES - 1, n));
  }

  // A cell reaches half a turn's spacing either side of its own radius, so the drawing occupies
  // an annulus and everything outside it - the hole in the middle, the corners of the box - is
  // genuinely nothing. Without this the arithmetic still returns a slot for those points, and a
  // click in the corner would create a note at the rim.
  function isOnSpiral(event) {
    const { x, y } = toViewBox(event);
    const r = Math.hypot(x - CX, y - CY);
    const margin = turnSpacing(R_INNER, R_OUTER) / 2;
    return r >= R_INNER - margin && r <= R_OUTER + margin;
  }

  // A press on a lit slot is ambiguous until it either moves or doesn't: stay put and it is a
  // click, which deletes; move and it is a drag, which repitches. Both readings have to stay
  // available until the pointer decides, so nothing happens on the way down.
  let drag = null;

  function onPointerDown(event) {
    if (!interactive || event.button !== 0 || !isOnSpiral(event)) return;
    const n = slotAtEvent(event);
    const origin = toViewBox(event);
    drag = { from: n, to: n, origin, moved: false };
    svg.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!drag) return;
    const point = toViewBox(event);
    if (!drag.moved) {
      if (Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) < DRAG_THRESHOLD) return;
      // Only a slot that has something on it can be dragged; a press on an empty slot that
      // wanders is still just a click on that slot, so it stays put and creates there.
      if (!frame.slots[drag.from].active) return;
      drag.moved = true;
      gestures.dragStart?.(drag.from);
    }
    const n = slotAtEvent(event);
    if (n === drag.to) return;
    drag.to = n;
    gestures.dragTo?.(drag.from, n);
  }

  function onPointerUp(event) {
    if (!drag) return;
    const gesture = drag;
    drag = null;
    if (svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (gesture.moved) gestures.dragEnd?.(gesture.from, gesture.to);
    else gestures.toggle?.(gesture.from);
  }

  function onPointerCancel() {
    if (drag?.moved) gestures.dragEnd?.(drag.from, drag.from);
    drag = null;
  }

  function buildNote(n) {
    const g = svgEl('g', { class: 'note-slot' });
    // Outlines are left to applyNoteGeometry - they depend on the slot's own radius.
    const hit = svgEl('path', { class: 'note-hit' });
    const track = svgEl('path', { class: 'note-track' });
    const fill = svgEl('path', { class: 'note-fill' });
    const title = svgEl('title', {});

    g.append(hit, track, fill, title);
    notesGroup.appendChild(g);
    noteEls[n] = { g, track, fill, hit, title, shape: '' };
    applyNoteGeometry(n);
  }

  for (let n = 0; n < TOTAL_NOTES; n++) buildNote(n);
  render(frame);

  if (interactive) {
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerCancel);
  }

  return {
    element: svg,
    render,

    // Where the keyboard is pointing. It belongs to the editing session rather than to any one
    // moment in the song - you walk it up and down the spiral and press Enter - so the view
    // only draws it and the panel decides where it is.
    setCursor(n) {
      if (cursor !== null) noteEls[cursor]?.g.classList.remove('note-slot--cursor');
      cursor = n !== null && n >= 0 && n < TOTAL_NOTES ? n : null;
      if (cursor !== null) noteEls[cursor].g.classList.add('note-slot--cursor');
    },

    // The slot being dragged, drawn as an outline at its destination so you can see where the
    // note will land before letting go.
    setDragTarget(n) {
      for (let i = 0; i < TOTAL_NOTES; i++) noteEls[i].g.classList.toggle('note-slot--drag', i === n);
    },
  };
}
