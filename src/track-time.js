// Where a part sits in the song, and how its material folds onto that.
//
// Eleven functions that are all pure functions of one `track`: they read its notes, its `begin`
// and `end`, and its fades, and they answer questions about time. Nothing here reads the song's
// cursor, its selection or its other parts, which is why they could come out of `createSong`
// without carrying any of it along - and why they can be checked directly in a test rather than
// only through an editor.
//
// The distinction they all turn on is **song time versus material time**. A part's material starts
// at its own zero; the part itself enters the song at `begin`, and may repeat. `sourceBeat` is the
// fold between the two, and getting it wrong is silent rather than loud - a marquee that selects
// the wrong notes, or a stretch handle drawn in the wrong place, both of which happened.
//
// `song.js` re-exposes all of these as methods, so callers still say `song.trackBegin(track)`.

import { ceilToBar } from './meter.js';

// Starts are sums of halves, thirds and sixteenths, so a note placed on a beat and a cursor
// walked to the same beat can land a hair either side of each other in floating point.
export const BEAT_EPSILON = 1e-9;


/** Where the part's own material actually stops. */
export function trackExtent(track) {
  let end = 0;
  for (const note of track.notes) end = Math.max(end, note.start + note.length);
  return end;
}

// The length of one pass. Rounded up to a whole bar, because a repeat that came back a
// seventeenth of a bar early would be a mistake rather than a feature, and because it lets a
// part with a trailing rest repeat on the beat you can hear rather than on its last note.
export function trackPeriod(track) {
  const extent = trackExtent(track);
  if (extent <= 0) return 0;
  return ceilToBar(extent);
}

/** Does this part have a length of its own, rather than borrowing its material's? */
export function trackIsPinned(track) {
  if (track?.end !== null && track?.end !== undefined) return true;
  return Math.max(1, Math.round(Number(track?.legacyRepeat) || 1)) > 1;
}

export function trackBegin(track) {
  const begin = Number(track?.begin);
  return Number.isFinite(begin) && begin > 0 ? begin : 0;
}

/**
 * How long the part occupies, from its own beginning.
 *
 * Three answers, in order of authority. An explicit `end` wins, because someone said so. Failing
 * that, a legacy `repeat` count from a save written before regions existed - resolved here rather
 * than at load time, so that loading never has to know the meter, and written out as a plain
 * `end` the next time the song is saved. Failing both, the material's own extent: a part nobody
 * has arranged yet is exactly as long as what is in it, which is what makes a new part grow as
 * you write into it.
 */
export function trackSpan(track) {
  // `pinned` rather than a Number.isFinite check on the value itself: `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so an unset end read as "ends where it begins" and every part
  // with no explicit end had a span of nothing.
  const pinned = track?.end !== null && track?.end !== undefined;
  const end = Number(track?.end);
  if (pinned && Number.isFinite(end)) return Math.max(0, end - trackBegin(track));
  const legacy = Math.max(1, Math.round(Number(track?.legacyRepeat) || 1));
  if (legacy > 1) return trackPeriod(track) * legacy;
  return trackExtent(track);
}

export function trackEnd(track) {
  return trackBegin(track) + trackSpan(track);
}

/**
 * One of the two fade lengths, in whole notes, clamped to something a region can contain.
 *
 * Clamped at the span rather than left free, because a fade longer than the part is a number with no
 * meaning - and because `fadeGainAt` scales the pair to fit anyway, so an unclamped value would be
 * silently reinterpreted and the rack would show a figure the audio was not using.
 */
export function fadeOf(track, key) {
  const value = Number(track?.[key]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, trackSpan(track));
}

/**
 * How many passes of the material fit in the span - the number the rack shows as x2, x3.
 *
 * Derived rather than stored, which is the whole point of the change: a part's length used to be
 * a count of whole passes, so it could only ever stop on a pass boundary. A span can stop
 * anywhere, and the count is a consequence of it. The last pass is very often partial, and that
 * is what a fill is.
 */
export function trackPasses(track) {
  const period = trackPeriod(track);
  const span = trackSpan(track);
  if (period <= 0 || span <= 0) return 1;
  return Math.max(1, Math.ceil(span / period - BEAT_EPSILON));
}

/**
 * The beat in the part's own material that a beat in the song lands on.
 *
 * Repeats are a projection, not copies, so anything that asks "what is here" or writes "put
 * this here" folds the question back onto the first pass. That is what makes editing inside a
 * repeat behave the way looping a clip does in any DAW: the note you add in pass three lands
 * in the material, and every pass - including the one you were looking at - redraws with it.
 */
export function sourceBeat(track, beat) {
  if (!track) return beat;
  // Two transformations, and the order matters: shift out of song time into the part's own time,
  // then fold that onto the first pass. `begin` is the new half - before regions existed a part's
  // material and the song shared an origin, and now it does not.
  const local = beat - trackBegin(track);
  const period = trackPeriod(track);
  if (period <= 0) return local;
  // Outside the region there is no pass to fold onto, so the answer is simply the part's own
  // time - which is what lets you write notes into a part beyond where it currently stops, and
  // then hear them by moving its end.
  if (local < 0 || local >= trackSpan(track) - BEAT_EPSILON) return local;
  return local - Math.floor(local / period) * period;
}

/** Is this part sounding at this song beat at all? */
export function trackCovers(track, beat) {
  return beat >= trackBegin(track) - BEAT_EPSILON && beat < trackEnd(track) - BEAT_EPSILON;
}

/** Every pass's offset, first included - what the roll draws and the transport fires. */
export function repeatOffsets(track) {
  const begin = trackBegin(track);
  const period = trackPeriod(track);
  const span = trackSpan(track);
  if (period <= 0 || span <= 0) return [begin];
  const out = [];
  for (let k = 0; k * period < span - BEAT_EPSILON; k++) out.push(begin + k * period);
  return out.length ? out : [begin];
}
