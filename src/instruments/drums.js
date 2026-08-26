// The fifth instrument, and the first where a note is not a pitch.
//
// Everything else here takes a MIDI number and sounds it. A kit takes a MIDI number and *looks it
// up*: 36 is the kick, and playing it an octave higher is not a higher kick, it is a tom. That one
// difference is what the two new hooks below exist for. The roll's key gutter has always drawn a
// piano keyboard, which is exactly right for a piano and useless for a kit - so an instrument can
// now say what its notes are called, and the gutter reads Kick, Snare, Closed Hat. And the scope
// has always offered C4 through C7 to measure, none of which a kit answers to at all, so an
// instrument can now say which notes are worth pointing a spectrum at.
//
// It is also the first instrument the scope's headline number is meaningless for. "Worst
// unasked-for partial" assumes there is a note being asked for, and a snare is two thirds noise on
// purpose - measured as though it were tonal it reports about +6dBc, a fault louder than the drum,
// which is the same trap the FM sidebands sprang and needs the same answer: say so rather than
// print a plausible number. The Sweep view stays useful and is in fact the best view of a kit
// there is - a kick's pitch envelope is *visible* as a curve falling through the first eighty
// milliseconds, which is the thing you are actually adjusting when you turn the bend knob.

import { defineInstrument, levelParam, numberParam } from '../instruments.js';
import { DRUMS, DRUM_HIGH, DRUM_LOW, drumForMidi } from './drum-map.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = '/src/instruments/worklets/drum-processor.js';
const PROCESSOR_NAME = 'drums';

const hz = (v) => `${Math.round(v)} Hz`;

export const DRUM_PARAMS = [
  numberParam({ key: 'kickTune', label: 'Kick tune', min: 30, max: 120, def: 52, step: 0.5, format: hz }),
  numberParam({ key: 'kickDecay', label: 'Kick decay', min: 0.05, max: 2, def: 0.42, step: 0.01, format: ms }),
  numberParam({
    key: 'kickBend',
    label: 'Kick bend',
    min: 0,
    max: 8,
    def: 3.2,
    step: 0.1,
    help: 'How far the pitch falls at the start of the hit, as a multiple of the tune. This is the knob that decides between a click and a boom — at 0 it is a beep.',
    format: (v) => (v === 0 ? 'none' : `×${(1 + v).toFixed(1)}`),
  }),
  numberParam({ key: 'kickClick', label: 'Kick click', min: 0, max: 1, def: 0.35, step: 0.01, format: pct }),
  numberParam({ key: 'kickLevel', label: 'Kick level', min: 0, max: 1.5, def: 1, step: 0.01, format: pct }),

  numberParam({ key: 'snareTune', label: 'Snare tune', min: 100, max: 400, def: 190, step: 1, format: hz }),
  numberParam({ key: 'snareDecay', label: 'Snare decay', min: 0.03, max: 1, def: 0.19, step: 0.005, format: ms }),
  numberParam({
    key: 'snareSnap',
    label: 'Snare snap',
    min: 0,
    max: 1,
    def: 0.6,
    step: 0.01,
    help: 'The balance between the drum and the wires under it — all tone at 0, all noise at 1.',
    format: pct,
  }),
  numberParam({ key: 'snareLevel', label: 'Snare level', min: 0, max: 1.5, def: 0.85, step: 0.01, format: pct }),

  numberParam({ key: 'clapDecay', label: 'Clap decay', min: 0.05, max: 1, def: 0.24, step: 0.01, format: ms }),
  numberParam({ key: 'clapLevel', label: 'Clap level', min: 0, max: 1.5, def: 0.8, step: 0.01, format: pct }),

  numberParam({
    key: 'hatTone',
    label: 'Hat tone',
    min: 0.5,
    max: 2,
    def: 1,
    step: 0.01,
    help: 'Moves all six of the oscillator bank together. The hats and both cymbals come off the same bank, so this is the metal the whole kit is made of.',
    format: (v) => `×${v.toFixed(2)}`,
  }),
  numberParam({ key: 'hatClosedDecay', label: 'Closed hat', min: 0.01, max: 0.4, def: 0.055, step: 0.005, format: ms }),
  numberParam({ key: 'hatOpenDecay', label: 'Open hat', min: 0.05, max: 2, def: 0.42, step: 0.01, format: ms }),
  numberParam({ key: 'hatLevel', label: 'Hat level', min: 0, max: 1.5, def: 0.7, step: 0.01, format: pct }),

  numberParam({ key: 'tomTune', label: 'Tom tune', min: 0.5, max: 2, def: 1, step: 0.01, format: (v) => `×${v.toFixed(2)}` }),
  numberParam({ key: 'tomDecay', label: 'Tom decay', min: 0.1, max: 2, def: 0.5, step: 0.01, format: ms }),
  numberParam({ key: 'tomLevel', label: 'Tom level', min: 0, max: 1.5, def: 0.8, step: 0.01, format: pct }),

  numberParam({ key: 'cymbalDecay', label: 'Cymbal decay', min: 0.2, max: 5, def: 1.8, step: 0.05, format: ms }),
  numberParam({ key: 'cymbalLevel', label: 'Cymbal level', min: 0, max: 1.5, def: 0.55, step: 0.01, format: pct }),
  numberParam({ key: 'rimLevel', label: 'Rim level', min: 0, max: 1.5, def: 0.7, step: 0.01, format: pct }),

  levelParam({ label: 'Kit level' }),
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Every instrument here has one now. Before they were measured they were five unrelated fudge
 * factors, each nudged until that instrument sounded reasonable on its own, and they were 27dB
 * apart: at Level 100% one note peaked at -6.4dBFS here against +3.3dBFS on the subtractive synth and -23.9dBFS on the wavetable at the extremes. So the same
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
const OUTPUT_TRIM = 2.0888;


const PRESETS = [
  {
    name: '808',
    state: {
      kickTune: 46, kickDecay: 0.95, kickBend: 2.4, kickClick: 0.22, kickLevel: 1.1,
      snareTune: 178, snareDecay: 0.16, snareSnap: 0.55, snareLevel: 0.8,
      clapDecay: 0.3, hatTone: 1, hatClosedDecay: 0.05, hatOpenDecay: 0.55, hatLevel: 0.62,
      tomTune: 0.85, tomDecay: 0.7, cymbalDecay: 2.6, cymbalLevel: 0.5,
    },
  },
  {
    name: '909',
    state: {
      kickTune: 58, kickDecay: 0.34, kickBend: 3.8, kickClick: 0.55, kickLevel: 1.05,
      snareTune: 210, snareDecay: 0.22, snareSnap: 0.72, snareLevel: 0.9,
      clapDecay: 0.2, hatTone: 1.14, hatClosedDecay: 0.045, hatOpenDecay: 0.35, hatLevel: 0.75,
      tomTune: 1.05, tomDecay: 0.42, cymbalDecay: 1.5, cymbalLevel: 0.6,
    },
  },
  {
    name: 'Tight',
    state: {
      kickTune: 62, kickDecay: 0.18, kickBend: 4.2, kickClick: 0.7, kickLevel: 1,
      snareTune: 240, snareDecay: 0.11, snareSnap: 0.8, snareLevel: 0.85,
      clapDecay: 0.13, hatTone: 1.3, hatClosedDecay: 0.028, hatOpenDecay: 0.2, hatLevel: 0.7,
      tomTune: 1.2, tomDecay: 0.28, cymbalDecay: 0.9, cymbalLevel: 0.45,
    },
  },
  {
    name: 'Boom',
    state: {
      kickTune: 40, kickDecay: 1.5, kickBend: 2, kickClick: 0.14, kickLevel: 1.2,
      snareTune: 160, snareDecay: 0.42, snareSnap: 0.45, snareLevel: 0.8,
      clapDecay: 0.5, hatTone: 0.82, hatClosedDecay: 0.09, hatOpenDecay: 0.9, hatLevel: 0.6,
      tomTune: 0.7, tomDecay: 1.1, cymbalDecay: 3.6, cymbalLevel: 0.55,
    },
  },
];

const ensureModule = (ctx) => loadWorklet(ctx, PROCESSOR_URL);

export default defineInstrument({
  id: 'drums',
  // Declared as well as applied, because the loader has to be able to undo it for a song written
  // before the levels were calibrated - see storage.js.
  outputTrim: OUTPUT_TRIM,
  name: 'Drum Kit',
  params: DRUM_PARAMS,
  presets: PRESETS,
  badge: () => 'KIT',

  /**
   * What this instrument calls each note.
   *
   * The roll asks per pitch and takes what it gets - a null means "you name it", which is what
   * every other instrument returns, so nothing changed for them.
   */
  noteLabel: (midi) => drumForMidi(midi)?.name ?? null,
  /** Where the kit lives, so a surface can frame it without knowing what a drum is. */
  noteRange: () => ({ low: DRUM_LOW, high: DRUM_HIGH }),
  /**
   * And what a kit cannot do: slide.
   *
   * A slide is a pitch travelling from one note to the next, and these are not pitches - 38 is a
   * snare and 42 is a hat, and the distance between them is four of nothing. Declared rather than
   * inferred from `noteLabel`, so the reason is stated where it is true instead of being read off a
   * coincidence. The roll asks before it offers the gesture.
   */
  slides: false,
  /** The rows a step lane draws, top to bottom. Declining this is how an instrument opts out of one. */
  steps: () => DRUMS,

  // The longest any drum can still be ringing. Cymbals win by a distance, and getting this wrong
  // truncates the crash at the end of an exported song.
  tailSeconds: (state) => Math.max(
    state.kickDecay, state.snareDecay, state.clapDecay,
    state.hatOpenDecay, state.tomDecay, state.cymbalDecay,
  ) * 1.6,

  prepare: (ctx) => ensureModule(ctx).promise,

  measurement: {
    /**
     * The headline number does not apply here, and saying so is the only honest option.
     *
     * Everything else in this project is measured by how much of it is *not* a multiple of the
     * note. A snare is deliberately mostly noise, so that measure reports it as catastrophically
     * broken - about +6dBc, a fault louder than the drum. The number is not wrong, the question is:
     * there is no fundamental to be unasked-for relative to. The panel drops the readout and keeps
     * the plot, which is the part that was telling you anything anyway.
     */
    tonal: false,
    why: 'A kit is percussion — most of it is noise on purpose, so "unasked-for partial" has nothing to measure against. The shape of the spectrum, and the Sweep view, are what to read here.',
    // What the scope offers instead of C4–C7, none of which a kit answers to.
    notes: DRUMS.map((drum) => ({ midi: drum.midi, label: drum.name })),
    // A kit has no envelope to park: every drum is a one-shot whose decay is the sound. Holding it
    // still would measure a different instrument.
    steadyState: (state) => state,
  },

  create(ctx, destination) {
    let node = null;
    let state = {};
    let nextId = 1;
    let load = null;
    const queued = [];

    const send = (message) => {
      if (node) node.port.postMessage(message);
      else queued.push(message);
    };

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
    if (module.ready) queueMicrotask(build);
    else module.promise.then(build).catch(() => { queued.length = 0; });

    return {
      setState(next) {
        // The trim rides along with the state rather than being applied in the processor, so the
        // audio thread never has to know it exists and the number lives in one file.
        state = { ...next, gain: (next.gain ?? 1) * OUTPUT_TRIM };
        if (node) node.port.postMessage({ type: 'params', state });
      },
      // Four arguments where every other instrument takes five: the fifth is a slide, and a slide is
      // a pitch travelling between two notes that have one. See `slides: false` above.
      noteOn(midi, freq, when, velocity = 1) {
        const id = nextId++;
        send({ type: 'noteOn', id, midi, velocity, time: when });
        return {
          oscillators: 1,
          start: when,
          /**
           * A drum ignores being let go.
           *
           * Every voice is a one-shot: it rings for as long as its own decay says, and how long the
           * note was drawn on the roll has nothing to do with it. What comes back is when it will
           * actually have finished, so the exporter still knows how much tail to leave — answering
           * with the note's end would cut the crash off at the end of the bar.
           */
          release(at) {
            return Math.max(at, when + 0.02);
          },
          earliestEnd: () => when,
        };
      },
      commit() {
        if (module.ready) build();
      },
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
