// Gain and decibels, in one place.
//
// Four files had grown their own `20 * Math.log10(...)` and that was fine for as long as everything
// only ever went one way - a measurement comes out of a render as a number and gets printed as dB.
// A volume control calibrated in dB goes the other way, and a limiter ceiling goes both, so the pair
// now has to agree with itself and lives together.
//
// The two directions clamp differently on purpose. `gainToDb` clamps only far enough to keep
// -Infinity out of a readout, because a measurement of silence is a real answer and -240dB says so
// plainly. A *control* has a floor instead, and that floor is a design decision belonging to the
// control - see MONITOR_FLOOR_DB in master-strip.js - not a property of the arithmetic.

export function dbToGain(db) {
  return 10 ** (db / 20);
}

export function gainToDb(gain) {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

/** A level as a reading, with silence said in words rather than as a large negative number. */
export function dbfs(gain, digits = 1) {
  return gain > 0 ? `${gainToDb(gain).toFixed(digits)} dBFS` : 'silent';
}

/**
 * The same for a control, where the sign carries the meaning and 0 is unity rather than nothing.
 *
 * A true minus sign rather than a hyphen, and an explicit `+` above unity. The plus is not decoration:
 * a part's Level goes to +3.5dB (see levelParam), so "1.4 dB" without it reads as an absolute level
 * rather than as a boost, and the one case where the distinction matters is a song converted from
 * before the levels were calibrated - which is exactly where a fader lands above zero.
 */
export function dbLabel(db, digits = 1) {
  if (!Number.isFinite(db)) return '−∞ dB';
  const rounded = db.toFixed(digits);
  if (rounded.startsWith('-')) return `−${rounded.slice(1)} dB`;
  return `${Number(rounded) > 0 ? '+' : ''}${rounded} dB`;
}
