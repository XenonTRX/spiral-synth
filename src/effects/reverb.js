import { numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { REVERB_DEFAULTS } from './reverb-dsp.js';
import { createWorkletEffect } from './worklet-effect.js';
import { hz } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/reverb-processor.js', import.meta.url);
const PROCESSOR_NAME = 'reverb';


export const REVERB_PARAMS = [
  numberParam({
    key: 'mix',
    label: 'Mix',
    min: 0,
    max: 1,
    def: REVERB_DEFAULTS.mix,
    step: 0.01,
    help: 'How much of the output is the room. At 0% the effect is bit-for-bit transparent — measured, not assumed.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
  numberParam({
    key: 'decay',
    label: 'Decay',
    min: 0.15,
    max: 12,
    scale: 'log',
    def: REVERB_DEFAULTS.decay,
    help: 'RT60: how long the tail takes to fall by 60dB. Measured against this knob it lands within 0.2% with damping off, and 13–17% short with damping in circuit — because damping is a real extra loss, exactly as a soft room is shorter than a bright one.',
    format: (v) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`),
  }),
  numberParam({
    key: 'size',
    label: 'Size',
    min: 0.1,
    max: 2,
    def: REVERB_DEFAULTS.size,
    step: 0.01,
    help: 'Scales all eight delay lines together, which is what makes a space feel large or small independently of how long it rings. Small and long is a tiled bathroom; large and short is a carpeted hall.',
    format: (v) => `${v.toFixed(2)}×`,
  }),
  numberParam({
    key: 'damping',
    label: 'Damping',
    min: 500,
    max: 20000,
    scale: 'log',
    def: REVERB_DEFAULTS.damping,
    help: 'A lowpass inside the feedback, so each pass loses more at the top than at the bottom and the tail darkens as it fades. At the very top it is removed from the loop rather than opened, because even a 20kHz one-pole costs over a decibel per pass and a reverb is all passes.',
    format: (v) => (v >= 20000 ? 'off' : hz(v)),
  }),
  numberParam({
    key: 'predelayMs',
    label: 'Predelay',
    min: 0,
    max: 200,
    def: REVERB_DEFAULTS.predelayMs,
    step: 1,
    help: 'The gap before the room arrives, which is most of what makes a space sound big. The first reflection actually lands this much later plus the shortest delay line — 23ms at Size 1 — so the reading is the gap you added rather than the total.',
    format: (v) => `${Math.round(v)} ms`,
  }),
  numberParam({
    key: 'lowCut',
    label: 'Low cut',
    min: 20,
    max: 1000,
    scale: 'log',
    def: REVERB_DEFAULTS.lowCut,
    help: 'A highpass on the way in, so the tail does not pile up under the bass. The usual first move when a reverb makes a mix muddy rather than large.',
    format: hz,
  }),
];

export default defineEffect({
  id: 'reverb',
  name: 'Reverb',
  short: 'RVB',
  params: REVERB_PARAMS,
  presets: [
    { name: 'Room', state: { decay: 0.9, size: 0.55, damping: 4200, predelayMs: 8, mix: 0.22, lowCut: 160 } },
    { name: 'Hall', state: { decay: 3.4, size: 1.4, damping: 5600, predelayMs: 32, mix: 0.3, lowCut: 130 } },
    { name: 'Plate', state: { decay: 2.1, size: 0.35, damping: 9000, predelayMs: 4, mix: 0.3, lowCut: 220 } },
    // Small and very long, which is the combination a convolved impulse cannot offer without a second
    // impulse: the space is tiny and it rings for eight seconds.
    { name: 'Tiles', state: { decay: 8, size: 0.2, damping: 20000, predelayMs: 0, mix: 0.35, lowCut: 300 } },
    { name: 'Wash', state: { decay: 6.5, size: 1.8, damping: 3000, predelayMs: 60, mix: 0.5, lowCut: 240 } },
  ],
  summary: (state) =>
    `${state.decay >= 1 ? `${state.decay.toFixed(1)}s` : `${Math.round(state.decay * 1000)}ms`} · ${Math.round(state.mix * 100)}% wet`,
  // What a part with this on it is still doing after its last note, so a render leaves room for it.
  tailSeconds: (state) => state.decay + (state.predelayMs ?? 0) / 1000,

  create(ctx) {
    const effect = createWorkletEffect(ctx, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      params: { ...REVERB_DEFAULTS },
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
