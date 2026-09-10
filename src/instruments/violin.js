// The seventh instrument, and the only one here whose note does not stop by itself.
//
// A pluck, a strike, a hit and an ADSR are all the same shape from a distance: something starts, and
// then it stops on its own terms. A bow is not that. It is in contact with the string for the whole
// length of the note, and what it does next depends on what the string is doing now - which makes
// this the first instrument here that is a *feedback loop between the player and the instrument*
// rather than a sound with an envelope on it.
//
// What that buys is the thing every synthesiser struggles to fake about strings: the note takes a
// moment to speak. Not because an attack was set, but because a stick-slip cycle needs several trips
// along the string to establish, and until it does the output is noise and partial modes. Play the
// same patch with a slow bow and it swells; with a fast one it bites. Neither is a setting.
//
// What it costs is that a bowed string can be played *wrongly*, and the model does that too. Too much
// pressure and the tone breaks into a higher mode; too close to the bridge and the fundamental
// disappears. Both are real - they are called over-pressure and sul ponticello - and both are
// reachable with the knobs here, which is a feature of the model and a hazard of the panel. The
// defaults are measured to sit in the middle of the usable region; see BOW_DEFAULTS in bow-dsp.js
// for the numbers, and the presets for the edges done deliberately.
//
// **The vibrato is not in this file.** It is a routing: LFO 1 aimed at `tune`, with the fade-in the
// LFO already has, which is what makes a vibrato sound played rather than applied. modulation.js
// built all of that for the ladder and there was no reason to write a second one - so the Vibrato
// preset ships the routing pre-wired, which is also the clearest way to find out the matrix exists.

import { defineInstrument, harmonicSeries, levelParam, numberParam } from '../instruments.js';
import { BOW_DEFAULTS } from './bow-dsp.js';
import { createWorkletVoice } from './worklet-voice.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/bow-processor.js', import.meta.url);
const PROCESSOR_NAME = 'bow';

export const BOW_PARAMS = [
  numberParam({
    key: 'bowSpeed',
    label: 'Bow speed',
    min: 0.02,
    max: 0.6,
    def: BOW_DEFAULTS.bowSpeed,
    step: 0.005,
    mod: 'amount',
    help: 'How fast the bow is drawn. This is the loudness control that a violinist actually has, and it is not a fader: a faster bow puts more energy in and gets brighter with it, because the string is dragged further before the grip fails.',
    format: (v) => v.toFixed(3),
  }),
  numberParam({
    key: 'bowPressure',
    label: 'Bow pressure',
    min: 0.8,
    max: 6,
    def: BOW_DEFAULTS.bowPressure,
    step: 0.05,
    mod: 'units',
    help: 'How hard the bow is pressed into the string — how wide a range of speeds the rosin grips through. Past about 4 the tone breaks up into higher modes, which is what over-pressing a real bow does and is not a fault of the model. The ceiling is where it is because further up, at the very top of the range, the model itself came apart: see STRING_CEILING in bow-dsp.js.',
    format: (v) => v.toFixed(2),
  }),
  numberParam({
    key: 'bowPosition',
    label: 'Bow position',
    min: 0.05,
    max: 0.3,
    def: BOW_DEFAULTS.bowPosition,
    step: 0.005,
    help: 'Where the bow crosses the string, measured from the bridge as a fraction of its length. This splits the string into two unequal halves and is therefore not a filter — near the bridge the short half returns sooner and reinforces the upper modes until the fundamental vanishes (sul ponticello, measured at 24dB down by 0.07), and over the fingerboard it is soft and flute-like.',
    format: (v) => `1/${(1 / v).toFixed(1)}`,
  }),
  numberParam({
    key: 'attack',
    label: 'Bow attack',
    min: 0.005,
    max: 1,
    def: BOW_DEFAULTS.attack,
    step: 0.005,
    help: 'How long the arm takes to get up to speed. The note takes noticeably longer than this to speak, because the stick-slip cycle needs several trips along the string to establish — which is the thing bowed instruments have and synthesisers do not.',
    format: ms,
  }),
  numberParam({
    key: 'release',
    label: 'Bow release',
    min: 0.01,
    max: 2,
    def: BOW_DEFAULTS.release,
    step: 0.005,
    help: 'How long the bow takes to lift, and how fast the string dies once it has. A violin string is short and heavily loaded, so it stops fast — which is why pizzicato sounds nothing like a guitar.',
    format: ms,
  }),
  numberParam({
    key: 'damping',
    label: 'Bridge damping',
    min: 0,
    max: 0.5,
    def: BOW_DEFAULTS.damping,
    step: 0.005,
    help: 'How much of the top end the bridge takes away on each reflection. A bridge is not a mirror — it is the thing driving the body, so what it loses is what you hear.',
    format: pct,
  }),
  numberParam({
    key: 'noise',
    label: 'Bow noise',
    min: 0,
    max: 1,
    def: BOW_DEFAULTS.noise,
    step: 0.01,
    help: 'Hair is not smooth and rosin is not evenly spread, so the grip flickers. A small amount does a lot of work: with none of it every note starts identically and the sustain is a perfectly periodic buzz.',
    format: pct,
  }),
  numberParam({
    key: 'body',
    label: 'Body',
    min: 0,
    max: 1,
    def: BOW_DEFAULTS.body,
    step: 0.01,
    help: 'The box, at 275Hz, 460Hz and 820Hz — a violin’s air resonance and its two main plate modes, which are nothing like a guitar’s and an octave higher.',
    format: pct,
  }),
  numberParam({
    key: 'bodySize',
    label: 'Body size',
    min: 0.4,
    max: 2,
    def: BOW_DEFAULTS.bodySize,
    step: 0.01,
    help: 'Moves the three resonances together. Below 1 is a viola and then a cello; above it there is nothing left in the family, which is its own kind of useful.',
    format: (v) => `×${v.toFixed(2)}`,
  }),
  numberParam({
    key: 'tune',
    label: 'Tune',
    min: -24,
    max: 24,
    def: 0,
    step: 0.01,
    mod: 'semitones',
    help: 'Offset in semitones, and where a vibrato belongs: route an LFO here and give it a fade-in. See the Vibrato preset.',
    format: (v) => (v === 0 ? 'centre' : `${v > 0 ? '+' : ''}${v.toFixed(2)} st`),
  }),
  levelParam(),
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Rendered through the engine in Node with the defaults, an A4 at velocity 1: a peak of 0.1878.
 *
 * Worth reading differently from the others, though, because this is a *sustained* peak. Every other
 * instrument here peaks in its first few milliseconds and then decays, so its trim is calibrated on a
 * transient; a bowed note holds its peak for as long as it is held. The same number on this fader is
 * therefore a much louder part in a mix than on the plucked string's, and the bus limiter will have
 * far more to do about it. That is not something a trim can fix - it is what the instrument is.
 */
const OUTPUT_TRIM = 5.326;

const PRESETS = [
  { name: 'Violin', state: {} },
  {
    // The routing the instrument is really for: an LFO on the pitch, arriving a third of a second in.
    // A vibrato that is there from the first sample sounds applied; one that fades in sounds played.
    name: 'Vibrato',
    state: {
      bowSpeed: 0.16,
      attack: 0.14,
      lfo1Rate: 5.5,
      lfo1Shape: 'sine',
      lfo1Fade: 0.35,
      mod: [{ source: 'lfo1', target: 'tune', depth: 0.2 }],
    },
  },
  {
    name: 'Cello',
    state: { bodySize: 0.55, bowSpeed: 0.18, bowPressure: 2.4, damping: 0.38, attack: 0.13, body: 0.5 },
  },
  {
    // Deliberately at the edge: hard by the bridge, where the fundamental gives up and the string
    // moves in thirds. It is a real technique and it is what the bottom of the position range is.
    name: 'Ponticello',
    state: { bowPosition: 0.055, bowPressure: 3.4, bowSpeed: 0.1, damping: 0.1, noise: 0.35, body: 0.3 },
  },
  {
    // Over the fingerboard with a slow arm: no upper modes to speak of, and a long swell.
    name: 'Sul Tasto',
    state: { bowPosition: 0.26, bowPressure: 1.2, bowSpeed: 0.1, attack: 0.35, damping: 0.42, body: 0.55 },
  },
];

export default defineInstrument({
  id: 'violin',
  outputTrim: OUTPUT_TRIM,
  name: 'Bowed String',
  params: BOW_PARAMS,
  presets: PRESETS,
  badge: () => 'BOW',
  // The bow lifting, and then the string's own ring. Both are the release knob - see bow-dsp.js.
  tailSeconds: (state) => state.release * 2 + 0.2,

  prepare: (ctx) => loadWorklet(ctx, PROCESSOR_URL).promise,

  measurement: {
    // Integer multiples, and honestly so: the loop is a fixed length, so the modes are harmonics of
    // it whatever the bow does. Which makes the headline number a measurement of the interpolation
    // in the delay lines, exactly as it is for the plucked string.
    partials: (state, f0, nyquist) => harmonicSeries(f0 * 2 ** ((state.tune ?? 0) / 12), nyquist),
    // The one string instrument here that *has* a steady state, because the bow keeps it there. So
    // unlike the pluck and the piano there is nothing to freeze: what it does at two seconds is what
    // it does, and that is the thing worth measuring.
    steadyState: (state) => state,
  },

  create: (ctx, destination) =>
    createWorkletVoice(ctx, destination, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      outputTrim: OUTPUT_TRIM,
      releaseSeconds: (state) => (state.release ?? 0.2) * 2,
    }),
});
