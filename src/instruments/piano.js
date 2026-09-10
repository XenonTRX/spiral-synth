// The eighth instrument, and the one whose whole design is an argument about partials.
//
// A piano is the hardest instrument to synthesise convincingly and the easiest one to be wrong about
// in a way everybody can hear, and the reason for both is the same: almost everything that makes it
// sound like a piano is a statement about where its partials are and how fast each one dies. Get the
// envelope right and the spectrum wrong and it is an organ with a percussive attack. So this
// instrument does not have an oscillator, a filter or an envelope - it has a bank of partials, and
// every knob moves them.
//
// The four that matter, in the order you would notice them missing:
//
//   - **Inharmonicity.** A piano string is stiff, so its partials sit progressively sharp of the
//     harmonic series - measured on this model at middle C, the 8th partial is 3.7 cents sharp, the
//     12th 10.6 and the 16th 20.1. That is a fifth of a semitone, it is why pianos are tuned
//     stretched, and it is the single thing that most makes a piano patch sound like a piano.
//   - **Per-partial decay.** The top of a struck note is gone in a second and the bottom rings for
//     ten. One envelope cannot do that, and a lowpass with an envelope on it only imitates it.
//   - **Hammer position.** A hammer hits about an eighth of the way along, which is a nodal point of
//     the eighth partial, so there is a notch there. This is the specific hollowness of a piano's
//     low register.
//   - **Two strings a note, slightly apart.** The beating between them is what makes the instrument
//     sound wide rather than like a bell.
//
// See piano-dsp.js for how all of that is four multiplies a partial per sample, and for the one place
// this model is knowingly not physical: there is no hammer-felt nonlinearity, no coupling between the
// strings of a unison, no sympathetic resonance and no pedal.

import { defineInstrument, levelParam, numberParam } from '../instruments.js';
import { MAX_PARTIALS, PIANO_DEFAULTS } from './piano-dsp.js';
import { createWorkletVoice } from './worklet-voice.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/piano-processor.js', import.meta.url);
const PROCESSOR_NAME = 'piano';

export const PIANO_PARAMS = [
  numberParam({
    key: 'hammer',
    label: 'Hammer position',
    min: 0.02,
    max: 0.4,
    def: PIANO_DEFAULTS.hammer,
    step: 0.005,
    help: 'How far along the string the hammer strikes, as a fraction of its length. A partial with a node under the hammer cannot be excited at all, so this cuts notches in the spectrum — the default of about an eighth is where a real action puts it, and the notch it leaves at the eighth partial is the particular hollowness of a piano’s low register.',
    format: (v) => `1/${(1 / v).toFixed(1)}`,
  }),
  numberParam({
    key: 'hardness',
    label: 'Hammer hardness',
    min: 0,
    max: 1,
    def: PIANO_DEFAULTS.hardness,
    step: 0.01,
    help: 'Soft felt against worn felt. It decides how much brighter a hard strike is than a soft one, so it is what velocity has to work with — at the soft end a quiet note has almost no upper partials, which is how a real piano behaves and is the opposite of turning it down.',
    format: pct,
  }),
  numberParam({
    key: 'inharmonic',
    label: 'Inharmonicity',
    min: 0,
    max: 4,
    def: PIANO_DEFAULTS.inharmonic,
    step: 0.02,
    help: 'How stiff the string is, as a multiple of a real piano’s. At 1 the 16th partial is 20 cents sharp of the harmonic series and the note has that faint metallic shimmer no organ has; at 0 it is switched off entirely, which is worth hearing precisely because it sounds so wrong. Above 2 it is a tack piano, and then a bell.',
    format: (v) => (v === 0 ? 'off — harmonic' : `×${v.toFixed(2)}`),
  }),
  numberParam({
    key: 'partials',
    label: 'Partials',
    min: 4,
    max: MAX_PARTIALS,
    def: PIANO_DEFAULTS.partials,
    step: 1,
    help: 'How many partials a note is built from, at most. It is a cost control as much as a tone one — each one is a decaying sinusoid per string per sample. The count falls on its own for high notes, since nothing above Nyquist is built.',
    format: (v) => `${Math.round(v)}`,
  }),
  numberParam({
    key: 'decay',
    label: 'Decay',
    min: 0.5,
    max: 20,
    def: PIANO_DEFAULTS.decay,
    step: 0.1,
    help: 'How long a middle C rings undamped, to 60dB down. Longer notes in the bass and shorter in the treble follow from it, the way they do on the instrument.',
    format: (v) => `${v.toFixed(1)}s`,
  }),
  numberParam({
    key: 'decayTilt',
    label: 'Decay tilt',
    min: 0,
    max: 1.5,
    def: PIANO_DEFAULTS.decayTilt,
    step: 0.01,
    help: 'How much faster the upper partials die than the fundamental. This is what turns a clang into a sine over the first second, and at 0 the note is a static spectrum fading out — which sounds like a sample being faded, because that is what it is.',
    format: (v) => (v <= 0 ? 'flat' : pct(v)),
  }),
  numberParam({
    key: 'detune',
    label: 'Unison detune',
    min: 0,
    max: 14,
    def: PIANO_DEFAULTS.detune,
    step: 0.1,
    help: 'How far apart the two strings of each note are, in cents. The beating between them is most of why a piano sounds wide; the rate rises with the partial index, which is why the top of a note shimmers faster than its fundamental.',
    format: (v) => (v <= 0 ? 'single string' : `${v.toFixed(1)}¢`),
  }),
  numberParam({
    key: 'thump',
    label: 'Hammer knock',
    min: 0,
    max: 1,
    def: PIANO_DEFAULTS.thump,
    step: 0.01,
    help: 'The action itself — felt and wood, not the string. Every partial starts at zero, so without this the note fades in over its first few milliseconds instead of being struck.',
    format: pct,
  }),
  numberParam({
    key: 'board',
    label: 'Soundboard',
    min: 0,
    max: 1,
    def: PIANO_DEFAULTS.board,
    step: 0.01,
    help: 'The lid and the board: a very large, very unresonant box, so the peaks are broad and low rather than the three sharp ones a guitar has.',
    format: pct,
  }),
  numberParam({
    key: 'release',
    label: 'Damper',
    min: 0.02,
    max: 1.5,
    def: PIANO_DEFAULTS.release,
    step: 0.005,
    help: 'How fast the felt stops a ringing string when the key comes up. A loss rather than a fade, so it takes the top off the note on the way down — which is what a damper does and what a fade cannot.',
    format: ms,
  }),
  numberParam({
    key: 'tune',
    label: 'Tune',
    min: -24,
    max: 24,
    def: 0,
    step: 0.01,
    help: 'Offset in semitones, applied before the note is struck. It is the one Tune here that is not also a vibrato destination, and for the same reason the instrument declines slides: a piano string cannot be bent, and a partial bank set up at the strike has no way to travel. A control that moved and did nothing would be worse than not having it.',
    format: (v) => (v === 0 ? 'centre' : `${v > 0 ? '+' : ''}${v.toFixed(2)} st`),
  }),
  levelParam(),
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Middle C at velocity 1 with the defaults, rendered through the engine in Node, peaking at 0.1718 -
 * and the peak is in the first few milliseconds, because the partial bank is normalised so that the
 * partial count and the hammer position change the tone rather than the level.
 *
 * Not flat across the keyboard, and deliberately not corrected: the same strike measures 0.1601 at
 * the bottom A and 0.2030 at the top C, so a top C at Level 100% lands about 1.5dB over full scale.
 * Which is what a piano does - the treble is where the instrument is loudest and hardest - and the
 * bus limiter is the right place for it rather than a per-note fudge that would flatten the
 * instrument's own dynamic shape.
 */
const OUTPUT_TRIM = 5.819;

const PRESETS = [
  { name: 'Grand', state: {} },
  {
    name: 'Upright',
    state: { hammer: 0.1, hardness: 0.62, inharmonic: 1.6, decay: 4.5, decayTilt: 0.75, detune: 5.5, thump: 0.5, board: 0.42 },
  },
  {
    // Bright, thin, badly tuned unisons and a hard hammer. Not a caricature of an old piano - the
    // same model with inharmonicity and detune turned up, which is what an old piano actually is.
    name: 'Tack',
    state: { hammer: 0.06, hardness: 0.95, inharmonic: 2.6, partials: 26, decay: 2.6, decayTilt: 0.5, detune: 11, thump: 0.7, board: 0.2 },
  },
  {
    // Soft felt, few partials, long decay: what a piano sounds like played from across a room.
    name: 'Felt',
    state: { hammer: 0.2, hardness: 0.12, inharmonic: 0.8, partials: 10, decay: 9, decayTilt: 0.85, detune: 2.4, thump: 0.12, board: 0.45, release: 0.3 },
  },
  {
    // Inharmonicity off and the decay very long, which is not a piano at all - it is a struck bar,
    // and it is what the knob is there to let you hear.
    name: 'Harmonic',
    state: { inharmonic: 0, hammer: 0.25, partials: 12, decay: 14, decayTilt: 0.35, detune: 0, thump: 0.2, board: 0.15 },
  },
];

export default defineInstrument({
  id: 'piano',
  outputTrim: OUTPUT_TRIM,
  name: 'Piano',
  params: PIANO_PARAMS,
  presets: PRESETS,
  badge: () => 'PNO',
  // An undamped note rings for its whole decay, and the exporter has to leave room for it - capped,
  // because twenty seconds of tail on a two-bar song is a file that is mostly silence.
  tailSeconds: (state) => Math.max(state.release, Math.min(state.decay, 8)),

  /**
   * A piano string cannot be bent.
   *
   * Declared rather than left to the default, and it is the second instrument to decline - the kit
   * declines because its notes are not pitches, and this declines because its pitches cannot travel.
   * The partial bank is set up at the strike and never retuned, which is what makes it affordable
   * (four multiplies a partial rather than a cosine a partial a sample), so a slide would have
   * nothing to do. The roll asks before it offers the gesture.
   */
  slides: false,

  prepare: (ctx) => loadWorklet(ctx, PROCESSOR_URL).promise,

  measurement: {
    /**
     * The stretched series, not the harmonic one - and this is the hook doing exactly what it was
     * generalised for.
     *
     * "How much of this is not a multiple of the note" is the wrong question about a piano, because
     * *none of it* is a multiple of the note past the first partial: that is the instrument, not a
     * fault. Measured against a harmonic series this would report the 16th partial as a 20-cent
     * error and score a correct piano as broken - the same trap the FM sidebands and the wavetable's
     * unison sprang. So what is declared is where the partials were *asked* to be, and what the
     * measurement then finds is anything else, which is what aliasing would be.
     */
    partials: (state, f0, nyquist) => {
      const base = f0 * 2 ** ((state.tune ?? 0) / 12);
      // The same expression the voice uses, and it has to stay that way: two copies of an
      // inharmonicity formula that drift apart is a scope that reports a fault that is not there.
      const B = 1e-4 * (base / 261.626) ** 1.5 * Math.max(0, state.inharmonic ?? 1);
      const spread = Math.max(0, state.detune ?? 0) / 2;
      const out = [];
      for (let n = 1; n <= Math.round(state.partials ?? 20); n++) {
        const hz = n * base * Math.sqrt(1 + B * n * n);
        if (hz >= nyquist) break;
        // Both strings of the unison, because both are really there and an analyser that knew about
        // only one would report the other as unasked-for.
        out.push(hz * 2 ** (-spread / 1200), hz * 2 ** (spread / 1200));
      }
      return out;
    },
    // Nothing to park: every partial's decay *is* the sound, and holding it still would measure a
    // different instrument. The same answer the kit and the plucked string give.
    steadyState: (state) => state,
  },

  create: (ctx, destination) =>
    createWorkletVoice(ctx, destination, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      outputTrim: OUTPUT_TRIM,
      releaseSeconds: (state) => state.release ?? 0.14,
    }),
});
