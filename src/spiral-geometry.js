export const NOTES_PER_OCTAVE = 12;
export const TURNS = 3;
export const TOTAL_NOTES = NOTES_PER_OCTAVE * TURNS; // 36 note slots, indices 0..35
export const STEP_ANGLE = 360 / NOTES_PER_OCTAVE; // 30deg per semitone

// n may be fractional (used for sampling smooth paths). Angle is not wrapped mod 360 -
// cos/sin wrap it for us, and leaving it unwrapped is what keeps radius and angle in sync
// for a continuous Archimedean spiral across all 3 turns.
function angleDegForIndex(n) {
  return n * STEP_ANGLE - 90; // -90 so index 0 sits at the top (12 o'clock)
}

export function radiusForIndex(n, rInner, rOuter) {
  const dr = (rOuter - rInner) / TOTAL_NOTES;
  return rInner + n * dr;
}

// How far apart two slots an octave apart sit, radially - the space a slot's stroke and the
// gap to the next turn have to share between them.
export function turnSpacing(rInner, rOuter) {
  return ((rOuter - rInner) / TOTAL_NOTES) * NOTES_PER_OCTAVE;
}

function pointAtRadius(n, cx, cy, r) {
  const rad = (angleDegForIndex(n) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function pointForIndex(n, cx, cy, rInner, rOuter) {
  return pointAtRadius(n, cx, cy, radiusForIndex(n, rInner, rOuter));
}

// Which slot a point lands on - the inverse of pointForIndex, and what dragging a note round
// the spiral needs. It has to be solved in two stages because the spiral is multi-valued: the
// angle alone gives the pitch class, since every turn puts the same pitch class at the same
// angle, and the radius then only has to say *which* turn, which it does far more coarsely
// than it would if it had to resolve a semitone on its own. So a drag that wanders radially
// keeps the pitch class the pointer is actually over, and only crosses an octave when it
// crosses most of the way to the next turn.
//
// Returns an unclamped index: the caller knows how many turns it drew and whether landing off
// the end means clamping or refusing.
export function indexAtPoint(x, y, cx, cy, rInner, rOuter) {
  const deg = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;
  const pc = ((Math.round(deg / STEP_ANGLE) % NOTES_PER_OCTAVE) + NOTES_PER_OCTAVE) % NOTES_PER_OCTAVE;
  const dr = (rOuter - rInner) / TOTAL_NOTES;
  const radial = (Math.hypot(x - cx, y - cy) - rInner) / dr;
  return pc + NOTES_PER_OCTAVE * Math.round((radial - pc) / NOTES_PER_OCTAVE);
}

// Radius at the boundary between turn (boundary-1) and turn (boundary), for the faint
// rings that mark where one octave hands off to the next.
export function turnRingRadius(boundary, rInner, rOuter) {
  return radiusForIndex(boundary * NOTES_PER_OCTAVE, rInner, rOuter);
}

// The outline of one note slot: a band following the spiral across a fixed angular span
// (slotSpanDeg, centred on the note's exact angle), tapering to a point at its leading end -
// the direction pitch increases.
//
// This used to be a stroked arc with round caps, which stopped working once slots got thick.
// A round cap reaches half a stroke width past the end of its path, and on the inner turn
// that is further than the entire gap to the next slot, so neighbours overlapped and every
// slot came out round at the back and shaved flat at the front by whichever was drawn after
// it. Describing the outline directly fixes the overlap, and turns that accidental asymmetry
// into a deliberate one: the point says which way round the spiral pitch is going, without
// needing anything else on screen to compare against.
//
// `tip` is {lengthPerWidth, maxFraction, blunt}; pass null for a plain band with two square
// ends, which is what the invisible hit target wants.
export function slotShapePath(n, cx, cy, rInner, rOuter, slotSpanDeg, width, tip) {
  const half = slotSpanDeg / STEP_ANGLE / 2; // half the slot, in index units
  // Tapering over a length proportional to the slot's own thickness keeps the point the same
  // sharpness on every turn; a fixed angular taper would be a blunt chamfer on the short
  // inner slots and a long spike on the outer ones.
  const arcPerIndex = radiusForIndex(n, rInner, rOuter) * ((STEP_ANGLE * Math.PI) / 180);
  const taper = tip
    ? Math.min(2 * half * tip.maxFraction, (width * tip.lengthPerWidth) / arcPerIndex)
    : 0;
  const taperStart = half - taper;

  // The taper stops short of a needle: `blunt` is the fraction of full width left at the very
  // end, which keeps the point from thinning to a sub-pixel sliver on a small card and softens
  // it into a wedge rather than a spike.
  const widthAt = (t) => {
    if (t <= taperStart) return width;
    const along = (t - taperStart) / taper;
    return width * (1 - along * (1 - tip.blunt));
  };

  const offsets = [];
  const BODY_STEPS = 5;
  const TIP_STEPS = 4;
  for (let i = 0; i <= BODY_STEPS; i++) offsets.push(-half + (taperStart + half) * (i / BODY_STEPS));
  // With no taper the body already runs the full span, so there is nothing left to sample.
  if (taper > 0) {
    for (let i = 1; i <= TIP_STEPS; i++) offsets.push(taperStart + taper * (i / TIP_STEPS));
  }

  const edge = (t, side) => {
    const r = radiusForIndex(n + t, rInner, rOuter) + (side * widthAt(t)) / 2;
    const { x, y } = pointAtRadius(n + t, cx, cy, r);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };

  const out = offsets.map((t, i) => `${i === 0 ? 'M' : 'L'}${edge(t, 1)}`).join('');
  const back = offsets
    .slice()
    .reverse()
    .map((t) => `L${edge(t, -1)}`)
    .join('');
  return `${out}${back}Z`;
}
