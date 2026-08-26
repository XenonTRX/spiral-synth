// Shared vocabulary for anything that draws pitch.
//
// The spiral, the chord reference and the piano roll disagree about almost everything - one is
// polar, one is a grid, one is a flattened circle - but they have to agree about colour, or the
// same note would read as two different notes depending on which one you were looking at. So
// hue and the tiers of lit-ness live here.

import { NOTES_PER_OCTAVE } from '../spiral-geometry.js';
import { getSetting } from '../settings.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export function hueForPc(pc) {
  return pc * (360 / NOTES_PER_OCTAVE);
}

// Three tiers of slot, kept far enough apart that "lit" is never ambiguous. Saturation does
// most of the work: an unlit slot is a desaturated, dark tint of its hue, while a lit one is
// vivid. The tonic is only a lifted unlit track - it must stay clearly duller than any lit
// note, since a bright tonic reads as a note that is switched on.
// `ref` is the reference octave, drawn slightly stronger than the ones either side of it.
export const SLOT_TINTS = {
  track: { sat: 26, light: { ref: 27, other: 19 } },
  tonicTrack: { sat: 36, light: { ref: 40, other: 32 } },
  fill: { sat: 92, light: { ref: 66, other: 57 } },
};

export function slotColor(tint, hue, isRef) {
  return `hsl(${hue}, ${tint.sat}%, ${isRef ? tint.light.ref : tint.light.other}%)`;
}

// The same three tiers again, for a dial an inch across.
//
// A dial has nothing sounding on it, so it only needs the two unlit tiers plus a fade - but it
// cannot borrow them at their own values. SLOT_TINTS is calibrated so that an unlit slot stays
// unmistakably duller than a lit one at 200px, and at 64px against the panel that same tint is a
// dark smudge: the drawing has a twentieth of the area to make its point in and no lit slot
// anywhere to be mistaken for. So the tiers are lifted until a mode's shape reads at a glance,
// and kept in the same order and the same hues, which is the part that has to match.
export const DIAL_TINTS = {
  off: { sat: 12, light: 24 },
  member: { sat: 58, light: 45 },
  tonic: { sat: 88, light: 64 },
};

export function dialColor(tint, hue) {
  return `hsl(${hue}, ${tint.sat}%, ${tint.light}%)`;
}

// Which of the two readings of colour is live is a setting: tie it to the pitch, so
// transposing rotates the palette and a pitch is recognisable anywhere, or tie it to the
// slot, so the palette is nailed down and colour tracks scale degree instead. Unkeyed the two
// coincide, since slot n then holds pitch class n.
export function hueForSlot(slotIndex, pc) {
  if (getSetting('colorMode') === 'slot') return hueForPc(slotIndex % NOTES_PER_OCTAVE);
  return hueForPc(pc);
}

// The radial fade angle guides use. Radial rather than linear so one gradient covers guides
// leaving at any angle; a linear one would need its own per line.
let fadeSeq = 0;

export function appendSpokeFade(svg, cx, cy, r) {
  const id = `spoke-fade-${(fadeSeq += 1)}`;
  const fade = svgEl('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx, cy, r });
  for (const [offset, opacity] of [[0, 1], [0.42, 0.92], [0.74, 0.42], [1, 0]]) {
    fade.appendChild(svgEl('stop', { offset, 'stop-color': '#fff', 'stop-opacity': opacity }));
  }
  const defs = svgEl('defs');
  defs.appendChild(fade);
  svg.appendChild(defs);
  return `url(#${id})`;
}
