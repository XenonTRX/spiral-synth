import { numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { COMPRESSOR_DEFAULTS } from './compressor-dsp.js';
import { createWorkletEffect } from './worklet-effect.js';

const PROCESSOR_URL = '/src/effects/worklets/compressor-processor.js';
const PROCESSOR_NAME = 'compressor';

const ms = (v) => (v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`);
const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export const COMPRESSOR_PARAMS = [
  numberParam({
    key: 'thresholdDb',
    label: 'Threshold',
    min: -60,
    max: 0,
    def: COMPRESSOR_DEFAULTS.thresholdDb,
    step: 0.5,
    help: 'The level above which it starts turning things down. Nothing below this is touched at all — which is why a threshold and a part\'s Level are not interchangeable.',
    format: (v) => `${v.toFixed(1)} dB`,
  }),
  numberParam({
    key: 'ratio',
    label: 'Ratio',
    min: 1,
    max: 20,
    scale: 'log',
    def: COMPRESSOR_DEFAULTS.ratio,
    help: 'How much of what goes over the threshold survives: at 4:1, twelve decibels over becomes three.',
    format: (v) => `${v.toFixed(1)}:1`,
  }),
  numberParam({
    key: 'kneeDb',
    label: 'Knee',
    min: 0,
    max: 24,
    def: COMPRESSOR_DEFAULTS.kneeDb,
    step: 0.5,
    help: 'How wide a band around the threshold eases into the ratio instead of hitting it. At 0 a signal hovering at the threshold crosses between untouched and compressed every cycle, which is audible as a grainy edge on exactly the material that sits there.',
    format: (v) => (v === 0 ? 'hard' : `${v.toFixed(1)} dB`),
  }),
  numberParam({
    key: 'attackMs',
    label: 'Attack',
    min: 0.1,
    max: 200,
    scale: 'log',
    def: COMPRESSOR_DEFAULTS.attackMs,
    help: 'One time constant, not a 10-to-90 time — so 10ms here travels from a tenth to nine tenths of its reduction in about 22ms. A slow attack lets the transient through, which is how a compressor makes a drum hit harder rather than softer.',
    format: ms,
  }),
  numberParam({
    key: 'releaseMs',
    label: 'Release',
    min: 5,
    max: 2000,
    scale: 'log',
    def: COMPRESSOR_DEFAULTS.releaseMs,
    help: 'One time constant again. Too fast and the level audibly breathes on every note; too slow and one loud moment ducks the bar after it.',
    format: ms,
  }),
  numberParam({
    key: 'makeupDb',
    label: 'Makeup',
    min: -12,
    max: 24,
    def: COMPRESSOR_DEFAULTS.makeupDb,
    step: 0.5,
    help: 'Gain after the compression, to put back what was taken off. A compressor with none is only ever quieter, which makes it impossible to judge by ear against the bypass.',
    format: db,
  }),
  numberParam({
    key: 'mix',
    label: 'Mix',
    min: 0,
    max: 1,
    def: COMPRESSOR_DEFAULTS.mix,
    step: 0.01,
    help: 'Below 100% the uncompressed signal is still there underneath — parallel compression, which keeps the transients the compressor removed while still lifting everything quiet.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
];

export default defineEffect({
  id: 'compressor',
  name: 'Compressor',
  short: 'CMP',
  params: COMPRESSOR_PARAMS,
  presets: [
    { name: 'Glue', state: { thresholdDb: -20, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 200, makeupDb: 2 } },
    { name: 'Squash', state: { thresholdDb: -28, ratio: 10, kneeDb: 3, attackMs: 3, releaseMs: 80, makeupDb: 8 } },
    // A slow attack lets every stick hit through untouched and clamps what follows, which is the whole
    // of why a compressed drum sounds harder rather than softer.
    { name: 'Punch', state: { thresholdDb: -24, ratio: 6, kneeDb: 2, attackMs: 30, releaseMs: 120, makeupDb: 6 } },
    { name: 'Parallel', state: { thresholdDb: -36, ratio: 12, kneeDb: 6, attackMs: 1, releaseMs: 150, makeupDb: 10, mix: 0.4 } },
  ],
  summary: (state) => `${state.ratio.toFixed(1)}:1 at ${Math.round(state.thresholdDb)} dB`,

  create(ctx) {
    const effect = createWorkletEffect(ctx, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      params: { ...COMPRESSOR_DEFAULTS },
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
