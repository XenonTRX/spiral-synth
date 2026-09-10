// The sixth instrument, and the first that is a model of an object rather than a signal chain.
//
// Everything before this is a synthesiser: something that oscillates, something that filters, and
// envelopes on both. The knobs are the parts - waveform, cutoff, attack - and the sound is whatever
// those parts do together. This one has no parts. It has a string, and the knobs are the things you
// can do to a string: where you hit it, what you hit it with, how tightly it is held. There is no
// waveform control because there is no waveform, and no filter envelope because nothing is filtering
// - the note gets darker as it decays because that is what a real one does, and the arithmetic in
// instruments/pluck-dsp.js is the reason rather than an envelope aimed at a cutoff.
//
// The knobs are therefore not interchangeable with any other instrument's, and that is the point of
// having it. "Pick position" is not a tone control that happens to sound like one - it is a distance,
// and the comb filter it produces is what a pick at that distance actually does. The reason to build
// an instrument this way is that the controls stay meaningful when you combine them, because they are
// describing one object rather than three independent stages.
//
// See pluck-dsp.js for the model and for what is measured about it: in tune to within a cent from C1
// to C7, and unmoved by the damping control, which is the specific thing the loop filter was chosen
// for.

import { defineInstrument, harmonicSeries, levelParam, numberParam } from '../instruments.js';
import { PLUCK_DEFAULTS } from './pluck-dsp.js';
import { createWorkletVoice } from './worklet-voice.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/pluck-processor.js', import.meta.url);
const PROCESSOR_NAME = 'pluck';

export const PLUCK_PARAMS = [
  numberParam({
    key: 'pluckPosition',
    label: 'Pick position',
    min: 0.02,
    max: 0.5,
    def: PLUCK_DEFAULTS.pluckPosition,
    step: 0.005,
    help: 'How far along the string the pick lands, as a fraction of its length. A pick cannot excite a harmonic that has a node where it hits, so this puts notches in the spectrum — at the halfway point every even harmonic disappears and the note goes hollow, and near the bridge nothing is missing and it is thin and nasal. It is a distance, not a tone control.',
    format: (v) => `1/${(1 / v).toFixed(1)}`,
  }),
  numberParam({
    key: 'pickHardness',
    label: 'Pick hardness',
    min: 0,
    max: 1,
    def: PLUCK_DEFAULTS.pickHardness,
    step: 0.01,
    help: 'A fingertip is a wide soft contact and excites almost nothing above a few hundred Hz; a plectrum is hard and narrow and excites everything. This is the difference between nylon and steel, and it moves with velocity too — a harder pluck is a brighter pluck, not just a louder one.',
    format: pct,
  }),
  numberParam({
    key: 'damping',
    label: 'String damping',
    min: 0,
    max: 0.5,
    def: PLUCK_DEFAULTS.damping,
    step: 0.005,
    help: 'How much of the top end the string loses on every trip along itself, which is what makes a note start bright and end as a sine. At the default an A3 loses its eighth harmonic at 33dB/s against the fundamental’s 24. It does not change the pitch as it moves (measured at 0.03 cents across its whole range) and it does not change how long the fundamental rings — but it does shorten the top of the instrument, where the filter is the whole of the loss.',
    format: pct,
  }),
  numberParam({
    key: 'decay',
    label: 'Decay',
    min: 0.2,
    max: 12,
    def: PLUCK_DEFAULTS.decay,
    step: 0.05,
    help: 'How long a low A rings for, to 60dB down. Quoted at one pitch because it cannot be one number for all of them — see Decay tilt.',
    format: (v) => `${v.toFixed(2)}s`,
  }),
  numberParam({
    key: 'decayTilt',
    label: 'Decay tilt',
    min: 0,
    max: 1,
    def: PLUCK_DEFAULTS.decayTilt,
    step: 0.01,
    help: 'How much shorter high notes ring than low ones. At 0 every note decays over the same time, which is the single most obvious tell that a string model is a synthesiser — the top octave rings like a bell. At 1 an octave up rings half as long.',
    format: (v) => (v <= 0 ? 'flat' : pct(v)),
  }),
  numberParam({
    key: 'body',
    label: 'Body',
    min: 0,
    max: 1,
    def: PLUCK_DEFAULTS.body,
    step: 0.01,
    help: 'How much of the box you hear. A string on its own moves almost no air — what reaches you is the wood it is bolted to, and three resonances of it is most of what that does.',
    format: pct,
  }),
  numberParam({
    key: 'bodySize',
    label: 'Body size',
    min: 0.4,
    max: 2.5,
    def: PLUCK_DEFAULTS.bodySize,
    step: 0.01,
    help: 'Moves all three body resonances together. Below 1 is a bigger, boomier box and above it a smaller, tighter one — a parlour guitar against a dreadnought, and past 2 a ukulele.',
    format: (v) => `×${v.toFixed(2)}`,
  }),
  numberParam({
    key: 'release',
    label: 'Damping (release)',
    min: 0.02,
    max: 2,
    def: PLUCK_DEFAULTS.release,
    step: 0.01,
    help: 'How fast a note dies once it has been let go. A string that is released carries on ringing and one that is *muted* stops at once, and both are this knob at different settings — which is why it is a loss rather than a fade: a fade would take the level down with the tone intact, and a hand on a string takes the top off it on the way.',
    format: ms,
  }),
  numberParam({
    key: 'tune',
    label: 'Tune',
    min: -24,
    max: 24,
    def: 0,
    step: 0.01,
    mod: 'semitones',
    help: 'Offset in semitones, which is also where a vibrato lands: route an LFO to this.',
    format: (v) => (v === 0 ? 'centre' : `${v > 0 ? '+' : ''}${v.toFixed(2)} st`),
  }),
  levelParam(),
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Every instrument here has one, because before they were measured they were unrelated fudge factors
 * 27dB apart, and the same number on two parts' faders meant two different loudnesses. Measured the
 * way the others were: an A3 at velocity 1 with the defaults, rendered through the engine in Node -
 * which is what putting the arithmetic in pluck-dsp.js buys, since none of the other instruments'
 * trims could be taken without a browser. It peaks at 0.1526.
 *
 * A3 rather than an average over the range, and the spread is worth knowing: the same pluck measures
 * 0.1699 at E2 and 0.0868 at E5, so the top of the instrument is 5dB quieter than the middle. That is
 * the model being right rather than uneven - a short string has less mass to carry the same
 * displacement and loses what it has faster - and flattening it here would have undone it.
 */
const OUTPUT_TRIM = 6.554;

const PRESETS = [
  { name: 'Steel', state: {} },
  {
    name: 'Nylon',
    state: { pickHardness: 0.22, pluckPosition: 0.3, damping: 0.22, decay: 2.6, body: 0.5, bodySize: 0.85, release: 0.45 },
  },
  {
    // Near the bridge, hard pick, short decay: every harmonic excited and none of them left alone.
    name: 'Bridge Pick',
    state: { pluckPosition: 0.05, pickHardness: 0.95, damping: 0.05, decay: 2.2, decayTilt: 0.55, body: 0.2, bodySize: 1.4 },
  },
  {
    // A struck string with almost no box and a very long decay is not a guitar, it is a harp - and it
    // is the same model with three knobs moved, which is the argument for building it this way.
    name: 'Harp',
    state: { pluckPosition: 0.12, pickHardness: 0.4, damping: 0.3, decay: 8, decayTilt: 0.7, body: 0.15, bodySize: 0.6, release: 1.2 },
  },
  {
    // Muted: let go and it stops. The release knob doing the thing a palm does.
    name: 'Palm Mute',
    state: { pluckPosition: 0.09, pickHardness: 0.8, damping: 0.4, decay: 0.6, release: 0.05, body: 0.25 },
  },
];

export default defineInstrument({
  id: 'guitar',
  outputTrim: OUTPUT_TRIM,
  name: 'Plucked String',
  params: PLUCK_PARAMS,
  presets: PRESETS,
  badge: () => 'GTR',
  // Both of them: a released string is still ringing for as long as its damping says, and an
  // unreleased one for as long as its decay says. The exporter needs the longer.
  tailSeconds: (state) => Math.max(state.release, Math.min(state.decay, 6)),

  prepare: (ctx) => loadWorklet(ctx, PROCESSOR_URL).promise,

  measurement: {
    /**
     * The one instrument family the headline number is exactly right about.
     *
     * A string's partials are integer multiples of its fundamental by construction - that is what a
     * fixed-length loop *is* - so "how much of this is not a multiple of the note" is a real question
     * here in a way it is not for a kit or an FM patch. What it measures is the delay line's
     * interpolation: reading a fractional delay linearly detunes the upper partials and smears them,
     * and this reads that as the inharmonicity it is.
     */
    partials: (state, f0, nyquist) => harmonicSeries(f0 * 2 ** ((state.tune ?? 0) / 12), nyquist),
    // Nothing to park. A pluck has no sustain to hold still - the decay *is* the sound, and freezing
    // it would measure a different instrument. The same answer the kit gives, for the same reason.
    steadyState: (state) => state,
  },

  create: (ctx, destination) =>
    createWorkletVoice(ctx, destination, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      outputTrim: OUTPUT_TRIM,
      releaseSeconds: (state) => state.release ?? 0.4,
    }),
});
