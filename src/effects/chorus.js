// The chorus, as a thing with knobs on.
//
// The presets are the names of the effects this one circuit can be, and that is the point of them
// rather than a convenience. Flanger, vibrato and ensemble are three settings of a modulated delay
// (see chorus-dsp.js), so offering them as three effects would have meant three files that were the
// same file, and offering only "chorus" would have meant the other two were reachable but unnamed -
// which for anybody who did not already know is the same as absent.

import { choiceParam, numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { CHORUS_DEFAULTS, chorusTailSeconds } from './chorus-dsp.js';
import { createWorkletEffect } from './worklet-effect.js';

const PROCESSOR_URL = new URL('./worklets/chorus-processor.js', import.meta.url);
const PROCESSOR_NAME = 'chorus';

export const CHORUS_PARAMS = [
  choiceParam({
    key: 'voices',
    label: 'Voices',
    def: CHORUS_DEFAULTS.voices,
    help: 'How many taps read the one delay line. They share a single LFO at even phase offsets — two in antiphase, three at thirds — which is the arrangement a Juno used and the reason the effect never thins out: independent LFOs drift through unison every so often, and you hear it go flat when they do.',
    choices: [
      { value: 1, label: '1', help: 'One tap. What a flanger and a vibrato are.' },
      { value: 2, label: '2', help: 'Two in antiphase: the Juno arrangement.' },
      { value: 3, label: '3', help: 'Thicker, and 0.27dB louder than one — measured, then left alone.' },
    ],
  }),
  choiceParam({
    key: 'shape',
    label: 'Shape',
    def: CHORUS_DEFAULTS.shape,
    choices: [
      { value: 'triangle', label: 'Triangle', help: 'Sweeps at a constant rate, so the pitch shift is constant and simply changes sign twice a cycle. Two fixed detunings swapping over, which is what a bucket-brigade ensemble sounded like.' },
      { value: 'sine', label: 'Sine', help: 'The pitch shift is itself a sine, and peaks π/2 higher than the triangle for the same depth. Smoother, and what a flanger wants.' },
    ],
  }),
  numberParam({
    key: 'rate',
    label: 'Rate',
    min: 0.05,
    max: 12,
    scale: 'log',
    def: CHORUS_DEFAULTS.rate,
    help: 'How fast the sweep goes. Pitch deviation is the rate times the depth, so these two knobs are not independent — doubling the rate detunes twice as far.',
    format: (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`,
  }),
  numberParam({
    key: 'depth',
    label: 'Depth',
    min: 0,
    max: 1,
    def: CHORUS_DEFAULTS.depth,
    step: 0.01,
    help: 'How far the sweep travels, up to 12ms added to the shortest read. At 50% and 0.62Hz the pitch swings ±13 cents on a triangle and ±20 on a sine, measured off the output.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
  numberParam({
    key: 'delayMs',
    label: 'Delay',
    min: 0.2,
    max: 30,
    scale: 'log',
    def: CHORUS_DEFAULTS.delayMs,
    help: 'The shortest read — the sweep runs upwards from here. This one knob is most of the difference between the effects: 5 to 15ms is a chorus, under 3ms is a flanger, because that is where the comb notches climb into the range you can hear them move through.',
    format: (v) => (v < 10 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`),
  }),
  numberParam({
    key: 'feedback',
    label: 'Feedback',
    min: -0.9,
    max: 0.9,
    def: CHORUS_DEFAULTS.feedback,
    step: 0.01,
    help: 'What turns a chorus into a flanger. Signed, because fed back in antiphase the comb reinforces where the in-phase one cancels — hollow rather than resonant, and the two are different effects. At the ends it is a resonator worth up to 12dB on the right note, so the bus limiter earns its keep.',
    format: (v) => (v === 0 ? 'off' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`),
  }),
  numberParam({
    key: 'mix',
    label: 'Mix',
    min: 0,
    max: 1,
    def: CHORUS_DEFAULTS.mix,
    step: 0.01,
    help: 'A crossfade. Half and half is a chorus, because the effect *is* the beating between the two; 100% is vibrato, because there is nothing left to beat against; 0% is bit-for-bit the input.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
];

const SHAPE_LABEL = { triangle: 'tri', sine: 'sin' };

export default defineEffect({
  id: 'chorus',
  name: 'Chorus',
  short: 'CHO',
  params: CHORUS_PARAMS,
  presets: [
    // The three Juno-106 chorus buttons, near enough. Rates from the machine (I is about 0.5Hz, II
    // about 0.83, and pressing both selects one fast shallow sweep rather than summing them), depths
    // by ear against records rather than from a schematic - so these are an homage, not a model.
    { name: 'Juno I', state: { voices: 2, shape: 'triangle', rate: 0.5, depth: 0.42, delayMs: 5, feedback: 0, mix: 0.5 } },
    { name: 'Juno II', state: { voices: 2, shape: 'triangle', rate: 0.83, depth: 0.6, delayMs: 5, feedback: 0, mix: 0.5 } },
    { name: 'Juno I+II', state: { voices: 2, shape: 'triangle', rate: 8.5, depth: 0.16, delayMs: 4, feedback: 0, mix: 0.5 } },
    { name: 'Wide pad', state: { voices: 3, shape: 'sine', rate: 0.32, depth: 0.55, delayMs: 13, feedback: 0, mix: 0.45 } },
    { name: 'Flanger', state: { voices: 1, shape: 'sine', rate: 0.22, depth: 0.85, delayMs: 0.6, feedback: 0.6, mix: 0.5 } },
    { name: 'Vibrato', state: { voices: 1, shape: 'sine', rate: 5.2, depth: 0.1, delayMs: 3, feedback: 0, mix: 1 } },
  ],
  summary: (state) =>
    `${SHAPE_LABEL[state.shape] ?? state.shape} ×${state.voices} · ${
      state.rate < 1 ? state.rate.toFixed(2) : state.rate.toFixed(1)
    } Hz · ${Math.round((state.mix ?? 0) * 100)}% wet`,
  tailSeconds: (state) => chorusTailSeconds(state),

  create(ctx) {
    const effect = createWorkletEffect(ctx, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      params: { ...CHORUS_DEFAULTS },
    });
    return {
      input: effect.input,
      output: effect.output,
      ready: effect.ready,
      setState(state) {
        effect.post(state);
      },
      dispose: effect.dispose,
    };
  },
});
