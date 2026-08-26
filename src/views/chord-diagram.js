// A chord's shape, on its own.
//
// This drawing was born in the chord palette and stayed there while it had one reader. The key
// picket is the second, and a chord it lists has to be the same picture as the chord you press
// under the spiral or the two panels would be showing the same object in two hands - so the
// figure moved here and both now ask for it.
//
// It is one flat turn rather than a spiral. Angle is pitch class and nothing else, so octaves
// carry no information about a chord's *shape*: collapsing them is what makes the congruence
// visible, since the same chord rooted anywhere is then the same polygon, rotated. The spiral
// proper is what the key dial draws, because a mode is about where a turn is shaded and that
// needs the turn.

import { pointForIndex } from '../spiral-geometry.js';
import { svgEl, hueForPc, appendSpokeFade } from './common.js';

const SIZE = 92;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 34; // rInner === rOuter: a flat 12-position circle, not a spiral
const SPOKE_R = 41; // angle guides run just past the tone dots

/**
 * @param intervals  semitone offsets from the chord's root
 * @param root       where the root sits on the dial; 0 draws the chord at an abstract root, and
 *                   anything else places it where it actually falls in a key, tonic at 12
 *                   o'clock - the same figure, rotated, which is the claim being made
 * @param ring       positions to draw as the background ring, or null for all twelve. The key
 *                   picket passes the mode, so a chord is seen sitting inside the scale it came
 *                   from rather than floating on a chromatic dial
 * @param hueAt      position -> hue, so a diagram inside a key can honour the Colour by setting
 */
export function buildChordDiagram(intervals, { root = 0, ring = null, hueAt = hueForPc } = {}) {
  const svg = svgEl('svg', { class: 'chord-chip__diagram', viewBox: `0 0 ${SIZE} ${SIZE}` });
  const spokeStroke = appendSpokeFade(svg, CX, CY, SPOKE_R);

  const positions = intervals.map((interval) => (root + interval) % 12);

  // The same angle guides the spiral draws, so the reference and the thing it is a reference
  // for speak one language - octaves already collapsed here, since the diagram is one turn.
  for (const position of new Set(positions)) {
    const { x, y } = pointForIndex(position, CX, CY, SPOKE_R, SPOKE_R);
    svg.appendChild(
      svgEl('line', {
        class: 'chord-chip__spoke',
        stroke: spokeStroke,
        x1: CX,
        y1: CY,
        x2: x.toFixed(2),
        y2: y.toFixed(2),
      })
    );
  }

  for (let position = 0; position < 12; position++) {
    const member = !ring || ring.has(position);
    const { x, y } = pointForIndex(position, CX, CY, R, R);
    svg.appendChild(
      svgEl('circle', {
        class: member ? 'chord-chip__ghost' : 'chord-chip__ghost chord-chip__ghost--outside',
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: member ? 2.2 : 1.4,
      })
    );
  }

  const points = positions.map((position) => pointForIndex(position, CX, CY, R, R));
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z';
  svg.appendChild(svgEl('path', { class: 'chord-chip__line', d }));

  positions.forEach((position, index) => {
    const { x, y } = pointForIndex(position, CX, CY, R, R);
    svg.appendChild(
      svgEl('circle', {
        class: 'chord-chip__tone',
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: index === 0 ? 5 : 4,
        fill: `hsl(${hueAt(position)}, 80%, ${index === 0 ? 65 : 55}%)`,
      })
    );
  });

  return svg;
}
