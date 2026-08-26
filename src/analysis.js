// Looking at a voice instead of listening to it.
//
// This exists because of what is coming, not because of what is here. The plan is a worklet-based
// instrument written with a lot of machine help, and the failure mode of that plan is not code
// that crashes - it is code that runs, makes a sound, and is quietly wrong. An oscillator that
// aliases does not throw; it sounds "a bit bright". A filter that is wrong at high Q sounds like
// a filter. You cannot review your way to knowing a DSP change was correct, and neither can the
// thing that wrote it. You have to measure, which means there has to be something that measures.
//
// So: render a note into an OfflineAudioContext, take its spectrum, and say where the energy is.
// Everything at a multiple of the note's own frequency was asked for. Everything else was not,
// and the loudest of it is the number that matters - it is what "clean" and "dirty" actually mean
// for an oscillator, and it is invisible from the code.
//
// Nothing here touches the DOM or the live context, so it is safe to call while music is playing.

import { fft } from './fft.js';
import { midiToFreq } from './music-theory.js';
import { getInstrument, harmonicSeries } from './instruments.js';

const RENDER_SECONDS = 1.5;
// Where the note is held flat. Skipping the attack matters: an envelope is a multiplication in
// time, which is a smear in frequency, and a spectrum taken across the attack shows sidebands
// around every partial that have nothing to do with the oscillator being measured.
const WINDOW_START_S = 0.25;
const WINDOW_END_S = 1.25;

// Where the note is let go in the sweep view. Early enough that the release is on screen, since
// what a sweep does on the way out is as much a part of the sound as what it does on the way in.
const SWEEP_RELEASE_S = 1.0;

// Which parameters have to be held still for a measurement, and which frequencies the patch was
// actually asked to produce, are both things only the instrument knows - so it says.
//
// That second hook started life as "how many cents of unison detune", which was a question only a
// subtractive synth could answer, and the first instrument that was not one made it useless: FM
// sidebands sit at the carrier plus and minus whole multiples of the modulator, which is not a
// harmonic series and cannot be described by a detune. So the hook asks for the answer rather than
// for the ingredients, and an instrument that declines gets the plain harmonic series.
function measurementOf(definition) {
  return definition?.measurement ?? {};
}

// A partial sits in a range of bins rather than one, because it was windowed. Blackman-Harris
// spreads the main lobe over about eight and then trails a skirt either side, so anything this
// close to a partial we asked for is that partial rather than a discovery.
//
// Six bins was the first guess and it was wrong in the direction that matters: measuring a clean
// sawtooth reported its worst artefact seven bins off the fundamental, which is the window's own
// skirt being described as a fault in the synth. A tool that cries wolf at the noise floor gets
// ignored, and then it may as well not exist. The cost of widening it is a blind spot of about
// fifty Hz around each partial - real enough to note, and worth paying to keep the number honest.
const PARTIAL_BINS = 10;
// Below this there is nothing but the tail of the envelope's own step and the DC the filter
// leaves behind - neither is aliasing and both would win the "loudest thing" contest.
const MIN_HZ = 30;

/**
 * A Hann window, for the spectrogram.
 *
 * A different view wants a different window, and it is worth saying why rather than looking like
 * an inconsistency. The spectrum view is hunting things 90dB down, so it pays a wide main lobe for
 * Blackman-Harris's very low leakage. The spectrogram is not hunting anything - it is watching a
 * filter move - and what it needs is to resolve *when*, which means short frames, and a short
 * Blackman-Harris frame is nearly all main lobe and smears the frequency axis into porridge. Hann
 * leaks more and sees more sharply, which is the right trade here and the wrong one there.
 */
function hann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/**
 * A four-term Blackman-Harris window.
 *
 * The choice of window *is* the noise floor of this instrument. A Hann window leaks at about
 * -31dB into its neighbours, which would bury exactly the low-level rubbish we are here to find
 * under the skirt of the fundamental. Blackman-Harris leaks at about -92dB, at the cost of a
 * wider main lobe - it trades the ability to separate two close partials, which we do not need,
 * for the ability to see a quiet one, which is the entire point.
 */
function blackmanHarris(size) {
  const w = new Float32Array(size);
  const a = [0.35875, 0.48829, 0.14128, 0.01168];
  for (let i = 0; i < size; i++) {
    const t = (2 * Math.PI * i) / (size - 1);
    w[i] = a[0] - a[1] * Math.cos(t) + a[2] * Math.cos(2 * t) - a[3] * Math.cos(3 * t);
  }
  return w;
}

/**
 * The averaged magnitude spectrum of `samples`, in raw magnitude (not yet dB).
 *
 * Averaged over overlapping frames rather than taken once, because a single frame's noise floor
 * is itself noisy: a lone spike from one frame's worth of rounding looks exactly like a real
 * spurious partial. Averaging several frames leaves what is consistently there.
 */
function averagedSpectrum(samples, fftSize) {
  const window = blackmanHarris(fftSize);
  const bins = fftSize >> 1;
  const sum = new Float64Array(bins);
  const hop = fftSize >> 1;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  let frames = 0;
  for (let offset = 0; offset + fftSize <= samples.length; offset += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      sum[k] += Math.hypot(re[k], im[k]);
    }
    frames++;
  }

  if (frames === 0) return new Float32Array(bins);
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) out[k] = sum[k] / frames;
  return out;
}

/**
 * Report where the energy in `channel` landed, given the note it was supposed to be playing.
 *
 * Separate from analyseVoice because the audio will not always come from an instrument. The point
 * of building this now is the instruments that don't exist yet, and a worklet hands back samples
 * rather than a node graph - so the half of this that does the measuring takes audio from
 * wherever, and the half that knows how to build a voice is the caller's problem.
 *
 * Returns dB relative to the fundamental (dBc), which is the unit the question is asked in:
 * nobody wants to know how loud an artefact is, they want to know how far below the note it is.
 */
export function analyseBuffer({
  channel,
  sampleRate,
  f0,
  partials: askedFor,
  fftSize = 8192,
  from: fromSeconds = WINDOW_START_S,
  to: toSeconds = WINDOW_END_S,
}) {
  // The voice's own level, before the master gain and the limiter it would meet on the way out. So a
  // peak over unity here is not clipping - it is headroom spent, and whether it becomes clipping
  // depends on the mixer. Worth reporting for exactly that reason.
  //
  // What it reads against is now a known quantity rather than a per-instrument accident: every
  // instrument's Level is calibrated so that 100% puts one note at exactly full scale, so one note at
  // the default 25% measures -12dBFS on all of them, and anything much above that is polyphony,
  // unison or drive spending the headroom. Before the calibration the same reading meant nothing
  // across instruments - one note at the same nominal level measured +3.3dBFS on the subtractive
  // synth and -23.9 on the wavetable.
  let peak = 0;
  for (let i = 0; i < channel.length; i++) {
    const abs = Math.abs(channel[i]);
    if (abs > peak) peak = abs;
  }

  const from = Math.min(channel.length, Math.floor(fromSeconds * sampleRate));
  const to = Math.min(channel.length, Math.floor(toSeconds * sampleRate));
  const magnitudes = averagedSpectrum(channel.subarray(from, to), fftSize);

  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;
  const partials = (askedFor ?? harmonicSeries(f0, nyquist)).slice().sort((a, b) => a - b);

  // Normalise to the loudest bin belonging to the fundamental, so everything below is read as
  // "this far under the note".
  const fundamentalBin = Math.round(f0 / binHz);
  let reference = 0;
  for (let k = Math.max(0, fundamentalBin - PARTIAL_BINS); k <= fundamentalBin + PARTIAL_BINS; k++) {
    if (magnitudes[k] > reference) reference = magnitudes[k];
  }
  if (reference <= 0) reference = 1e-12;

  const db = new Float32Array(magnitudes.length);
  for (let k = 0; k < magnitudes.length; k++) {
    db[k] = 20 * Math.log10(Math.max(magnitudes[k], 1e-12) / reference);
  }

  // Mark every bin that belongs to something we asked for, so what remains is what we didn't.
  const wanted = new Uint8Array(magnitudes.length);
  for (const freq of partials) {
    const centre = Math.round(freq / binHz);
    for (let k = Math.max(0, centre - PARTIAL_BINS); k <= Math.min(wanted.length - 1, centre + PARTIAL_BINS); k++) {
      wanted[k] = 1;
    }
  }

  let aliasDb = -Infinity;
  let aliasHz = 0;
  const minBin = Math.ceil(MIN_HZ / binHz);
  for (let k = minBin; k < db.length; k++) {
    if (wanted[k]) continue;
    if (db[k] > aliasDb) {
      aliasDb = db[k];
      aliasHz = k * binHz;
    }
  }

  const harmonics = [];
  for (let n = 1; n * f0 < nyquist && n <= 24; n++) {
    const centre = Math.round((n * f0) / binHz);
    let best = -Infinity;
    for (let k = Math.max(0, centre - PARTIAL_BINS); k <= Math.min(db.length - 1, centre + PARTIAL_BINS); k++) {
      if (db[k] > best) best = db[k];
    }
    harmonics.push({ n, freq: n * f0, db: best });
  }

  return {
    f0,
    sampleRate,
    binHz,
    db,
    wanted,
    harmonics,
    // Every frequency the patch asked for, not just the first two dozen. The plot marks these,
    // and marking only some of them would invite the ones past the cut-off to be read as faults.
    partials,
    alias: { db: aliasDb, freq: aliasHz },
    peak,
    aboveUnity: peak > 1,
  };
}

/**
 * The same note seen over time: an FFT taken every `hop` samples, in dB against the loudest thing
 * anywhere in the render.
 *
 * This is the view the spectrum view cannot be. A spectrum is one window of time flattened into
 * frequency, so anything that *moves* during that window is smeared across it - which is why the
 * scope holds the envelope and the filter sweep still before measuring, and why it therefore
 * cannot show you the sweep at all. Give time its own axis and the problem goes away: each frame
 * is short enough that the filter has barely moved within it, and the movement becomes the shape
 * you are looking at rather than the blur that ruins it.
 */
export function spectrogram({ channel, sampleRate, fftSize = 1024, hop = 256 }) {
  const window = hann(fftSize);
  const bins = fftSize >> 1;
  const frameCount = Math.max(1, Math.floor((channel.length - fftSize) / hop) + 1);
  const magnitudes = new Float32Array(frameCount * bins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  let peak = 1e-12;
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = (channel[offset + i] ?? 0) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const magnitude = Math.hypot(re[k], im[k]);
      magnitudes[frame * bins + k] = magnitude;
      if (magnitude > peak) peak = magnitude;
    }
  }

  // Normalised to the loudest moment of this render rather than to each frame's own peak. Per
  // frame would be the more colourful picture and a false one: it would rescale the quiet tail up
  // to full brightness and show a note that fades as one that does not.
  const db = new Float32Array(magnitudes.length);
  for (let i = 0; i < magnitudes.length; i++) {
    db[i] = 20 * Math.log10(Math.max(magnitudes[i], 1e-12) / peak);
  }

  // The loudest each bin ever got, across the whole note. An animated spectrum shows one instant
  // at a time, which is what makes it readable and also what it gives up - you cannot compare
  // now against a moment ago. Holding the maximum behind the live trace puts the shape of the
  // whole gesture back on the same axes, without asking colour to carry a number.
  const peakHold = new Float32Array(bins);
  peakHold.fill(-Infinity);
  for (let frame = 0; frame < frameCount; frame++) {
    const row = frame * bins;
    for (let k = 0; k < bins; k++) {
      if (db[row + k] > peakHold[k]) peakHold[k] = db[row + k];
    }
  }

  return {
    db,
    peakHold,
    bins,
    frameCount,
    binHz: sampleRate / fftSize,
    frameSeconds: hop / sampleRate,
    duration: channel.length / sampleRate,
  };
}

/**
 * Render one note of a voice into an OfflineAudioContext and measure it.
 *
 * `voice` is a track's `{ type, state }` - the instrument is built here exactly as the speakers
 * build it, so what comes back describes the thing you can actually play rather than a second
 * implementation of it that agrees for now.
 */
export async function analyseSweep({ voice, midi = 60, sampleRate = 44100 }) {
  const definition = getInstrument(voice?.type);
  if (!definition) return null;
  const f0 = midiToFreq(midi);

  const frames = Math.ceil(RENDER_SECONDS * sampleRate);
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  // An instrument that needs loading says so, and here there is somewhere to wait. Rendering
  // before a worklet's module has arrived measures silence and reports it as a very clean synth.
  await definition.prepare?.(offline);
  const instance = definition.create(offline, offline.destination);
  // The patch exactly as it is, with nothing held still. That is the entire point of this view -
  // the other one has to park everything that moves in order to see anything at all.
  instance.setState(voice.state);
  const sounding = instance.noteOn(midi, f0, 0);
  sounding?.release(SWEEP_RELEASE_S);
  // Everything this note is going to be is now known, and an offline render finishes faster than
  // a message crosses a thread - so an instrument that needs to be told before the first sample
  // gets its chance here, and one that doesn't ignores this entirely.
  instance.commit?.();
  const buffer = await offline.startRendering();

  return {
    midi,
    f0,
    releaseAt: SWEEP_RELEASE_S,
    trajectory: measurementOf(definition).trajectory?.(voice.state, {
      f0,
      // The note itself, because it can be a modulation source - filter key tracking is exactly
      // that - so the line to draw depends on which note was rendered.
      midi,
      duration: RENDER_SECONDS,
      releaseAt: SWEEP_RELEASE_S,
    }),
    ...spectrogram({ channel: buffer.getChannelData(0), sampleRate }),
  };
}

export async function analyseVoice({ voice, midi = 96, sampleRate = 44100, fftSize = 8192 }) {
  const definition = getInstrument(voice?.type);
  if (!definition) return null;
  const measurement = measurementOf(definition);
  const f0 = midiToFreq(midi);
  const state = measurement.steadyState ? measurement.steadyState(voice.state) : voice.state;

  const frames = Math.ceil(RENDER_SECONDS * sampleRate);
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  await definition.prepare?.(offline);
  const instance = definition.create(offline, offline.destination);
  instance.setState(state);
  const sounding = instance.noteOn(midi, f0, 0);
  // Released right at the end, so the flat middle the spectrum is taken from is as long as the
  // render and the release ramp falls outside the window entirely.
  sounding?.release(RENDER_SECONDS - 0.02);
  instance.commit?.();
  const startedAt = performance.now();
  const buffer = await offline.startRendering();
  const renderMs = performance.now() - startedAt;

  return {
    midi,
    // What it cost to make this sound, as a multiple of realtime.
    //
    // Not the same question as live CPU load, and the only one that can actually be answered: an
    // offline render runs flat out with nothing else contending, so it measures the DSP rather
    // than the machine's mood. It is the number that says whether a patch is affordable - a voice
    // that renders at 40x realtime leaves room for a lot of voices, one at 3x does not - and the
    // reason it has to stand in for load is that the audio thread has no clock on it at all.
    cost: { renderMs, realtime: (RENDER_SECONDS * 1000) / Math.max(renderMs, 0.001) },
    ...analyseBuffer({
      channel: buffer.getChannelData(0),
      sampleRate,
      f0,
      partials: measurement.partials?.(state, f0, sampleRate / 2),
      fftSize,
    }),
  };
}
