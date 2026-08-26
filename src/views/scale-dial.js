// One turn of the spiral, with a mode shaded onto it.
//
// The picket needs a picture of a scale, and the honest one is already defined: the spiral pins
// the tonic to the slot C4 occupies and lays every other slot out in semitones from it, so a mode
// shades the same angles whatever it is rooted on. A single turn is therefore the whole of what
// there is to say about a mode - the second and third turns of the real spiral repeat this figure
// outward, note for note - which is why the dial draws one turn and stops.
//
// It draws slots rather than dots. The chord diagram next door flattens to a circle of dots
// because a chord is a set of angles and its radius means nothing; a mode is what one turn of the
// spiral *looks like*, so it is drawn with the spiral's own tapered slots, at the spiral's own
// radius growth, and the taper still points the way pitch is going. Hold a mode chip against the
// spiral panel and they are the same drawing at two sizes.

import {
  NOTES_PER_OCTAVE,
  TOTAL_NOTES,
  pointForIndex,
  radiusForIndex,
  slotShapePath,
} from '../spiral-geometry.js';
import { svgEl, hueForPc, DIAL_TINTS, dialColor } from './common.js';

const SLOT_SPAN = 22; // degrees; the spiral's own, so the gaps between slots read the same
const TIP = { lengthPerWidth: 0.2, maxFraction: 0.5, blunt: 0.2 };
// And the spiral's own thickness compensation, at the same half strength. A slot spans a fixed
// angle, so its arc length grows with its radius; without this the twelve slots of a turn would
// visibly gain ink as they climb and the tonic would read as the slightest note in its own scale.
const WIDTH_FALLOFF = 0.5;

// radiusForIndex spreads its range over all 36 slots, so a dial that wants r0..r1 across the
// twelve of one turn has to hand it a radius three times as far out and let it walk a third of
// the way there. Same function, same growth per semitone - the dial is a real turn of the real
// spiral rather than a circle wearing its clothes.
function geometryOuter(rInner, rOuter) {
  return rInner + (rOuter - rInner) * (TOTAL_NOTES / NOTES_PER_OCTAVE);
}

/**
 * @param inScale  Set of semitones-from-tonic the mode contains (0 is always the tonic)
 * @param size     viewBox side; every radius below is in those units
 * @param labels   position -> string, drawn outside the ring for members only, or null
 * @param hueAt    position -> hue, so the dial honours the Colour by setting like the spiral does
 */
export function buildScaleDial(
  inScale,
  { size = 64, rInner = 15, rOuter = 26, width = 7, labels = null, hueAt = hueForPc, title = '' } = {}
) {
  const cx = size / 2;
  const cy = size / 2;
  const outer = geometryOuter(rInner, rOuter);
  const svg = svgEl('svg', { class: 'scale-dial', viewBox: `0 0 ${size} ${size}` });
  if (title) svg.appendChild(svgEl('title', {})).textContent = title;

  for (let n = 0; n < NOTES_PER_OCTAVE; n++) {
    const member = inScale.has(n);
    // The tonic is a lifted member, never a lit one: on the spiral proper "bright" means a note
    // is sounding, and a dial has nothing sounding on it. Three tiers, same order.
    const tint = !member ? DIAL_TINTS.off : n === 0 ? DIAL_TINTS.tonic : DIAL_TINTS.member;
    const thickness = width * Math.pow(rInner / radiusForIndex(n, rInner, outer), WIDTH_FALLOFF);
    svg.appendChild(
      svgEl('path', {
        class: `scale-dial__slot${member ? '' : ' scale-dial__slot--outside'}`,
        d: slotShapePath(n, cx, cy, rInner, outer, SLOT_SPAN, thickness, TIP),
        fill: dialColor(tint, hueAt(n)),
      })
    );
  }

  if (labels) {
    // On a circle rather than on the spiral: names set at a growing radius drift outward across
    // the turn and stop reading as one ring of text.
    const r = rOuter + width / 2 + size * 0.075;
    for (let n = 0; n < NOTES_PER_OCTAVE; n++) {
      const text = inScale.has(n) ? labels(n) : null;
      if (!text) continue;
      const { x, y } = pointForIndex(n, cx, cy, r, r);
      const label = svgEl('text', {
        class: `scale-dial__label${n === 0 ? ' scale-dial__label--tonic' : ''}`,
        x: x.toFixed(2),
        y: y.toFixed(2),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      label.textContent = text;
      svg.appendChild(label);
    }
  }

  return svg;
}
