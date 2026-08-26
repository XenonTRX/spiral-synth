// The shape a Drive applies, as a table of numbers, in a file with no browser in it.
//
// **Why the shape is a separate file from the effect.** The Drive is the one effect here built on a
// native node - a `WaveShaperNode` - and the reason is that the hard part of distortion is not the
// shape, it is the aliasing: a curve that bends a signal makes harmonics above Nyquist, and those fold
// back down as inharmonic tones that no amount of filtering afterwards can remove. The fix is to run
// the shaper at a multiple of the sample rate, and `WaveShaperNode.oversample = '4x'` is that fix,
// implemented in C++ by people who do resampler design for a living. Writing it again in a worklet
// would have been a week to arrive somewhere slightly worse.
//
// What that leaves is a table, and a table is arithmetic. So the arithmetic is here, where it can be
// checked in Node against a harmonic series computed independently, and the effect file is left holding
// nothing but four nodes and their wiring.
//
// **Why the drive is inside the curve and not a gain in front of it.** A `WaveShaperNode` maps the
// input range -1..1 onto the table and *clamps* anything beyond it to the end values. So a gain node
// pushing a signal to ±8 before the shaper does not get eight times the drive, it gets a hard clip at
// the table's edge, whatever gentle shape the table holds. Baking the drive in means the whole range
// of the signal lands inside the table and the shape is the shape.
//
// **Why `mix` is inside the curve too.** A dry path in parallel with the shaper is the obvious way to
// do parallel saturation, and it is a phase trap: the oversampler is a pair of resampling filters and
// resampling filters have latency, unspecified and different per browser, so the two paths would be
// misaligned by an unknown few samples and the mix would comb. A blend of the identity and a shaping
// function is just another function, so it goes in the table and the question does not arise.
//
// Measured rather than assumed, and by a wide margin: an impulse through an identity curve comes out
// **192 samples late** at 4x in this browser, and 128 at 2x - 4.35ms at 44.1kHz. A parallel dry path
// against that would have had its first cancellation notch at 115Hz. Nothing about the specification
// promises any particular figure, which is the other half of the argument for not depending on one.
//
// Two consequences worth stating. Mix 0% is **not** bit-exact, where the delay's and the chorus's are:
// the table comes out as the identity to within Float32 rounding (3.0e-8, or -150dB) and the two
// resampling filters are in circuit either way, so it is transparent to the ear and not to the bit.
// And a part with a Drive on it runs 4.35ms behind a part without one, which is inaudible on its own
// and would comb if two parts played the same line with the effect on only one of them.

export const DRIVE_DEFAULTS = {
  character: 'tape',
  driveDb: 6,
  bias: 0,
  tone: 12000,
  mix: 1,
  outputDb: 0,
};

/** How many points the table gets. See the note on resolution below `buildDriveCurve`. */
export const CURVE_POINTS = 8192;

/**
 * The four shapes, each a function of one number and each its own kind of wrong.
 *
 * All four are C1 at the origin - value 0, and a defined slope - because a kink there would be
 * audible on quiet material as a crackle rather than as distortion, and quiet material spends all of
 * its time near the origin.
 */
export const CHARACTERS = {
  // The workhorse. Odd symmetry, so odd harmonics only: 3rd, 5th, 7th, which is what "warm" means.
  tape: (u) => Math.tanh(u),

  // Asymmetric on purpose: the negative half saturates later and softer than the positive one, which
  // breaks the odd symmetry and lets even harmonics through. The 2nd harmonic is an octave, so it
  // reads as thickness rather than as dirt - the reason a valve stage is described as musical while a
  // symmetric clipper is described as a fuzz.
  tube: (u) => (u >= 0 ? Math.tanh(u) : 0.7 * Math.tanh(u / 0.7)),

  // A soft-kneed hard clip: cubic up to ±1, flat beyond, with the derivative reaching zero exactly
  // where it flattens so the knee is a knee and not a corner. Reaches the rail and stays there, which
  // makes it the aggressive one - and the one the oversampling can least keep up with, because a flat
  // top has a harmonic series that falls off as 1/n and therefore never runs out. Measured through the
  // real node, it is the only shape that fails to reach the analyser's floor at 880Hz and 24dB
  // (-79.7dBc, where everything else is at the floor of -98.7), and at 3kHz it is at -46.6 where Tape
  // is at -59.5. Distortion that far up the keyboard is where the choice of shape stops being taste.
  clip: (u) => (u <= -1 ? -1 : u >= 1 ? 1 : u * (1.5 - 0.5 * u * u)),

  // A wavefolder rather than a clipper: past the peak the output turns round and comes back. Not
  // subtle - at 6dB of drive its third harmonic is already 1.3dB *above* the fundamental - and the
  // shape that gains most from the oversampling, because folding pushes energy very high very fast:
  // measured at 880Hz and 24dB of drive it aliases at **-6.1dBc** with the oversampling off, which is
  // very nearly as much alias as signal, and -85.3 with 4x on. Nothing else here comes close to
  // needing it that badly. On a bass an octave below middle C, all of that is the point.
  fold: (u) => Math.sin(u * (Math.PI / 2)),
};

const asGain = (db) => 10 ** (db / 20);

/**
 * The RMS a full-scale sine comes out at after going through `curve`.
 *
 * This is the normalisation, and choosing it was the one real decision in the file. A shaper has to be
 * normalised *somehow* or the drive knob is a volume knob, and there are three candidates:
 *
 *   - **Match the peak** (`f(1) = 1`). Simple, and wrong for a mix: `tanh` at 9dB of drive has a slope
 *     of 2.8 through the origin, so everything quieter than full scale gets loud. Most material is
 *     quieter than full scale.
 *   - **Match the small-signal slope** (`f'(0) = 1`). Right for a feedback loop - the delay's saturator
 *     does exactly this - and wrong here, because then drive can only ever make things quieter and the
 *     knob feels broken.
 *   - **Match the RMS of a full-scale sine.** What this does. It is the level a loud passage comes out
 *     at, which is the level a mix is balanced by, so turning the knob changes the timbre and leaves
 *     the balance alone.
 *
 * Quieter material still gets louder, and that is not a flaw to be fixed - it *is* saturation. Measured
 * at 9dB of Tape, a full-scale sine comes out at -0.0dB and a -20dBFS one at +7.0; at 24dB the same
 * pair reads 0.0 and +17.5. The knob is a timbre control at the top of the range and a compressor
 * everywhere below it, which is what a tape machine is.
 */
export function sineRms(curve) {
  const n = 4096;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * i) / n);
    sum += readCurve(curve, x) ** 2;
  }
  return Math.sqrt(sum / n);
}

/** What a `WaveShaperNode` would read at `x`: the table, linearly interpolated, clamped at the ends. */
export function readCurve(curve, x) {
  const n = curve.length;
  const position = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (n - 1);
  const i = Math.floor(position);
  if (i >= n - 1) return curve[n - 1];
  const f = position - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

const SINE_RMS = Math.SQRT1_2;

/**
 * The table, for one setting of the knobs.
 *
 * The resolution is worth a word. 8192 points over -1..1 sounds generous until you notice where the
 * interesting part of the curve is: with the drive baked in, a setting of 30dB compresses everything
 * that is not already clipped into `|x| < 0.03`, which is 250 of the 8192 points. Below about 2048 the
 * knee of a high-drive setting is visibly made of straight lines - and a straight line joining two
 * points of a curve is itself a distortion, an unasked-for one. 8192 costs 32KB per instance.
 */
export function buildDriveCurve({ character, driveDb, bias, mix } = {}) {
  const shape = CHARACTERS[character] ?? CHARACTERS.tape;
  const drive = asGain(Number.isFinite(driveDb) ? driveDb : DRIVE_DEFAULTS.driveDb);
  const offset = Number.isFinite(bias) ? bias : 0;
  const wet = Number.isFinite(mix) ? Math.max(0, Math.min(1, mix)) : 1;
  const dry = 1 - wet;
  const curve = new Float32Array(CURVE_POINTS);

  // Whatever the bias does to silence is removed here rather than left to the DC blocker downstream.
  // A shaper that answers a constant to an input of zero is a shaper that thumps every time it is
  // switched in, and a highpass cannot undo a step it has already passed.
  const atRest = shape(offset);

  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i / (CURVE_POINTS - 1)) * 2 - 1;
    curve[i] = dry * x + wet * (shape(drive * x + offset) - atRest);
  }

  const rms = sineRms(curve);
  if (rms > 1e-9) {
    const scale = SINE_RMS / rms;
    for (let i = 0; i < CURVE_POINTS; i++) curve[i] *= scale;
  }
  return curve;
}
