// The third instrument, and the one that does not fit the way the other two do.
//
// Both of the others are arrangements of Web Audio nodes: `create` hands back an object, the first
// note builds a little graph, and nothing has to wait for anything. This one is a worklet, and a
// worklet cannot exist until `ctx.audioWorklet.addModule()` has resolved. That single fact is the
// first thing in this project to genuinely strain the instrument seam, because the scheduler that
// plays notes is synchronous by construction - it commits notes to the audio clock from inside a
// 25ms tick and has nowhere to put an await.
//
// The resolution is that the instrument absorbs its own asynchrony rather than exporting it. A
// note arriving before the processor exists is not dropped and does not block: it is held, with
// the audio-clock time it was meant for, and delivered when the node appears. Loading takes a few
// milliseconds and the scheduler commits notes 150ms ahead, so in practice the queue drains long
// before the first note was due to sound. Nothing above this file knows any of that happened.
//
// **On WAM.** This follows the shape of a Web Audio Module without being one. A WAM plugin is an
// ES module whose default export is a descriptor and a factory, instantiated asynchronously,
// pairing a main-thread node with a processor on the audio thread, exposing parameter descriptors
// and getState/setState. All of that is here. What is not here is `@webaudiomodules/sdk`, because
// this project has no build step and no dependencies, and what the SDK provides is the tedious
// message plumbing between the two halves - which is the part written out below. So this is not a
// WAM and would not load in a WAM host unchanged; it is the same contract, arrived at
// independently, which is the point. Adopting the shape costs nothing now and is what makes
// swapping in the real thing an import rather than a rewrite.

import { choiceParam, defineInstrument, harmonicSeries, levelParam, numberParam } from '../instruments.js';
import { cutoffTrajectory, steadyFilterState } from './filter-envelope.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/ladder-processor.js', import.meta.url);
const PROCESSOR_NAME = 'ladder';


export const LADDER_PARAMS = [
  choiceParam({
    key: 'waveform',
    label: 'Waveform',
    def: 'saw',
    choices: [
      { value: 'saw', label: 'Saw' },
      { value: 'square', label: 'Square' },
    ],
  }),
  numberParam({
    key: 'cutoff',
    label: 'Filter cutoff',
    min: 20,
    max: 18000,
    scale: 'log',
    def: 700,
    mod: 'octaves',
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
  }),
  numberParam({
    key: 'resonance',
    label: 'Resonance',
    min: 0,
    max: 1,
    def: 0.6,
    step: 0.01,
    mod: 'amount',
    help: 'Feedback round the four poles. At the top it puts a very strong peak at the cutoff — measured 31dB of lift between the harmonics, where the oscillator contributes nothing.',
    format: pct,
  }),
  numberParam({
    key: 'drive',
    label: 'Drive',
    min: 0.5,
    max: 8,
    def: 2,
    step: 0.1,
    mod: 'units',
    help: 'How hard the signal is pushed into the saturating part of the filter. This is the knob a BiquadFilter cannot have.',
    format: (v) => `${v.toFixed(1)}×`,
  }),
  numberParam({
    key: 'filterEnvAmount',
    label: 'Filter sweep',
    min: -4,
    max: 5,
    def: 2.4,
    step: 0.05,
    format: (v) => (v === 0 ? 'off' : `${v > 0 ? '+' : ''}${v.toFixed(2)} oct`),
  }),
  numberParam({ key: 'filterAttack', label: 'Sweep attack', min: 0, max: 2, def: 0.004, step: 0.001, format: ms }),
  numberParam({ key: 'filterDecay', label: 'Sweep decay', min: 0.001, max: 4, def: 0.35, step: 0.01, format: ms }),
  numberParam({ key: 'filterSustain', label: 'Sweep sustain', min: 0, max: 1, def: 0.2, step: 0.01, format: pct }),
  numberParam({ key: 'attack', label: 'Attack', min: 0.001, max: 2, def: 0.004, step: 0.001, format: ms }),
  numberParam({ key: 'decay', label: 'Decay', min: 0.001, max: 4, def: 0.25, step: 0.01, format: ms }),
  numberParam({ key: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.7, step: 0.01, format: pct }),
  numberParam({ key: 'release', label: 'Release', min: 0.005, max: 4, def: 0.25, step: 0.005, format: ms }),
  // Fine tuning, and where anything aimed at pitch arrives. See the note in subtractive.js.
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
  numberParam({
    key: 'polyblep',
    label: 'Band-limit',
    min: 0,
    max: 1,
    def: 1,
    step: 1,
    help: 'The anti-aliasing correction on the oscillator. Turn it off and watch the scope — that is what it is for.',
    format: (v) => (v >= 0.5 ? 'on' : 'off — aliasing'),
  }),
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Every instrument here has one now. Before they were measured they were five unrelated fudge
 * factors, each nudged until that instrument sounded reasonable on its own, and they were 27dB
 * apart: at Level 100% one note peaked at -15.2dBFS here against +3.3dBFS on the subtractive synth and -23.9dBFS on the wavetable at the extremes. So the same
 * number on two parts' faders meant two different loudnesses, switching a part's instrument moved
 * it by up to 27dB, and a mix could not be balanced by anything but ear, one part at a time.
 *
 * It multiplies the *level* rather than the output, which matters: a modulation aimed at the level
 * travels with it (`mod: 'level'`), so scaling the level scales its modulation too and a tremolo
 * keeps its depth relative to the note. Scaling the output would have left the modulation behind.
 *
 * See `levelParam` in params.js for the knob, and the load-time conversion in storage.js that keeps
 * songs written before this sounding exactly as they did.
 */
const OUTPUT_TRIM = 5.7496;


const PRESETS = [
  { name: 'Acid', state: { cutoff: 300, resonance: 0.86, drive: 3.4, filterEnvAmount: 3.4, filterDecay: 0.28, filterSustain: 0.05, decay: 0.3, sustain: 0.55, release: 0.14 } },
  { name: 'Fat Bass', state: { cutoff: 240, resonance: 0.5, drive: 4.5, filterEnvAmount: 1.8, filterDecay: 0.2, filterSustain: 0.25, sustain: 0.7, release: 0.16 } },
  { name: 'Growl', state: { waveform: 'square', cutoff: 420, resonance: 0.72, drive: 6.5, filterEnvAmount: 2.2, filterDecay: 0.5, filterSustain: 0.4, sustain: 0.8, release: 0.3 } },
  { name: 'Sing', state: { cutoff: 1200, resonance: 0.99, drive: 1.2, filterEnvAmount: 0, attack: 0.05, decay: 0.4, sustain: 0.9, release: 0.6 } },
  // Modulation on the audio thread, and the pair that shows what a worklet gets for it: the cutoff
  // wobbles, and the *drive* wobbles with it a quarter-cycle out, so the saturation moves too. The
  // drive knob is one a BiquadFilter cannot have and this is a routing it cannot have either.
  {
    name: 'Wobble',
    state: {
      cutoff: 260,
      resonance: 0.82,
      drive: 3,
      filterEnvAmount: 0.8,
      filterDecay: 0.2,
      filterSustain: 0.4,
      attack: 0.006,
      decay: 0.3,
      sustain: 0.85,
      release: 0.2,
      lfo1Rate: 3.2,
      lfo1Shape: 'triangle',
      lfo2Rate: 1.6,
      mod: [
        { source: 'lfo1', target: 'cutoff', depth: 2.2 },
        { source: 'lfo2', target: 'drive', depth: 2 },
      ],
    },
  },
];

const ensureModule = (ctx) => loadWorklet(ctx, PROCESSOR_URL);

export default defineInstrument({
  id: 'ladder',
  // Declared as well as applied, because the loader has to be able to undo it for a song written
  // before the levels were calibrated - see storage.js.
  outputTrim: OUTPUT_TRIM,
  name: 'Ladder (worklet)',
  params: LADDER_PARAMS,
  presets: PRESETS,
  badge: () => 'DSP',
  // Declared rather than left to the fallback, which would guess the same number: this one really
  // is just the release. Unlike the node-graph instruments it does not hold a note open for its own
  // envelopes - the processor runs them per voice and lets a short note be short - so `earliestEnd`
  // is the note's own start and there is no overshoot to leave room for.
  tailSeconds: (state) => state.release,

  /**
   * Offered to callers that can wait - the scope renders offline and has nothing to race, so it
   * awaits this and then measures a node that is definitely there. The live path does not call it
   * and relies on the queue below instead, because the scheduler has nowhere to put an await.
   */
  prepare: (ctx) => ensureModule(ctx).promise,

  measurement: {
    // Nothing to park but the envelopes: the cutoff has to stop moving or the spectrum smears, and
    // the amp has to stop moving for the same reason. Resonance and drive stay exactly as set,
    // because they are what is being measured.
    steadyState: (state) => steadyFilterState(state),
    // A saturating filter is a nonlinearity, and a nonlinearity's whole job is to make harmonics
    // that were not in its input. They are harmonics of the note, so the plain series is the
    // honest description of what was asked for - what it must not include is anything at a
    // frequency that is not a multiple of the note, which is what aliasing is and what the
    // measurement is for.
    partials: (state, f0, nyquist) => harmonicSeries(f0 * 2 ** ((state.tune ?? 0) / 12), nyquist),
    trajectory: cutoffTrajectory,
  },

  create(ctx, destination) {
    let node = null;
    let state = {};
    let nextId = 1;
    let load = null;

    // Notes that arrived before the processor did. Each keeps the audio-clock time it was meant
    // for, so delivering them late still sounds them on time - which is the whole trick, and only
    // works because this engine schedules against the clock rather than against "now".
    const queued = [];

    const send = (message) => {
      if (node) node.port.postMessage(message);
      else queued.push(message);
    };

    /**
     * Construct the node, handing it everything it has been told so far.
     *
     * Deliberately not called from `create`. Whatever is known before the first sample has to
     * travel through `processorOptions`, because a port message does not reliably arrive before
     * then: an OfflineAudioContext renders as fast as it can and finishes before the message
     * queue has been serviced. That was measured rather than guessed - a probe processor saw
     * `gotMessageByFirstProcess: false` while the same payload sent as `processorOptions` was
     * there in its constructor.
     *
     * So the queue is not a fallback for a node that does not exist yet; it is the note schedule,
     * and building late enough to carry it is the point.
     */
    function build() {
      if (node) return;
      node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { state, events: queued },
      });
      node.port.onmessage = (event) => {
        if (event.data?.type === 'load') load = event.data;
      };
      node.connect(destination);
      queued.length = 0;
    }

    const module = ensureModule(ctx);
    // Live playback: build at the end of this task, so the burst of notes the scheduler commits
    // in one tick travels in the constructor and everything after it goes by port, which is
    // reliable on a context running in real time.
    if (module.ready) queueMicrotask(build);
    else {
      module.promise.then(build).catch(() => {
        // A worklet that will not load is a part that makes no sound, which is bad, and is still
        // better than an exception thrown out of the scheduler every 25ms, which is worse.
        queued.length = 0;
      });
    }

    return {
      setState(next) {
        // The trim rides along with the state rather than being applied in the processor, so the
        // audio thread never has to know it exists and the number lives in one file.
        state = { ...next, gain: (next.gain ?? 1) * OUTPUT_TRIM };
        // Only sent when there is something to send it to. Before the node exists the state
        // travels in `processorOptions` instead, and queueing it here was actively harmful: the
        // queue is the note schedule, the processor drains it by comparing `event.time` against
        // the clock, and a params message has no time. `undefined <= now` is false, so it sat at
        // the head of the queue and every note behind it waited forever. The render came back
        // silent and the scope dutifully reported a flawless synth.
        if (node) node.port.postMessage({ type: 'params', state });
      },
      noteOn(midi, freq, when, velocity = 1, glide = null) {
        const id = nextId++;
        // The pitch travels as well as the frequency, because a modulation source can be the note
        // itself - filter key tracking is exactly that - and `keytrackAt` is written in MIDI numbers
        // so that it means the same thing on both sides of the thread boundary.
        //
        // A slide crosses as two plain numbers rather than as an object, because everything on this
        // port is copied per note and a message with a nested shape in it is a second allocation for
        // something that is nearly always `0, 0`.
        send({
          type: 'noteOn',
          id,
          freq,
          midi,
          velocity,
          time: when,
          glideFrom: glide ? glide.fromFreq : 0,
          glideSeconds: glide ? glide.seconds : 0,
        });
        let released = false;
        return {
          // One node for the whole instrument, however many notes are sounding. The count the
          // load meter wants is voices, and the processor reports the real one; this is the
          // per-note contribution, which for a worklet is one voice rather than an oscillator.
          oscillators: 1,
          start: when,
          release(at) {
            if (released) return at;
            released = true;
            send({ type: 'noteOff', id, time: at });
            return at + (state.release ?? 0.25);
          },
          earliestEnd: () => when,
        };
      },
      /**
       * "You have been told everything — exist now."
       *
       * Only an offline render needs this, and it needs it because it is about to start a render
       * that will finish faster than a message can cross a thread. Live playback never calls it
       * and would gain nothing if it did.
       */
      commit() {
        if (module.ready) build();
      },
      /** The real per-quantum cost, measured on the thread that has the deadline. */
      getLoad: () => load,
      dispose() {
        if (!node) return;
        node.port.postMessage({ type: 'panic' });
        node.disconnect();
        node = null;
      },
    };
  },
});
