// The fourth instrument, and the first whose defining control is not a filter.
//
// Everything before this makes a waveform and then takes things away from it: a saw into a lowpass
// is the whole subtractive idea, and both the node-graph instruments and the ladder are versions of
// it. FM builds its spectrum instead of carving it, but only along one axis - more index, more
// sidebands. A wavetable is the first one here where the *waveform itself* is a continuous
// parameter, and where sweeping it changes which harmonics exist rather than how loud the existing
// ones are.
//
// That distinction is audible and it is also the reason this is worth the machinery. A filter sweep
// and a position sweep sound different because they are different: the filter removes what the
// oscillator made, and the position changes what it makes. The Sweep view shows this plainly -
// modulate the cutoff and the spectrogram's upper edge moves while the harmonics stay put;
// modulate the position and individual harmonics appear and disappear where they are.
//
// It shares its filter, its envelopes and its measurement overlay with the ladder, and its tables
// with the scope and the panel display. What is its own is the oscillator, which is in
// worklets/wavetable-processor.js, and the tables themselves, which are in wavetable.js.

import { choiceParam, defineInstrument, harmonicSeries, levelParam, numberParam } from '../instruments.js';
import { DEFAULT_TABLE, frameShape, getTable, tableChoices, tableHelp } from '../wavetable.js';
import { cutoffTrajectory, steadyFilterState } from './filter-envelope.js';
import { MAX_UNISON, unisonOffsets } from './worklets/voice-dsp.js';
import { loadWorklet } from '../worklet-loader.js';
import { ms, pct } from '../format.js';

const PROCESSOR_URL = new URL('./worklets/wavetable-processor.js', import.meta.url);
const PROCESSOR_NAME = 'wavetable';


export const WAVETABLE_PARAMS = [
  choiceParam({
    key: 'table',
    label: 'Table',
    def: DEFAULT_TABLE,
    choices: tableChoices(),
    help: 'Which set of sixteen waveforms the position morphs through.',
  }),
  numberParam({
    key: 'position',
    label: 'Position',
    min: 0,
    max: 1,
    def: 0.35,
    step: 0.001,
    mod: 'amount',
    help: 'Where in the table the oscillator sits. This is the knob the whole instrument is for — route an envelope or an LFO to it and the harmonics move rather than being filtered.',
    format: pct,
  }),
  numberParam({
    key: 'unison',
    label: 'Unison',
    min: 1,
    max: MAX_UNISON,
    def: 1,
    step: 1,
    help: 'Detuned copies of the oscillator, spread either side of the note. Costs one oscillator each — the load meter counts them.',
    format: (v) => (v <= 1 ? 'off' : `${Math.round(v)} voices`),
  }),
  numberParam({
    key: 'detune',
    label: 'Spread',
    min: 0,
    max: 50,
    def: 12,
    step: 0.5,
    help: 'How far apart the unison copies sit, in cents. Does nothing at unison 1.',
    format: (v) => `${v.toFixed(1)}¢`,
  }),
  numberParam({
    key: 'cutoff',
    label: 'Filter cutoff',
    min: 20,
    max: 18000,
    scale: 'log',
    def: 3000,
    mod: 'octaves',
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
  }),
  numberParam({ key: 'resonance', label: 'Resonance', min: 0, max: 1, def: 0.3, step: 0.01, mod: 'amount', format: pct }),
  // The same ladder as the bass, with a range that goes an octave and a half lower, because on this
  // instrument the drive knob is also the cleanliness knob.
  //
  // The ladder saturates with a tanh in its feedback path, and a nonlinearity folds whatever it
  // creates back down - so above a certain drive the filter, not the oscillator, is what limits how
  // clean the note is. Measured at C7: drive 2 gives -34dBc, drive 0.5 gives -50, drive 0.1 gives
  // -77, and only below about 0.05 does the oscillator's own -104 show through. The ladder's range
  // starts at 0.5, which was fine when it fed a PolyBLEP oscillator that was dirtier than that
  // anyway; here it would have hidden the entire point of the instrument behind a floor nobody
  // could turn off.
  numberParam({
    key: 'drive',
    label: 'Drive',
    min: 0.1,
    max: 8,
    def: 0.4,
    step: 0.05,
    mod: 'units',
    help: 'How hard the signal is pushed into the saturating part of the filter — which here is also how clean the note is. At 0.1 the oscillator measures −77dBc at C7; at 2 the filter alone puts it at −34.',
    format: (v) => `${v.toFixed(2)}×`,
  }),
  numberParam({
    key: 'filterEnvAmount',
    label: 'Filter sweep',
    min: -4,
    max: 5,
    def: 1.2,
    step: 0.05,
    format: (v) => (v === 0 ? 'off' : `${v > 0 ? '+' : ''}${v.toFixed(2)} oct`),
  }),
  numberParam({ key: 'filterAttack', label: 'Sweep attack', min: 0, max: 2, def: 0.004, step: 0.001, format: ms }),
  numberParam({ key: 'filterDecay', label: 'Sweep decay', min: 0.001, max: 4, def: 0.4, step: 0.01, format: ms }),
  numberParam({ key: 'filterSustain', label: 'Sweep sustain', min: 0, max: 1, def: 0.3, step: 0.01, format: pct }),
  numberParam({ key: 'attack', label: 'Attack', min: 0.001, max: 2, def: 0.004, step: 0.001, format: ms }),
  numberParam({ key: 'decay', label: 'Decay', min: 0.001, max: 4, def: 0.3, step: 0.01, format: ms }),
  numberParam({ key: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.8, step: 0.01, format: pct }),
  numberParam({ key: 'release', label: 'Release', min: 0.005, max: 4, def: 0.3, step: 0.005, format: ms }),
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
 * Every instrument here has one now. Before they were measured they were five unrelated fudge
 * factors, each nudged until that instrument sounded reasonable on its own, and they were 27dB
 * apart: at Level 100% one note peaked at -23.9dBFS here against +3.3dBFS on the subtractive synth and -23.9dBFS on the wavetable at the extremes. So the same
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
const OUTPUT_TRIM = 15.7462;


const PRESETS = [
  // The one that shows what the instrument is: an envelope on the position, so the note *becomes*
  // brighter rather than being un-filtered into brightness. The filter is nearly out of the way.
  {
    name: 'Morph',
    state: {
      table: 'basic', position: 0.1, cutoff: 12000, resonance: 0.15, drive: 0.15, filterEnvAmount: 0,
      attack: 0.01, decay: 0.6, sustain: 0.7, release: 0.4,
      env2Attack: 0.35, env2Decay: 0.9, env2Sustain: 0.25, env2Release: 0.5,
      mod: [{ source: 'env2', target: 'position', depth: 0.75 }],
    },
  },
  {
    name: 'Supersaw',
    state: {
      table: 'basic', position: 1, unison: 7, detune: 22, cutoff: 9000, resonance: 0.2, drive: 0.6,
      filterEnvAmount: 0.8, filterDecay: 0.7, filterSustain: 0.5,
      attack: 0.012, decay: 0.5, sustain: 0.85, release: 0.45, gain: 0.7,
    },
  },
  // Pulse-width modulation, which is what this table is for and what a naive oscillator cannot do
  // cleanly - the two-ramp version aliases from exactly the edges the width is moving.
  {
    name: 'PWM',
    state: {
      table: 'pulse', position: 0.15, unison: 3, detune: 8, cutoff: 6000, resonance: 0.25, drive: 0.5,
      filterEnvAmount: 0.6, filterDecay: 0.4, filterSustain: 0.5,
      attack: 0.008, decay: 0.4, sustain: 0.8, release: 0.35,
      lfo1Rate: 0.45, lfo1Shape: 'triangle',
      mod: [{ source: 'lfo1', target: 'position', depth: 0.4 }],
    },
  },
  {
    name: 'Vowel',
    state: {
      table: 'formant', position: 0.3, cutoff: 14000, resonance: 0.1, drive: 0.12, filterEnvAmount: 0,
      attack: 0.05, decay: 0.4, sustain: 0.9, release: 0.5,
      lfo1Rate: 0.7, lfo1Shape: 'sine',
      mod: [{ source: 'lfo1', target: 'position', depth: 0.3 }],
    },
  },
  {
    name: 'Hollow',
    state: {
      table: 'comb', position: 0.55, unison: 3, detune: 15, cutoff: 7000, resonance: 0.35, drive: 2.2,
      filterEnvAmount: 1.4, filterDecay: 0.5, filterSustain: 0.3,
      attack: 0.006, decay: 0.35, sustain: 0.7, release: 0.3,
    },
  },
];

const ensureModule = (ctx) => loadWorklet(ctx, PROCESSOR_URL);

export default defineInstrument({
  id: 'wavetable',
  // Declared as well as applied, because the loader has to be able to undo it for a song written
  // before the levels were calibrated - see storage.js.
  outputTrim: OUTPUT_TRIM,
  name: 'Wavetable',
  params: WAVETABLE_PARAMS,
  presets: PRESETS,
  badge: () => 'WT',
  tailSeconds: (state) => state.release,
  prepare: (ctx) => ensureModule(ctx).promise,

  /**
   * The waveform, drawn where the knob that changes it is.
   *
   * The scope answers "what is in this sound"; this answers "what shape is the oscillator making",
   * and they are genuinely different questions - a spectrum cannot show you that the pulse has gone
   * narrow, only that its harmonics have flattened. It also closes a gap that is specific to this
   * instrument: `position` is a number between 0 and 1 with no natural meaning, so without a picture
   * the only way to know what 0.35 sounds like is to play it.
   *
   * Declared by the instrument rather than built into the panel, so the panel needs to know nothing
   * about wavetables - it hosts a canvas for any instrument that asks for one, which is the same
   * bargain as `params` and `measurement`.
   */
  display: {
    label: 'Waveform',
    height: 108,
    // What this particular table is, in a sentence. Per-table rather than per-instrument because
    // the tables are the part a person has to choose between and cannot hear until they do.
    caption: (state) => tableHelp(state.table ?? DEFAULT_TABLE),
    draw(ctx2d, state, { width, height, colors }) {
      const COUNT = 256;
      const pad = 8;
      const trackH = 6;
      const w = width - pad * 2;
      const h = height - pad * 2 - trackH - 4;
      const midY = pad + h / 2;
      const amp = h / 2 - 1;
      const table = state.table ?? DEFAULT_TABLE;
      const position = Math.max(0, Math.min(1, state.position ?? 0));

      const trace = (pos, style, lineWidth) => {
        const shape = frameShape(table, pos, COUNT);
        ctx2d.beginPath();
        for (let i = 0; i <= COUNT; i++) {
          const x = pad + (i / COUNT) * w;
          const y = midY - shape[i % COUNT] * amp;
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.strokeStyle = style;
        ctx2d.lineWidth = lineWidth;
        ctx2d.stroke();
      };

      ctx2d.clearRect(0, 0, width, height);

      ctx2d.strokeStyle = colors.grid;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(pad, midY);
      ctx2d.lineTo(pad + w, midY);
      ctx2d.stroke();

      // The ends and the middle of the table, faintly, so the current shape is read against the
      // range it came from rather than in isolation.
      for (const p of [0, 0.5, 1]) if (Math.abs(p - position) > 0.02) trace(p, colors.ghost, 1);
      trace(position, colors.accent, 2);

      // Where in the table this is, as a track rather than a number - the readout beside the knob
      // already says 35%, and what that does not say is 35% of the way between what and what.
      const trackY = height - pad - trackH;
      ctx2d.fillStyle = colors.grid;
      ctx2d.fillRect(pad, trackY + trackH / 2 - 1, w, 2);
      ctx2d.fillStyle = colors.accent;
      ctx2d.beginPath();
      ctx2d.arc(pad + position * w, trackY + trackH / 2, 3.5, 0, Math.PI * 2);
      ctx2d.fill();
    },
  },

  measurement: {
    steadyState: (state) => steadyFilterState(state),
    /**
     * Every frequency the patch asked for - which for this instrument is not one harmonic series
     * but `unison` of them, each at its own detuned fundamental.
     *
     * This is the case the hook was generalised for. A detuned copy's harmonics sit at multiples of
     * *its* frequency, not of the note's, so an analyser told only the note would report every
     * partial of every copy but the centre one as an unasked-for artefact - and a seven-voice
     * unison would measure as the dirtiest instrument ever built.
     */
    partials: (state, f0, nyquist) => {
      const base = f0 * 2 ** ((state.tune ?? 0) / 12);
      const offsets = unisonOffsets(state.unison ?? 1);
      const out = [];
      for (let i = 0; i < offsets.length; i++) {
        const f = base * 2 ** ((offsets[i] * (state.detune ?? 0)) / 1200);
        out.push(...harmonicSeries(f, nyquist));
      }
      return out;
    },
    trajectory: cutoffTrajectory,
  },

  create(ctx, destination) {
    let node = null;
    let state = {};
    let nextId = 1;
    let load = null;
    // Which table the processor has been given. The samples are a quarter of a megabyte, so they
    // are sent when they change rather than with every parameter message - a position drag would
    // otherwise post the whole pyramid across the thread boundary sixty times a second.
    let sentTable = null;

    const queued = [];
    const send = (message) => {
      if (node) node.port.postMessage(message);
      else queued.push(message);
    };

    function build() {
      if (node) return;
      const table = getTable(state.table ?? DEFAULT_TABLE);
      sentTable = table.id;
      node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        // The table travels here for the same reason the note schedule does: an offline render
        // finishes before a port message has been serviced, so anything that must be true before
        // the first sample cannot go by port. A processor that started without its table would
        // render silence, and the scope would report a flawless synth - which has happened here
        // once already, for exactly this reason.
        processorOptions: { state, levels: table.levels, events: queued },
      });
      node.port.onmessage = (event) => {
        if (event.data?.type === 'load') load = event.data;
      };
      node.connect(destination);
      queued.length = 0;
    }

    const module = ensureModule(ctx);
    if (module.ready) queueMicrotask(build);
    else {
      module.promise.then(build).catch(() => {
        queued.length = 0;
      });
    }

    return {
      setState(next) {
        // The trim rides along with the state rather than being applied in the processor, so the
        // audio thread never has to know it exists and the number lives in one file.
        state = { ...next, gain: (next.gain ?? 1) * OUTPUT_TRIM };
        if (!node) return;
        const wanted = state.table ?? DEFAULT_TABLE;
        if (wanted !== sentTable) {
          const table = getTable(wanted);
          sentTable = table.id;
          node.port.postMessage({ type: 'params', state, levels: table.levels });
        } else {
          node.port.postMessage({ type: 'params', state });
        }
      },
      noteOn(midi, freq, when, velocity = 1, glide = null) {
        const id = nextId++;
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
          // What this note costs, which for a wavetable is its unison count rather than one. The
          // meter is asking about oscillators, and turning unison to seven really is seven of them.
          oscillators: Math.max(1, Math.round(state.unison ?? 1)),
          start: when,
          release(at) {
            if (released) return at;
            released = true;
            send({ type: 'noteOff', id, time: at });
            return at + (state.release ?? 0.3);
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
