// The record you are transcribing.
//
// One imported file, held for the session, doing two things at once: it is drawn *behind* the notes
// as a spectrogram folded onto the roll's own pitch axis, and it is played *with* them so you can
// hear whether what you wrote is what is there. Those are the same object seen twice, which is why
// they are one module - the alignment that puts a transient under a bar line is the same number that
// decides where in the file the monitor starts, and two copies of it would disagree within a minute.
//
// A singleton, like tempo.js and grid.js and for the same reason: there is one recording, the roll
// draws it, the panel edits it, and nothing would be gained by making either of them own it.
//
// **Nothing here is saved.** A song document is a few kilobytes of notes; a decoded four-minute
// recording is forty megabytes of float, and putting one in localStorage would break saving for
// every song rather than just this one. So an import lasts as long as the tab, and the panel says
// so. The settings would be cheap to keep and are deliberately not kept either - they are worth
// nothing without the file they were tuned against.

import { ensureContext, peekContext } from './audio.js';
import { MIDI_HIGH, MIDI_LOW } from './song.js';
import {
  beatsForSeconds,
  midiToFreq,
  noteName,
  octaveFromMidi,
  pcFromMidi,
  secondsForBeats,
} from './music-theory.js';
import { getBpm } from './tempo.js';
import { choiceParam, numberParam } from './params.js';
import { RAMPS, createAnalyser, paintSpectrum } from './spectrum.js';
import { createBeatDetector } from './beat-detect.js';
import { dbLabel, gainToDb } from './decibels.js';
import { createListeners } from './observable.js';

// How long the monitor takes to arrive and to leave at a seam. Long enough that a buffer restarted
// at a loop point does not click, short enough that the first transient of the bar is still a
// transient rather than a swell.
const SEAM_FADE_S = 0.006;

// How many second-order sections the band filter can stack. Four of each is 48dB an octave, which is
// steep enough to hear a bassline out from under a chord and about where a Butterworth's ringing
// starts being audible on transients.
const MAX_STAGES = 4;

const noteLabel = (midi) => noteName(octaveFromMidi(midi), pcFromMidi(midi));

/**
 * The controls, declared the way every other knob in the program is declared.
 *
 * Grouped by the question they answer rather than by what they happen to affect, because that is how
 * they are used: you set the picture up once, you tune the transform when the picture is not showing
 * you what you need, and you reach for the band every few minutes while actually transcribing.
 *
 * `affects` is how a change knows what it costs. Only five of these send the audio back through the
 * FFT; the rest are a repaint of a grid that is already in memory, or nothing at all but a redraw -
 * which is what makes dragging the floor around feel like a display control instead of a rebuild.
 */
export const REFERENCE_PARAMS = {
  layer: [
    choiceParam({
      key: 'show',
      label: 'Overlay',
      def: 'on',
      help: 'Whether the spectrum is drawn at all. It is a layer under the notes, so this is the difference between transcribing onto a picture and transcribing onto an empty roll.',
      choices: [
        { value: 'on', label: 'Show' },
        { value: 'off', label: 'Hide' },
      ],
    }),
    numberParam({
      key: 'opacity',
      label: 'Opacity',
      min: 0.1,
      max: 1,
      step: 0.05,
      def: 0.75,
      format: (v) => `${Math.round(v * 100)}%`,
      help: 'How strongly the picture sits over the grid. Down near a third it is a hint under the notes; at full it is the thing you are reading.',
    }),
    choiceParam({
      key: 'ramp',
      label: 'Colour',
      def: 'ice',
      help: 'All five run dark to light, so brighter is always louder. Viridis and Magma are the matplotlib maps — even steps in brightness the whole way up, and readable without separating red from green.',
      choices: RAMPS.map((ramp) => ({ value: ramp.id, label: ramp.label })),
    }),
    numberParam({
      key: 'floorDb',
      label: 'Floor',
      min: -110,
      max: -12,
      step: 1,
      def: -62,
      format: (v) => `${v} dB`,
      help: 'How far below the loudest moment of the file the picture reaches. Raise it until the room tone and the reverb tail disappear and only the notes are left - this is the single most useful control here.',
    }),
    numberParam({
      key: 'gainDb',
      label: 'Gain',
      min: -12,
      max: 48,
      step: 1,
      def: 0,
      format: (v) => `${v > 0 ? '+' : ''}${v} dB`,
      help: 'Brightens everything at once, floor included. For a quiet passage inside a loud record, where lowering the floor would only bring up more of the noise underneath it.',
    }),
  ],
  analysis: [
    choiceParam({
      key: 'fftSize',
      label: 'FFT size',
      def: 8192,
      help: 'The classic trade, and the reason this is a knob rather than a constant. A big window separates two close notes and smears the moment they started; a small one puts the onsets exactly where they are and cannot tell a bass note from the one a semitone above it.',
      choices: [1024, 2048, 4096, 8192, 16384, 32768].map((value) => ({
        value,
        label: String(value),
      })),
    }),
    choiceParam({
      key: 'overlap',
      label: 'Overlap',
      def: 4,
      help: 'How many frames a window is worth. More overlap moves the picture forward in smaller steps without narrowing the window, which is the only way to get a sharp-looking onset out of a long FFT.',
      choices: [
        { value: 2, label: '2x' },
        { value: 4, label: '4x' },
        { value: 8, label: '8x' },
        { value: 16, label: '16x' },
      ],
    }),
    choiceParam({
      key: 'windowKind',
      label: 'Window',
      def: 'hann',
      help: 'What the frame is faded in and out with. Hann is the default for a reason; Blackman-Harris hides a quiet note next to a loud one much less, at the cost of a wider blur around every partial.',
      choices: [
        { value: 'hann', label: 'Hann' },
        { value: 'hamming', label: 'Hamming' },
        { value: 'blackman-harris', label: 'Blackman' },
      ],
    }),
    choiceParam({
      key: 'binsPerSemitone',
      label: 'Rows / note',
      def: 3,
      help: 'How finely each semitone of the roll is divided. Three is enough to see that a vocal is sliding into the note rather than sitting on it; one is enough to see which note it is.',
      choices: [1, 2, 3, 5].map((value) => ({ value, label: `${value}` })),
    }),
    choiceParam({
      key: 'channel',
      label: 'Channel',
      def: 'mix',
      help: 'What gets analysed and monitored. Side is left minus right, which cancels anything panned dead centre - on most records that is the lead vocal, the kick and the snare, and what is left is very often the part you are trying to hear.',
      choices: [
        { value: 'mix', label: 'Mix' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        { value: 'side', label: 'Side (L−R)' },
      ],
    }),
  ],
  isolate: [
    numberParam({
      key: 'bandLow',
      label: 'From',
      min: MIDI_LOW,
      max: MIDI_HIGH,
      step: 1,
      def: MIDI_LOW,
      format: noteLabel,
      help: 'The bottom of the range you are working on. Everything below it is dropped from the picture, and from the monitor when Filter is on.',
    }),
    numberParam({
      key: 'bandHigh',
      label: 'To',
      min: MIDI_LOW,
      max: MIDI_HIGH,
      step: 1,
      def: MIDI_HIGH,
      format: noteLabel,
      help: 'The top of it. The band is named in notes because the axis it is drawn against is notes.',
    }),
    choiceParam({
      key: 'filterAudio',
      label: 'Filter',
      def: 'off',
      help: 'Whether the monitor is band-limited to the same range the picture is. On, you hear exactly the slice you are looking at, which is what makes a bassline under a full mix transcribable.',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ],
    }),
    choiceParam({
      key: 'filterOrder',
      label: 'Slope',
      def: 2,
      activeWhen: (state) => state.filterAudio === 'on',
      help: 'How hard the band edges fall away. Steeper isolates better and rings more on transients.',
      choices: [1, 2, 3, 4].map((value) => ({ value, label: `${value * 12} dB/oct` })),
    }),
    numberParam({
      key: 'monitor',
      label: 'Monitor',
      min: 0,
      max: 1.5,
      def: 0.5,
      scale: 'db',
      format: (v) => (v > 0 ? dbLabel(gainToDb(v)) : 'silent'),
      help: 'How loud the record is against what you have written. It goes straight to the speakers rather than through the mix bus, so it is never in an export and never triggers the limiter over your own parts.',
    }),
  ],
};

const ALL_PARAMS = [...REFERENCE_PARAMS.layer, ...REFERENCE_PARAMS.analysis, ...REFERENCE_PARAMS.isolate];

// Which changes cost an FFT. Everything else is a repaint of bytes that are already here.
const RE_ANALYSE = new Set(['fftSize', 'overlap', 'windowKind', 'binsPerSemitone', 'channel']);
const REPAINT = new Set(['ramp', 'floorDb', 'gainDb', 'bandLow', 'bandHigh']);

const state = {};
for (const param of ALL_PARAMS) state[param.key] = param.def;

// Where in the file song beat zero falls, in seconds. Held in seconds rather than in beats because
// seconds are what the recording has: change the tempo and a beat moves, but the downbeat of the
// record does not, so an offset measured in beats would slide out of alignment every time you
// corrected the BPM - which is exactly the moment you are least able to notice.
let anchorSeconds = 0;

let buffer = null;
let fileName = '';
let analysis = null;
let status = { state: 'empty', text: '', progress: 0 };

const { subscribe: subscribeReference, emit: notify } = createListeners();
export { subscribeReference };
const analyser = createAnalyser();
const detector = createBeatDetector();
let tempo = { state: 'idle', progress: 0, candidates: [], text: '' };
const image = document.createElement('canvas');
let painted = false;

export const getReferenceState = () => ({ ...state });
export const getReferenceParam = (key) => state[key];
export const getReferenceStatus = () => ({ ...status });
export const hasReference = () => buffer !== null;
export const referenceName = () => fileName;
export const referenceBuffer = () => buffer;
export const referenceAnalysis = () => analysis;
export const getAnchorSeconds = () => anchorSeconds;
export const getTempoDetection = () => ({ ...tempo, candidates: tempo.candidates.slice() });

/** The picture, ready to be blitted, or null while there is nothing to draw. */
export function referenceImage() {
  if (!analysis || !painted || state.show !== 'on') return null;
  return {
    canvas: image,
    columns: analysis.frames,
    rows: analysis.rows,
    opacity: state.opacity,
  };
}

// --- where the file sits against the song ------------------------------------------------------

/** The moment in the file that sounds at song beat `beat`. Negative is before the file starts. */
export function audioTimeForBeat(beat) {
  return anchorSeconds + secondsForBeats(beat, getBpm());
}

/** And the beat a moment in the file lands on. */
export function beatForAudioTime(seconds) {
  return beatsForSeconds(seconds - anchorSeconds, getBpm());
}

/** Column `x` of the picture, fractional, at song beat `beat`. Linear, which is the whole point. */
export function columnForBeat(beat) {
  if (!analysis) return 0;
  return (audioTimeForBeat(beat) - analysis.t0) / analysis.dt;
}

export function beatForColumn(column) {
  if (!analysis) return 0;
  return beatForAudioTime(analysis.t0 + column * analysis.dt);
}

/**
 * Where the recording stops, in song beats. Zero when there is nothing imported.
 *
 * This is the length the *session* has that the song does not. A song's end is its last note, and
 * for a transcription that is wrong from the first bar onwards: you have written eight bars against
 * a four-minute record, and if playback stops - or loops - at the end of what you have written, the
 * other three minutes and fifty seconds are unreachable. So the transport, the roll's width and the
 * End key all take the later of the two, and this is the half of it that only this module knows.
 *
 * It moves with the tempo, which is right and worth being clear about: a recording is a fixed
 * number of *seconds*, so at half the tempo it covers half as many bars. The anchor moves it too -
 * skipping into the file with a positive anchor makes it end earlier in song time.
 *
 * Loaded is what counts, not shown. Hiding the overlay leaves the recording playing, so a hidden
 * reference that still sounds must still say how long the song is.
 */
export function referenceEndBeat() {
  if (!buffer) return 0;
  return Math.max(0, beatForAudioTime(buffer.duration));
}

export function setAnchorSeconds(value) {
  const next = Number(value);
  if (!Number.isFinite(next) || next === anchorSeconds) return;
  anchorSeconds = next;
  // The monitor is mid-buffer at an offset that was correct a moment ago. Dropping it and letting
  // the transport's next window re-arm it is a gap of at most one scheduler tick, and it is a great
  // deal simpler than working out where the playhead is from outside the transport.
  retireSource(now());
  lastToBeat = null;
  notify('view');
}

export function setReferenceParam(key, value) {
  if (!(key in state) || state[key] === value) return;
  state[key] = value;
  if (key === 'monitor' || key === 'channel' || key.startsWith('filter') || key === 'bandLow' || key === 'bandHigh') {
    applyMonitor();
  }
  if (RE_ANALYSE.has(key)) {
    startAnalysis();
    return;
  }
  if (REPAINT.has(key)) repaint();
  notify('view');
}

// --- loading -----------------------------------------------------------------------------------

/**
 * Decode a dropped or chosen file.
 *
 * `decodeAudioData` is the browser's own decoder, which is why the answer to "wav or mp3" is "both,
 * and whatever else it knows" - m4a and flac usually, ogg often. Nothing here ships a codec or
 * touches a format it has to understand; the file goes to the same decoder a `<audio>` tag uses and
 * comes back as samples. Anything it declines is reported as declined rather than guessed at.
 */
export async function loadReferenceFile(file) {
  if (!file) return;
  status = { state: 'decoding', text: `Decoding ${file.name}…`, progress: 0 };
  fileName = file.name;
  notify('status');
  try {
    const ctx = ensureContext();
    const bytes = await file.arrayBuffer();
    buffer = await ctx.decodeAudioData(bytes);
  } catch (error) {
    buffer = null;
    analysis = null;
    painted = false;
    status = { state: 'error', text: `Could not decode ${file.name} — the browser does not read this format.`, progress: 0 };
    notify('source');
    return;
  }
  analysis = null;
  painted = false;
  // A new file's tempo is not the old file's tempo, and leaving the old candidates on screen beside a
  // new name is the kind of thing you only notice after acting on it.
  detector.cancel();
  tempo = { state: 'idle', progress: 0, candidates: [], text: '' };
  notify('source');
  startAnalysis();
}

export function clearReference() {
  analyser.cancel();
  detector.cancel();
  tempo = { state: 'idle', progress: 0, candidates: [], text: '' };
  retireSource(now());
  lastToBeat = null;
  buffer = null;
  analysis = null;
  painted = false;
  fileName = '';
  status = { state: 'empty', text: '', progress: 0 };
  notify('source');
}

/**
 * The one channel the transform sees, mixed the way the Channel control asks.
 *
 * A mono file is treated as two identical channels rather than as a special case, which makes Mix
 * and Left and Right all give the same thing back and Side give silence - all three of which are
 * the truth about a mono file, and none of which needs a branch to say so.
 */
function mixedChannel(mode = state.channel) {
  const length = buffer.length;
  const out = new Float32Array(length);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  if (mode === 'left') out.set(left);
  else if (mode === 'right') out.set(right);
  else if (mode === 'side') {
    for (let i = 0; i < length; i++) out[i] = 0.5 * (left[i] - right[i]);
  } else if (buffer.numberOfChannels > 2) {
    // Anything past stereo is averaged whole, so a surround stem is analysed rather than half-read.
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) out[i] += data[i] / buffer.numberOfChannels;
    }
  } else {
    for (let i = 0; i < length; i++) out[i] = 0.5 * (left[i] + right[i]);
  }
  return out;
}

function startAnalysis() {
  if (!buffer) return;
  status = { state: 'analysing', text: 'Analysing…', progress: 0 };
  notify('status');
  analyser.run(
    {
      channel: mixedChannel(),
      sampleRate: buffer.sampleRate,
      fftSize: state.fftSize,
      overlap: state.overlap,
      windowKind: state.windowKind,
      binsPerSemitone: state.binsPerSemitone,
      midiLow: MIDI_LOW,
      midiHigh: MIDI_HIGH,
    },
    {
      onProgress: (fraction) => {
        status = { state: 'analysing', text: 'Analysing…', progress: fraction };
        notify('status');
      },
      onDone: (result) => {
        analysis = result;
        repaint();
        status = { state: 'ready', text: '', progress: 1 };
        notify('analysis');
      },
      onError: (error) => {
        status = { state: 'error', text: `Analysis failed: ${error.message}`, progress: 0 };
        notify('status');
      },
    },
  );
}

/**
 * Ask the recording what tempo it is.
 *
 * On a button rather than on import, and deliberately. Changing the tempo moves every bar line under
 * whatever you have already written, which is not something to do to somebody while they are looking
 * at the file name to check it loaded. It also comes back with a *list* - the octave ambiguity between
 * 87 and 174 is real and no amount of prior fixes it - so there is something to choose from rather
 * than a number that has already been applied.
 */
export function detectTempo() {
  if (!buffer) return;
  tempo = { state: 'running', progress: 0, candidates: [], text: 'Listening for the beat…' };
  notify('tempo');
  detector.run(
    { channel: mixedChannel('mix'), sampleRate: buffer.sampleRate },
    {
      onProgress: (fraction) => {
        tempo = { ...tempo, progress: fraction };
        notify('tempo');
      },
      onDone: (result) => {
        const candidates = (result.candidates ?? []).filter(
          (candidate) => candidate.bpm >= 20 && candidate.bpm <= 300 && Number.isFinite(candidate.anchor),
        );
        tempo = {
          state: 'done',
          progress: 1,
          candidates,
          text: candidates.length
            ? ''
            : result.tooShort
              ? 'Too short to find a pulse in.'
              : 'No steady pulse found.',
        };
        notify('tempo');
      },
      onError: (error) => {
        tempo = { state: 'error', progress: 0, candidates: [], text: `Detection failed: ${error.message}` };
        notify('tempo');
      },
    },
  );
}

/**
 * Take one of the offered tempos: the number, and where its first beat lands.
 *
 * Rounded to the two decimals the chip shows, so that the box and the button you pressed say the
 * same thing - a box reading 128.00082438063146 beside a button reading 128.00 looks like a fault.
 * What that rounding costs is at most 0.005 BPM, which across a four-minute song is a fiftieth of a
 * beat: far below the tolerance that made the long-baseline fit necessary in the first place.
 */
export function applyTempoCandidate(candidate, setBpm) {
  if (!candidate) return;
  setBpm(Math.round(candidate.bpm * 100) / 100);
  setAnchorSeconds(candidate.anchor);
}

function repaint() {
  if (!analysis) {
    painted = false;
    return;
  }
  paintSpectrumInto();
  painted = true;
}

function paintSpectrumInto() {
  paintSpectrum(image, analysis, {
    floorDb: state.floorDb,
    gainDb: state.gainDb,
    ramp: state.ramp,
    bandLow: state.bandLow,
    bandHigh: state.bandHigh,
    midiLow: MIDI_LOW,
    midiHigh: MIDI_HIGH,
  });
}

// --- the monitor -------------------------------------------------------------------------------
//
// Straight to the speakers, deliberately not through the mix bus. The bus is what a song *is* - it
// has the master chain on it, it feeds the limiter, and it is what an export renders. A reference
// recording is none of those things: it is louder than anything you have written yet, so through
// the bus it would duck your own parts every time the limiter caught it, and it would land in any
// file you exported. What it costs to keep it out is that the master fader does not move it, which
// is why it has a level control of its own.

let graph = null;
let source = null;
let sourceGain = null;
let lastToBeat = null;
let lastEndTime = 0;

const now = () => peekContext()?.currentTime ?? 0;

/**
 * The fixed monitor graph: a channel matrix, then eight biquads, then a level.
 *
 * Eight, always, whatever the slope is set to. A stage that is not wanted becomes an **allpass** at
 * 20Hz rather than being unplugged, which is flat to within nothing across the audible range and
 * means the graph is built once and never rewired. Rewiring it is what would click, and it would
 * click exactly when you reached for the filter in the middle of a passage you were listening to.
 */
function ensureGraph() {
  if (graph) return graph;
  const ctx = ensureContext();
  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createGain();
  const right = ctx.createGain();
  const sum = ctx.createGain();
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  left.connect(sum);
  right.connect(sum);

  const stages = [];
  let tail = sum;
  for (let i = 0; i < MAX_STAGES * 2; i++) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = 'allpass';
    biquad.frequency.value = 20;
    tail.connect(biquad);
    tail = biquad;
    stages.push(biquad);
  }

  const level = ctx.createGain();
  level.gain.value = state.monitor;
  tail.connect(level);
  level.connect(ctx.destination);

  graph = { ctx, splitter, left, right, stages, level };
  applyMonitor();
  return graph;
}

/**
 * Butterworth section Qs for a cascade of `count` second-order sections.
 *
 * Not 0.707 in every stage, which is the obvious way to build a steeper filter and is wrong: four
 * identical sections are 3dB down *each* at the corner, so the band you asked for arrives 12dB
 * quieter than the band you got. These are the real pole Qs for an order-2N Butterworth, so the
 * passband stays flat however many sections are in use and only the skirt changes.
 */
function butterworthQ(index, count) {
  return 1 / (2 * Math.cos(((2 * index + 1) * Math.PI) / (4 * count)));
}

function applyMonitor() {
  if (!graph) return;
  const { ctx, left, right, stages, level } = graph;
  const at = ctx.currentTime;

  const stereo = (buffer?.numberOfChannels ?? 2) > 1;
  const matrix = {
    mix: stereo ? [0.5, 0.5] : [1, 0],
    left: [1, 0],
    right: stereo ? [0, 1] : [1, 0],
    side: stereo ? [0.5, -0.5] : [0, 0],
  }[state.channel] ?? [0.5, 0.5];
  left.gain.setTargetAtTime(matrix[0], at, 0.01);
  right.gain.setTargetAtTime(matrix[1], at, 0.01);

  const on = state.filterAudio === 'on';
  const count = state.filterOrder;
  const nyquist = ctx.sampleRate * 0.49;
  // The outer edges of the two notes, so both of the notes you named are inside the passband rather
  // than sitting on the corner and arriving 3dB down.
  const lowHz = Math.min(nyquist, Math.max(10, midiToFreq(state.bandLow - 0.5)));
  const highHz = Math.min(nyquist, Math.max(lowHz * 1.02, midiToFreq(state.bandHigh + 0.5)));

  for (let i = 0; i < MAX_STAGES; i++) {
    const hp = stages[i];
    const lp = stages[MAX_STAGES + i];
    const live = on && i < count;
    hp.type = live ? 'highpass' : 'allpass';
    lp.type = live ? 'lowpass' : 'allpass';
    hp.frequency.setTargetAtTime(live ? lowHz : 20, at, 0.01);
    lp.frequency.setTargetAtTime(live ? highHz : 20, at, 0.01);
    const q = live ? butterworthQ(i, count) : Math.SQRT1_2;
    hp.Q.value = q;
    lp.Q.value = q;
  }

  level.gain.setTargetAtTime(state.monitor, at, 0.02);
}

function retireSource(atTime) {
  if (!source) return;
  const at = Math.max(atTime, now());
  sourceGain.gain.setValueAtTime(sourceGain.gain.value, at);
  sourceGain.gain.linearRampToValueAtTime(0, at + SEAM_FADE_S);
  try {
    source.stop(at + SEAM_FADE_S + 0.005);
  } catch {
    // Already stopped, which is only reachable if two seams land in the same tick.
  }
  source = null;
  sourceGain = null;
}

function armAt(beat, when) {
  const { ctx, splitter } = ensureGraph();
  let offset = audioTimeForBeat(beat);
  let at = when;
  // The song can begin before the recording does - a count-in, or an anchor pushed right to line a
  // late downbeat up. The buffer simply starts later; it does not start early and wait.
  if (offset < 0) {
    at -= offset;
    offset = 0;
  }
  if (offset >= buffer.duration) return;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(1, at + SEAM_FADE_S);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(gain);
  gain.connect(splitter);
  node.start(at, offset);
  source = node;
  sourceGain = gain;
}

/**
 * One window of song time, exactly as the transport committed it to the audio clock.
 *
 * The trick is that almost every window is a *continuation*: the scheduler hands over contiguous
 * slices twenty-five milliseconds apart, and a buffer that is already playing is already correct
 * for all of them. So the only thing worth detecting is a seam - a loop wrap, a start, a tempo
 * change that re-anchored the clock - which shows up as a window whose beat or whose audio time
 * does not continue the last one. Then and only then is the source dropped and restarted at the
 * right offset. A source per window would be forty restarts a second and would sound like it.
 */
export function commitReferenceWindow(window) {
  if (!buffer) return;
  if (!window) {
    retireSource(now());
    lastToBeat = null;
    return;
  }
  const continues =
    source !== null &&
    lastToBeat !== null &&
    Math.abs(window.fromBeat - lastToBeat) < 1e-9 &&
    Math.abs(window.startTime - lastEndTime) < 1e-6;
  if (!continues) {
    retireSource(window.startTime);
    armAt(window.fromBeat, window.startTime);
  }
  lastToBeat = window.toBeat;
  lastEndTime = window.endTime;
}
