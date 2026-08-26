// The delay, as a thing with knobs on.
//
// **Where the tempo comes in.** This is the first effect in the app that has to know something about
// the song rather than only about the signal, and the seam is here rather than in the DSP: a note
// division is resolved to a number of seconds at the moment the state is pushed, and the processor is
// only ever told seconds. Two things follow from that and both are the reason for it. The offline
// render uses the same code and gets the same interval, with no second definition of what a dotted
// eighth is; and a synced delay keeps up with a tempo change without the processor knowing that
// tempo is a concept, because the state is pushed on every note anyway (see chain.setEffects) and
// main.js pushes it once more when the box changes, for the case where nothing is playing.
//
// **Why the dotted eighth is the default.** Because it is the one everybody actually wants. Three
// against two, a repeat landing halfway between the offbeats, is the delay setting that made most of
// a decade of records - it is why the knob on a Boss DD is usually somewhere near it - and the reason
// a plain 1/8 sounds duller is that its repeats land where notes already are.

import { choiceParam, numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { divisionSeconds } from '../tempo.js';
import { DELAY_DEFAULTS, MAX_DELAY_SECONDS, delayTailSeconds } from './delay-dsp.js';
import { createWorkletEffect } from './worklet-effect.js';
import { hz } from '../format.js';

const PROCESSOR_URL = '/src/effects/worklets/delay-processor.js';
const PROCESSOR_NAME = 'delay';

const FREE = 'free';

const ms = (seconds) => (seconds >= 1 ? `${seconds.toFixed(2)} s` : `${Math.round(seconds * 1000)} ms`);

/**
 * How long a repeat is, in seconds, from whichever of the two controls is in charge.
 *
 * One function so that the tail estimate and the audio cannot disagree - they are asked at different
 * times by different callers (the exporter before rendering, the chain on every note) and a delay
 * whose declared tail was computed from a different interval than it plays would truncate exactly the
 * settings it was meant to protect.
 */
function timeSecondsFor(state) {
  if (state.sync && state.sync !== FREE) {
    const synced = divisionSeconds(state.sync);
    if (synced !== null) return Math.min(MAX_DELAY_SECONDS, synced);
  }
  return Math.min(MAX_DELAY_SECONDS, (state.timeMs ?? 450) / 1000);
}

export const DELAY_PARAMS = [
  choiceParam({
    key: 'sync',
    label: 'Time',
    def: '1/8.',
    help: 'A note division, resolved at the current tempo, or Free to set it in milliseconds. Synced is the default because a delay off the grid is a wash rather than a rhythm — and because it then follows the BPM box instead of needing to be reset after it.',
    choices: [
      { value: '1/2', label: '1/2' },
      { value: '1/4', label: '1/4' },
      { value: '1/4t', label: '1/4 triplet' },
      { value: '1/8.', label: '1/8 dotted', help: 'Three against two: the repeat lands halfway between the offbeats. The one that made most of the eighties.' },
      { value: '1/8', label: '1/8' },
      { value: '1/8t', label: '1/8 triplet' },
      { value: '1/16.', label: '1/16 dotted' },
      { value: '1/16', label: '1/16' },
      { value: FREE, label: 'Free (ms)', help: 'Use the Milliseconds knob instead. What a slapback needs — 80 to 120ms is not a division of anything.' },
    ],
  }),
  numberParam({
    key: 'timeMs',
    label: 'Milliseconds',
    min: 20,
    max: 2000,
    scale: 'log',
    def: 450,
    // Greyed out whenever Time names a division, because then it genuinely does nothing.
    activeWhen: (state) => state.sync === FREE,
    help: 'The repeat interval when Time is set to Free; greyed out otherwise. Dragging it glides rather than jumping, so the pitch of whatever is already in the line slides — a tape machine changing speed, and the reason this is worth dragging.',
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`),
  }),
  numberParam({
    key: 'feedback',
    label: 'Repeats',
    min: 0,
    max: 0.95,
    def: DELAY_DEFAULTS.feedback,
    step: 0.01,
    help: 'How much of each repeat goes round again. 0.95 is 134 repeats of arithmetic and rather fewer of audible sound, because the tone filter takes more off every pass.',
    format: (v) => (v <= 0 ? 'one only' : `${Math.round(v * 100)}%`),
  }),
  numberParam({
    key: 'tone',
    label: 'Tone',
    min: 500,
    max: 20000,
    scale: 'log',
    def: DELAY_DEFAULTS.tone,
    help: 'A lowpass inside the feedback, so each repeat is darker than the one before rather than every repeat being equally dark. The difference between a delay that recedes and one that sits there. At the top it is out of the loop entirely.',
    format: (v) => (v >= 20000 ? 'off' : hz(v)),
  }),
  numberParam({
    key: 'lowCut',
    label: 'Low cut',
    min: 20,
    max: 1000,
    scale: 'log',
    def: DELAY_DEFAULTS.lowCut,
    help: 'A highpass in the same loop. The first thing to reach for when a delay on a bass part turns the low end to mud — the repeats keep their shape and stop stacking up underneath.',
    format: hz,
  }),
  numberParam({
    key: 'wow',
    label: 'Wow',
    min: 0,
    max: 1,
    def: DELAY_DEFAULTS.wow,
    step: 0.01,
    help: 'Two slow sines on the read position, 0.62Hz and 5.9Hz. At 100% the pitch swings ±12.3 cents, which is measured off the output rather than claimed. It is what stops a long feedback becoming one note held forever.',
    format: (v) => (v <= 0 ? 'off' : `${Math.round(v * 100)}%`),
  }),
  numberParam({
    key: 'saturate',
    label: 'Saturate',
    min: 0,
    max: 1,
    def: DELAY_DEFAULTS.saturate,
    step: 0.01,
    help: 'Soft clipping inside the loop, so loud repeats go dirty and quiet ones do not. Normalised so it can only ever take level away — the version that preserved full scale had a small-signal gain of 2.25 and turned 95% feedback into an oscillator.',
    format: (v) => (v <= 0 ? 'clean' : `${Math.round(v * 100)}%`),
  }),
  numberParam({
    key: 'mix',
    label: 'Mix',
    min: 0,
    max: 1,
    def: DELAY_DEFAULTS.mix,
    step: 0.01,
    help: 'A crossfade, so 100% is repeats with no dry at all and 0% is bit-for-bit the input — measured, not assumed.',
    format: (v) => `${Math.round(v * 100)}%`,
  }),
];

export default defineEffect({
  id: 'delay',
  name: 'Delay',
  short: 'DLY',
  params: DELAY_PARAMS,
  presets: [
    // The lead delay. Modest feedback because the dotted eighth's whole job is to fill the gap
    // between the offbeats, and a long tail fills the gaps that were meant to stay empty.
    { name: 'Dotted 8th', state: { sync: '1/8.', feedback: 0.34, tone: 4200, lowCut: 220, wow: 0.25, saturate: 0.2, mix: 0.3 } },
    { name: 'Quarter', state: { sync: '1/4', feedback: 0.4, tone: 3400, lowCut: 200, wow: 0.3, saturate: 0.25, mix: 0.28 } },
    // Not a division of anything, which is exactly why Free exists. A single repeat close enough
    // behind that you hear it as the sound of the room and not as an echo.
    { name: 'Slapback', state: { sync: FREE, timeMs: 96, feedback: 0.1, tone: 6500, lowCut: 260, wow: 0.15, saturate: 0.3, mix: 0.26 } },
    { name: '16ths', state: { sync: '1/16', feedback: 0.58, tone: 2600, lowCut: 260, wow: 0.2, saturate: 0.2, mix: 0.24 } },
    { name: 'Dub', state: { sync: '1/8', feedback: 0.86, tone: 1500, lowCut: 320, wow: 0.6, saturate: 0.65, mix: 0.4 } },
    { name: 'Tape wash', state: { sync: '1/4', feedback: 0.78, tone: 2100, lowCut: 180, wow: 0.85, saturate: 0.5, mix: 0.45 } },
  ],
  summary: (state) => {
    const seconds = timeSecondsFor(state);
    const where = state.sync && state.sync !== FREE ? state.sync : 'free';
    return `${where} ${ms(seconds)} · ${Math.round((state.feedback ?? 0) * 100)}% · ${Math.round((state.mix ?? 0) * 100)}% wet`;
  },
  tailSeconds: (state) => delayTailSeconds(timeSecondsFor(state), state.feedback),

  create(ctx) {
    const effect = createWorkletEffect(ctx, {
      url: PROCESSOR_URL,
      name: PROCESSOR_NAME,
      params: { ...DELAY_DEFAULTS },
    });
    return {
      input: effect.input,
      output: effect.output,
      ready: effect.ready,
      setState(state) {
        // The division is resolved here and only seconds cross the thread. See the note at the top.
        effect.post({ ...state, timeSeconds: timeSecondsFor(state) });
      },
      dispose: effect.dispose,
    };
  },
});
