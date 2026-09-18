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


/**
 * How far a part may be pushed off the grid, in milliseconds, and why this one duration is not in
 * whole notes like every other length in this project.
 *
 * Everything else here - a note, a slide, a strum, a pattern - is measured in whole notes so that it
 * scales with the tempo: a gesture written at 100bpm is the same gesture at 140. This is the
 * opposite case. It models a *physical* lag - a drummer sitting a fraction behind the click, a
 * section pushing ahead of it - and that lag is a fixed number of milliseconds whichever tempo the
 * song is at. Measured in whole notes it would grow as the song slowed down, which is not what
 * anybody means by "the drums are a touch late".
 *
 * 100ms is the ceiling and the number is the scheduler's, not taste. The transport commits notes one
 * lookahead ahead of the clock (150ms), and a *negative* offset asks for a note earlier than the
 * window that selected it - so an offset past the lookahead would ask the audio clock for a time
 * that has already gone, which Web Audio answers by playing it immediately. At 100ms the earliest a
 * note can be asked for is still 50ms in the future. It is also far more offset than the effect is
 * good for: 10-30ms is the whole expressive range, and past about 50ms it stops being feel and
 * starts being a flam.
 */
export const MAX_TRACK_OFFSET_MS = 100;

export function clampOffsetMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_TRACK_OFFSET_MS, Math.min(MAX_TRACK_OFFSET_MS, Math.round(value)));
}

export function trackOffsetMs(track) {
  return clampOffsetMs(track?.offsetMs);
}

/** Where the part's own material actually stops. */
export function trackExtent(track) {
  let end = 0;
  for (const note of track.notes) end = Math.max(end, note.start + note.length);
  return end;
}

/**
 * The explicit length of one pass, or null for a part that takes its material's.
 *
 * This is a drum machine's **last step**, and it is the one thing the derived period below cannot
 * express. Two things follow from a length that is a consequence of where the notes happen to stop:
 * a pattern can only ever be a whole number of bars, so a twelve-step loop is unwritable; and the
 * loop length changes when you add a note, so putting a crash on the last sixteenth of a four-bar
 * part silently relengthens every pass of it.
 */
export function trackOwnPeriod(track) {
  const explicit = Number(track?.period);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : null;
}

/**
 * The length of one pass.
 *
 * An explicit period wins outright and is **not** rounded to a bar. The derived one is, because a
 * repeat that came back a seventeenth of a bar early would be a mistake rather than a feature, and
 * because it lets a part with a trailing rest repeat on the beat you can hear rather than on its
 * last note. Neither reason survives someone setting the number themselves: a twelve-sixteenth loop
 * against a 4/4 bar is precisely the polyrhythm they were asking for, and rounding it up to sixteen
 * would answer a different question.
 *
 * Material past an explicit period is not played - see notesInWindow - so this really is a last
 * step rather than a hint. It is not deleted either: shorten a pattern, and the steps you cut are
 * still there when you lengthen it again, which is what the same control does on any machine.
 */
export function trackPeriod(track) {
  const explicit = trackOwnPeriod(track);
  if (explicit !== null) return explicit;
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

/**
 * The song beat at which a *material* beat sounds - the inverse of `sourceBeat`.
 *
 * It exists because the forward direction was the only one written, and the reverse was therefore
 * done by hand, in four places, by not doing it at all: a note's `start` was handed straight to the
 * cursor, which is in song time. On a part beginning at bar 1 those are the same number, which is why
 * it went unnoticed - and on a part beginning at bar 5 duplicating a note sent the cursor four bars
 * back, taking the roll's viewport with it.
 *
 * The inverse is not a function of one argument, because a repeated part sounds the same material
 * once per pass: material beat 0 is bar 5, bar 7, bar 9. So the caller says *where it is standing* -
 * `near`, a song beat - and gets the occurrence in that pass. A cursor being moved to a note should
 * land on the copy of it the user is looking at rather than on the first one, which would scroll the
 * roll to the front of the part for no reason the user could see.
 *
 * Bounded at both ends by the passes the part actually has, which is not fussiness: `near` is
 * wherever the cursor happens to be and the part may be four bars of a two-hundred-bar song, so an
 * unclamped pass number answers a question about a pass that does not exist. Standing before the
 * part gives its first pass and standing past the end gives its last, and both of those are inside
 * the part - which is the only place an answer is any use.
 */
export function songBeat(track, local, near = 0) {
  if (!track) return local;
  const begin = trackBegin(track);
  const period = trackPeriod(track);
  if (period <= 0) return begin + local;
  // The epsilon is for a `near` sitting exactly on a pass boundary: sums of thirds and sixteenths
  // can land a hair under it, and a bare floor would then answer with the pass before.
  const pass = Math.floor((near - begin) / period + BEAT_EPSILON);
  const last = trackPasses(track) - 1;
  return begin + Math.min(Math.max(0, pass), last) * period + local;
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
