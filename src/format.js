// How a knob's value is spelled out under it.
//
// These were six identical copies each of `ms` and `pct`, sitting at the top of every file that
// declares knobs - the same shrug `decibels.js` was made to stop. A formatter is part of what a
// knob *is*, so two knobs that mean the same thing should not be able to drift into reading
// differently because one file rounded and another truncated.
//
// Deliberately not everything that formats. `effects/compressor.js` and `effects/delay.js` each
// have an `ms` of their own that is a *different function under the same name* - one takes
// milliseconds and one takes seconds and switches to `s` past a second - and `instruments/drums.js`
// has an `hz` that never abbreviates to `k`. Merging those would change what the panels read, so
// they stay where they are.

/** A 0-to-1 fraction as a whole-number percentage. */
export const pct = (v) => `${Math.round(v * 100)}%`;

/** Seconds as whole milliseconds. */
export const ms = (v) => `${Math.round(v * 1000)}ms`;

/** A frequency, abbreviated to one decimal of a kilohertz above 1000. */
export const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)} Hz`);

/** A value that reads as a deviation, so the plus sign is as important as the minus. */
export const signed = (v, digits, unit) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`;
