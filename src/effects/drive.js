// Saturation, on native nodes.
//
// The second effect here built without a worklet, and for a sharper reason than the filter's. The
// filter is native because a `BiquadFilterNode` is exactly what an insert filter wants; the Drive is
// native because `WaveShaperNode.oversample` is the one thing about distortion that is genuinely hard
// and the browser already has it done properly. See drive-curve.js, which holds all the arithmetic and
// none of the graph, and the numbers that decided each shape.
//
// Four nodes in a line, and each of the three that is not the shaper is there for a specific failure:
//
//   - **The shaper** does the drive, the character, the bias and the mix, all of it in one table.
//   - **A highpass at 15Hz** removes what the bias leaves behind. The table subtracts the shape's value
//     at rest so that silence stays silent, but a *signal* through an asymmetric curve has a DC offset
//     that depends on how loud it is, and offset costs headroom in the limiter downstream without
//     making a sound of any kind.
//   - **A lowpass** is the tone control, after the drive rather than before it, because the harmonics
//     are the thing being controlled and the ones that need taking off do not exist until the shaper
//     has made them.
//   - **A gain** is the output trim, which a drive needs because the normalisation holds a *full-scale*
//     signal still and most signals are not full scale.

import { choiceParam, numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { dbToGain } from '../decibels.js';
import { DRIVE_DEFAULTS, buildDriveCurve } from './drive-curve.js';

/**
 * The flattest a `BiquadFilterNode` low or high pass gets, in the units the node actually reads.
 *
 * A Q of 0.7071 is Butterworth - no peak at the corner. For a lowpass and a highpass the node's `Q` is
 * in **decibels**, which is what the specification says and what caught this project once already: see
 * the note in filter.js, where a low pass at "Q 0.7" was measured lifting a tone by 0.6dB. Both filters
 * here are meant to be invisible apart from their slope, so both get the converted value.
 */
const FLAT_Q_DB = 20 * Math.log10(Math.SQRT1_2);

/** Low enough to leave the bottom octave alone, high enough to actually remove an offset. */
const DC_BLOCK_HZ = 15;

export const DRIVE_PARAMS = [
  choiceParam({
    key: 'character',
    label: 'Character',
    def: DRIVE_DEFAULTS.character,
    choices: [
      { value: 'tape', label: 'Tape', help: 'Odd symmetry, so odd harmonics only — 3rd, 5th, 7th. What "warm" means, and the one to reach for first.' },
      { value: 'tube', label: 'Tube', help: 'Asymmetric: the negative half gives way sooner than the positive one, which lets even harmonics through. The 2nd is an octave, so it reads as thickness rather than as dirt.' },
      { value: 'clip', label: 'Clip', help: 'A soft-kneed hard clip. Loud and flat-topped, and the shape that aliases most stubbornly high up the keyboard, because a flat top has a harmonic series that never runs out.' },
      { value: 'fold', label: 'Fold', help: 'A wavefolder: past the peak the output turns round and comes back. At 6dB its third harmonic is already above the fundamental. For basses and for ruining things on purpose.' },
    ],
  }),
  numberParam({
    key: 'driveDb',
    label: 'Drive',
    min: 0,
    max: 36,
    def: DRIVE_DEFAULTS.driveDb,
    step: 0.5,
    help: 'How hard the signal is pushed into the shape. It is not a volume knob: the curve is normalised so a full-scale sine comes out at the level it went in. Quieter signals do get louder — at 9dB a −20dBFS sine gains 7dB — because that is what saturation is.',
    format: (v) => `${v.toFixed(1)} dB`,
  }),
  numberParam({
    key: 'bias',
    label: 'Bias',
    min: 0,
    max: 0.6,
    def: DRIVE_DEFAULTS.bias,
    step: 0.01,
    help: 'Pushes the signal off centre before the shape, so the two halves clip differently and even harmonics appear. On Tape at 12dB, 0.15 of bias brings the 2nd harmonic from nothing to −29dB. The DC it creates is removed after.',
    format: (v) => (v <= 0 ? 'centred' : v.toFixed(2)),
  }),
  numberParam({
    key: 'tone',
    label: 'Tone',
    min: 800,
    max: 20000,
    scale: 'log',
    def: DRIVE_DEFAULTS.tone,
    help: 'A gentle lowpass after the shaper. Distortion adds its energy at the top, so this is the knob that decides whether the result is warm or bright — the harmonics have to exist before they can be taken off, which is why it is after and not before.',
    format: (v) => (v >= 20000 ? 'open' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)} Hz`),
  }),
  numberParam({
    key: 'mix',
    label: 'Mix',
    min: 0,
    max: 1,
    def: DRIVE_DEFAULTS.mix,
    step: 0.01,
    help: 'Parallel saturation: a clean signal with a distorted copy underneath. Blended inside the shaping table rather than through a second path, because the oversampler has latency and two paths would comb.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
  numberParam({
    key: 'outputDb',
    label: 'Output',
    min: -24,
    max: 12,
    def: DRIVE_DEFAULTS.outputDb,
    step: 0.5,
    help: 'Trim after everything. Needed because the normalisation holds a full-scale signal still and most material is well below that, so a heavy setting arrives louder than it left.',
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
  }),
];

export default defineEffect({
  id: 'drive',
  name: 'Drive',
  short: 'DRV',
  params: DRIVE_PARAMS,
  presets: [
    { name: 'Tape warm', state: { character: 'tape', driveDb: 5, bias: 0, tone: 13000, mix: 1, outputDb: 0 } },
    // The mix bus move: a lot of drive, mostly bypassed, which thickens without softening the transients.
    { name: 'Console glue', state: { character: 'tube', driveDb: 14, bias: 0.12, tone: 15000, mix: 0.35, outputDb: -1 } },
    { name: 'Bass grit', state: { character: 'tube', driveDb: 16, bias: 0.2, tone: 5200, mix: 0.55, outputDb: -2 } },
    { name: 'Lead push', state: { character: 'tape', driveDb: 18, bias: 0.08, tone: 7500, mix: 1, outputDb: -3 } },
    { name: 'Broken', state: { character: 'clip', driveDb: 27, bias: 0.3, tone: 3200, mix: 1, outputDb: -6 } },
    { name: 'Folded bass', state: { character: 'fold', driveDb: 12, bias: 0, tone: 2600, mix: 0.7, outputDb: -4 } },
  ],
  summary: (state) => {
    const name = DRIVE_PARAMS[0].choices.find((c) => c.value === state.character)?.label ?? state.character;
    return `${name} ${(state.driveDb ?? 0).toFixed(0)}dB · ${Math.round((state.mix ?? 1) * 100)}% wet`;
  },

  create(ctx) {
    const shaper = ctx.createWaveShaper();
    // 4x rather than none, and the difference is the whole reason this effect is native. Measured
    // through this node with the app's own analyser, at 880Hz and 24dB of drive: Tape goes from -36.9
    // to -98.7dBc, Clip from -30.9 to -79.7, and Fold from **-6.1 to -85.3**. Most settings land on the
    // analyser's own floor, which is as clean as this project can currently say anything is.
    //
    // It is not free: the two resampling filters cost 192 samples of latency, 4.35ms at 44.1kHz, which
    // is why the mix is inside the curve rather than a second path. See drive-curve.js.
    shaper.oversample = '4x';

    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = DC_BLOCK_HZ;
    dcBlock.Q.value = FLAT_Q_DB;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = FLAT_Q_DB;

    const trim = ctx.createGain();

    shaper.connect(dcBlock);
    dcBlock.connect(tone);
    tone.connect(trim);

    // What the table was last built for. Rebuilding it is 8192 evaluations of a `tanh` plus a 4096-point
    // normalisation pass, which is nothing on the main thread and would be a missed deadline on the
    // audio one - but `setState` is called on every note, so it has to not happen on every note.
    let builtFor = null;

    return {
      input: shaper,
      output: trim,
      setState(state) {
        const signature = `${state.character}|${state.driveDb}|${state.bias}|${state.mix}`;
        if (signature !== builtFor) {
          shaper.curve = buildDriveCurve(state);
          builtFor = signature;
        }
        // Clamped below Nyquist for the same reason filter.js clamps: the knob's 20kHz maximum is above
        // Nyquist on a device running at 32kHz, and a biquad at or above it is undefined.
        tone.frequency.value = Math.min(state.tone ?? DRIVE_DEFAULTS.tone, ctx.sampleRate * 0.49);
        trim.gain.value = dbToGain(state.outputDb ?? 0);
      },
      dispose() {
        shaper.disconnect();
        dcBlock.disconnect();
        tone.disconnect();
        trim.disconnect();
      },
    };
  },
});
