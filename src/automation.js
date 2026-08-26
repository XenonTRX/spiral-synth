// Everything that is a function of *where you are in the song* rather than of what note you played.
//
// Two features arrived at once and turned out to be one mechanism. A part that fades in over four bars
// and a filter that sweeps once a bar are both a number that depends on the song position and on
// nothing else - not on the wall clock, not on when the AudioContext happened to start, not on which
// note is sounding. Writing them that way buys three things that are each worth having on their own:
//
//   - **A render sounds like what you heard.** A free-running LFO started when its effect was built
//     has a phase that depends on when you opened the tab, so the export would sweep from somewhere
//     else. Here the sweep at bar 5 is the sweep at bar 5.
//   - **A loop repeats.** Pass two is the same as pass one because the function is the same and the
//     positions are the same.
//   - **Tempo changes come free.** The position is in whole notes, so nothing here has ever heard of
//     BPM. Speed the song up and a one-bar sweep is still one bar.
//
// **How it reaches the audio.** The transport already commits notes a window of song time at a time,
// and already splits a window at the loop seam because the two sides of the seam are different places
// in the song. That is exactly the guarantee automation needs, so it rides along: each window becomes
// one `setValueCurveAtTime` per moving parameter, sampled from the functions below. Verified before it
// was built on: two curve spans that abut exactly are accepted, and one that overlaps by a hair throws
// `NotSupportedError` - which is why the windows abutting matters, and why nothing here ever cancels a
// curve that has already started (measured, `cancelScheduledValues` inside a running curve removes the
// whole curve and the parameter jumps back to its plain value).
//
// So a knob moved during playback takes effect at the next window, up to a lookahead - 150ms - later.
// That is a deliberate trade rather than an oversight: the alternative is cancelling a live curve,
// which is the click above.

/** How low a fade goes before it is simply off. The same floor the level faders use, for one reason. */
export const FADE_FLOOR_DB = -60;

/**
 * How often a curve is sampled, in points per second.
 *
 * The fastest thing here is a 1/16 sweep at 300 BPM, which is 20Hz, so 240 gives it twelve points a
 * cycle - linear interpolation of a sine at twelve points is 3.4% off its shape, which on a cutoff is
 * a slightly different sweep and not an added sound. A fade needs two points and gets these anyway,
 * which costs nothing worth measuring: a 150ms window is 36 floats.
 */
export const CURVE_HZ = 240;

/** A window longer than this is chopped rather than allocated for. Only a render ever gets near it. */
const MAX_CURVE_POINTS = 1 << 16;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The shapes a sweep can take, from a phase in turns, as -1..1.
 *
 * Deliberately **not** the same list as modulation.js's, and the difference is the interesting part.
 * Those shapes exist to match what `OscillatorNode` produces, because a per-voice LFO is realized as
 * an oscillator and the two halves have to agree. Nothing here is an oscillator, so the constraint is
 * gone and the phases can be chosen for what a *sweep* wants instead: `down` starts at the top of its
 * travel and arrives at the bottom one cycle later, which is what "the filter closes over eight bars"
 * means. Web Audio's sawtooth rises through zero and wraps at the half turn, so using it would have
 * put the discontinuity in the middle of the bar.
 */
export const SWEEP_SHAPES = [
  { value: 'sine', label: 'Sine', help: 'Starts at the middle of its travel, going up.' },
  { value: 'triangle', label: 'Triangle', help: 'The same journey at a constant rate, so it spends no longer at the ends than anywhere else.' },
  { value: 'down', label: 'Ramp down', help: 'Starts at the top and falls for the whole cycle, then jumps back. A filter closing over and over.' },
  { value: 'up', label: 'Ramp up', help: 'Starts at the bottom and opens for the whole cycle. A riser.' },
  { value: 'square', label: 'Square', help: 'Two values, one per half cycle. Aimed at a cutoff this is the gated sound.' },
];

export function sweepShapeAt(shape, turns) {
  const p = turns - Math.floor(turns);
  switch (shape) {
    case 'triangle':
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 'down':
      return 1 - 2 * p;
    case 'up':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

/**
 * Which way a sweep travels from the knob, and what `span` therefore means.
 *
 * `span` is the **whole** distance travelled in every case, which is the point of doing it this way:
 * switching polarity moves where the sweep sits without changing how far it goes, so the two knobs
 * stay independent. Bipolar puts the knob in the middle and goes half a span each way; `down` makes
 * the knob the ceiling and everything happens below it, which is the one an arrangement usually wants,
 * because a cutoff you set by ear is the brightest you want the part to get.
 */
export const SWEEP_POLARITIES = [
  { value: 'bipolar', label: 'Around', help: 'The knob is the middle: half the span above it and half below.' },
  { value: 'down', label: 'Below', help: 'The knob is the top. The sweep only ever darkens, which is usually what you set the cutoff by ear for.' },
  { value: 'up', label: 'Above', help: 'The knob is the bottom, and the sweep only opens.' },
];

/**
 * How far a sweep is from its parameter's knob at `beat`, in whole units of `span`.
 *
 * `wholes` is the length of one cycle in whole notes, resolved by the caller - a note division from
 * tempo.js, or a number of bars from meter.js. Neither belongs here: this file's whole claim is that
 * it knows nothing but arithmetic.
 */
export function sweepAt(beat, { wholes, shape = 'sine', polarity = 'bipolar', span = 0 } = {}) {
  if (!(span > 0) || !(wholes > 0)) return 0;
  const lfo = sweepShapeAt(shape, beat / wholes);
  const half = span / 2;
  if (polarity === 'down') return half * (lfo - 1);
  if (polarity === 'up') return half * (lfo + 1);
  return half * lfo;
}

/**
 * A part's own gain at `beat`, from its fade in and its fade out. All four numbers are in whole notes.
 *
 * **Linear in decibels**, not in amplitude, and the difference is most of whether a fade sounds like a
 * fade. Amplitude falling linearly to zero loses its first 6dB in the first half of the travel and its
 * last 54dB in the second, so it dives and then lingers; a fader pulled by hand is roughly linear in
 * dB, which is what this is. The floor is -60dB and the value below it is exactly zero rather than a
 * millionth, so silence is silence.
 *
 * The two are summed **in decibels**, and they are scaled down together if they do not fit, which was
 * measured before it was decided. Three bars in and three bars out on a four-bar part, summed without
 * the scaling, peaks at **-40dB** - which is silence, arrived at by asking for two reasonable numbers,
 * with nothing on screen to explain it. Scaled to fit, the same part rises for two bars and falls for
 * two and touches full level once in the middle, which is what somebody asking for that meant. They
 * keep their ratio, so a long fade in and a short fade out stays a long fade in and a short fade out.
 *
 * Outside the region the gain holds at the value the nearest edge reached, rather than returning to
 * unity. That is what makes a fade-out fade the part's *reverb tail* too: the notes stop at `end` and
 * the tail does not, and a gain that snapped back to 1 there would put the tail back at full level
 * after the part had gone.
 */
export function fadeGainAt(beat, { begin = 0, end = Infinity, fadeIn = 0, fadeOut = 0 } = {}) {
  const [into, outOf] = fadesWithin(begin, end, fadeIn, fadeOut);
  let db = 0;
  if (into > 0) db += FADE_FLOOR_DB * (1 - clamp01((beat - begin) / into));
  if (outOf > 0 && Number.isFinite(end)) db += FADE_FLOOR_DB * (1 - clamp01((end - beat) / outOf));
  if (db >= 0) return 1;
  if (db <= FADE_FLOOR_DB) return 0;
  return 10 ** (db / 20);
}

/** The two fades, shrunk in proportion until they fit inside the region. See `fadeGainAt`. */
export function fadesWithin(begin, end, fadeIn, fadeOut) {
  const into = Number(fadeIn) > 0 ? Number(fadeIn) : 0;
  const outOf = Number(fadeOut) > 0 ? Number(fadeOut) : 0;
  const span = Number.isFinite(end) ? end - begin : Infinity;
  const total = into + outOf;
  if (!(total > span) || !(span > 0)) return [into, outOf];
  const scale = span / total;
  return [into * scale, outOf * scale];
}

/**
 * The four numbers `fadeGainAt` needs, read off the song.
 *
 * Here rather than in either scheduler because both need it and it is the kind of four-line function
 * that drifts the moment there are two of it. The song is passed in rather than imported: this file
 * imports nothing, which is what keeps it out of every cycle and runnable in Node.
 */
export function fadeShapeOf(song, track) {
  return {
    begin: song.trackBegin(track),
    end: song.trackEnd(track),
    fadeIn: song.trackFade(track, 'fadeIn'),
    fadeOut: song.trackFade(track, 'fadeOut'),
  };
}

/** Whether either fade does anything at all, so a part with neither schedules nothing. */
export function hasFade(shape) {
  return Number(shape?.fadeIn) > 0 || Number(shape?.fadeOut) > 0;
}

/**
 * Sample `valueAt(beat)` across a window of song time, as a curve an AudioParam will take.
 *
 * Both ends inclusive, because `setValueCurveAtTime` spreads the array evenly over the duration and
 * uses the last element as the value at the end - so a window's last point has to be the *next*
 * window's first, or every seam is a step backwards.
 */
export function curveOver({ fromBeat, toBeat, seconds, valueAt }) {
  const points = Math.max(2, Math.min(MAX_CURVE_POINTS, Math.ceil(seconds * CURVE_HZ) + 1));
  const curve = new Float32Array(points);
  const span = toBeat - fromBeat;
  for (let i = 0; i < points; i++) curve[i] = valueAt(fromBeat + (span * i) / (points - 1));
  return curve;
}

/**
 * Hand one window of a song-position function to an AudioParam.
 *
 * Returns false and schedules nothing when there is no time to schedule over, which happens more often
 * than it sounds: a window can be a rounding error wide at a loop seam, and `setValueCurveAtTime` with
 * a duration of zero throws.
 */
export function scheduleCurve(param, { fromBeat, toBeat, startTime, endTime, valueAt }) {
  const seconds = endTime - startTime;
  if (!(seconds > 0) || !Number.isFinite(startTime)) return false;
  param.setValueCurveAtTime(curveOver({ fromBeat, toBeat, seconds, valueAt }), startTime, seconds);
  return true;
}

/**
 * Put a parameter back to its resting value, at a time after everything already scheduled.
 *
 * Called when the transport stops, and the *time* is the whole subtlety. Cancelling at `now` would
 * land inside a curve that is already running, which removes it outright and steps the parameter -
 * measured. So this waits for the last committed window to finish and then ramps over `RETURN_S`,
 * which is short enough to feel immediate and long enough not to click.
 *
 * It leaves one event behind, at `afterTime + RETURN_S`, and that matters to whoever starts playing
 * again: `setValueCurveAtTime` refuses to span an existing event, so a caller has to keep its first
 * window clear of this. `RETURN_S` is exported for exactly that.
 */
export const RETURN_S = 0.03;

export function releaseToRest(param, restingValue, afterTime) {
  param.cancelScheduledValues(afterTime);
  param.linearRampToValueAtTime(restingValue, afterTime + RETURN_S);
}
