// Waveforms stored rather than computed, and the reason that is worth doing.
//
// The oscillator in ladder-processor.js counts up a ramp and rounds off the corner with PolyBLEP.
// That works and it has a ceiling, which the scope already found: at C5 the correction is only
// about 8dB, because a single polynomial patch over two samples cannot stand in for the dozens of
// harmonics that have gone over Nyquist by then. Correcting a waveform after generating it is
// always going to be a losing race against pitch.
//
// A wavetable does not race. The waveform is built by *naming its harmonics* and transforming back
// into samples, so it contains exactly what was asked for and nothing above it - band-limited by
// construction rather than by correction. The catch is that "nothing above Nyquist" depends on the
// note being played, so one table is not enough: there is a pyramid of them, each holding half as
// many harmonics as the last, and a note picks the most detailed one that still fits. That is
// mipmapping, borrowed wholesale from texture sampling, where it solves the identical problem.
//
// The other half of what makes this worth building is the *morph*. A table is not one waveform but
// a series of them, and the position between them is a continuous parameter - which means it is a
// modulation destination, and moving it sweeps the harmonic content directly rather than by
// filtering something else. That is the thing a subtractive synth cannot do at all, and it is most
// of what people mean when they say a synth sounds like a wavetable synth.
//
// Nothing here touches the DOM, Web Audio, or a context. It is arithmetic over Float32Arrays, so
// it imports on the main thread, inside AudioWorkletGlobalScope, and in Node - which is how the
// tables get tested without any audio existing at all.

import { ifft } from './fft.js';

/**
 * The pyramid: level L holds `MAX_HARMONICS >> L` harmonics, in enough samples to interpolate
 * cleanly between them.
 *
 * "Enough" is a measured number rather than a chosen one, and getting it wrong was the first real
 * mistake here. The obvious design holds the samples-to-harmonics ratio constant down the pyramid,
 * on the reasoning that every level then interpolates equally well. That is true and it is not the
 * question. Reading a table at a fractional rate images its contents around the table's own sample
 * rate, and those images land back in the audible band - so what matters is how far the *top*
 * harmonic sits below the table's Nyquist, because that is where the interpolator's rejection is
 * worst and where the loudest image comes from.
 *
 * At 4:1 the top harmonic sits at a quarter of the table's rate and Hermite rejects its image by
 * only about 24dB. Measured: a sawtooth at C4 read out of a 4:1 table lands its worst artefact at
 * -60dBc, and that artefact is at f0x(size - harmonics) folded around the output rate - an image,
 * not aliasing, and it would have been mistaken for aliasing indefinitely.
 *
 * Doubling the ratio buys almost exactly 20dB, all the way out:
 *
 *          1:2     1:4     1:8    1:16    1:32
 *   saw  -48.8   -69.4   -89.2  -104.3  -104.3   (C5)
 *   pulse -38.4  -58.8   -78.4   -97.4   -99.7   (C5)
 *
 * So the ratio is 8:1 - which beats the PolyBLEP oscillator it replaces by a wide margin at every
 * pitch - with a floor of MIN_SIZE, because the ratio is only expensive at the bottom of the
 * pyramid. A level holding four harmonics costs nothing to store at 512 samples, and gets a 128:1
 * ratio for free. The cheap levels are also the ones played highest, where images are worst.
 */
export const MAX_HARMONICS = 512;
export const LEVELS = 8;
const OVERSAMPLE = 8;
const MIN_SIZE = 512;

/**
 * How many waveforms a table morphs through.
 *
 * Sixteen, with the position between two of them blended per sample, so the morph is continuous
 * rather than sixteen audible steps. More frames would be smoother and mostly waste: the blend
 * already removes the steps, and the cost of a frame is a whole pyramid.
 */
export const FRAMES = 16;

export const levelHarmonics = (level) => MAX_HARMONICS >> level;
export const levelSize = (level) => Math.max(MIN_SIZE, levelHarmonics(level) * OVERSAMPLE);

/** The biggest table in the pyramid, which is the one the display reads and the scratch buffer fits. */
export const TOP_SIZE = levelSize(0);

/**
 * The most detailed level whose top harmonic still fits under Nyquist at `freq`.
 *
 * Everything above that would fold back down as an inharmonic partial, which is precisely the
 * fault this whole file exists to avoid, so the choice is forced rather than tuned.
 *
 * The price is that levels are an octave apart, so a note sitting just above a boundary gets up to
 * an octave less top end than it could have had - at A4 the harmonics stop at 14kHz rather than
 * 22kHz. That is a real loss and it is the right trade: the alternative to a slightly dull note is
 * an aliased one, and dull is quiet while aliasing is inharmonic and therefore audible at levels
 * far below where dullness registers at all.
 */
export function levelForFrequency(freq, sampleRate) {
  if (!(freq > 0)) return LEVELS - 1;
  const needed = Math.ceil(Math.log2((2 * MAX_HARMONICS * freq) / sampleRate));
  return Math.max(0, Math.min(LEVELS - 1, needed));
}

// --- the tables ---------------------------------------------------------------------------------
//
// Each is a function from (harmonic number, morph position 0..1) to that harmonic's amplitude.
// Declaring the *spectrum* rather than the samples is what makes band-limiting free: a harmonic
// above the level's limit is simply never asked for, so there is nothing to filter out afterwards.
//
// Signs are meaningful - a negative amplitude is a phase inversion, and dropping it in favour of a
// magnitude would give a wave with the right spectrum and the wrong shape. The display draws these,
// so "the right shape" is a visible property here, not only an aesthetic one.
//
// `phase` is the other half of that, and it caught this file out once. Every table was built in
// sine phase, which is right for anything descended from a sawtooth - a 1/n series in sine phase is
// exactly the ramp everybody draws - and wrong for a rectangle, whose series is in cosine. The
// spectrum was correct either way, so it sounded plausible; the picture was not, and the pulse
// table drew as a pair of spikes rather than as a pulse. Measured: in cosine phase the waveform
// spends 43.2% of its cycle high against the 43.3% a rectangle of that width should, and in sine
// phase only 5.5% of it is near either level at all.
//
// It is not only cosmetic. The sine-phase version peaked at 1.93 against cosine's 0.65, so
// normalising it scaled every harmonic down by three - the spikes were spending headroom that
// belongs to the sound.

const TABLE_LIST = [
  {
    id: 'basic',
    name: 'Basic',
    help: 'A sine opening into a full sawtooth. The morph is the harmonic edge itself moving up, which sounds like a filter and is not one — nothing is being removed, the harmonics are simply not there yet.',
    amplitude(n, p) {
      // The edge climbs from the first harmonic to all of them, cubed so that the low end of the
      // knob - where a handful of harmonics arrive one at a time and each is clearly audible - gets
      // most of the travel.
      const edge = 1 + (MAX_HARMONICS - 1) * p ** 3;
      const rolloff = Math.exp(-Math.LN2 * (n / edge) ** 2);
      return rolloff / n;
    },
  },
  {
    id: 'pulse',
    name: 'Pulse',
    help: 'A square narrowing to a thin pulse. This is pulse-width modulation done as harmonics, which is the only way to do it without aliasing — the naive version is two ramps subtracted, and its edges are exactly the discontinuities that fold.',
    // A rectangle's series is in cosine. See the note above.
    phase: 'cosine',
    amplitude(n, p) {
      const width = 0.5 - 0.45 * p;
      return (2 / (n * Math.PI)) * Math.sin(n * Math.PI * width);
    },
  },
  {
    id: 'formant',
    name: 'Formant',
    help: 'A resonant peak sliding up the harmonic series over a quiet sawtooth, which is roughly how a vowel is built. The peak is a bump in the spectrum rather than a filter, so it moves without any feedback and cannot ring.',
    amplitude(n, p) {
      const centre = 2 ** (1 + p * 6);
      const width = 0.75;
      const bump = Math.exp(-((Math.log2(n) - Math.log2(centre)) ** 2) / (2 * width ** 2));
      // A floor under the whole series, so the note keeps a body when the formant is high and does
      // not thin out into a whistle.
      return (bump + 0.12) / n;
    },
  },
  {
    id: 'comb',
    name: 'Comb',
    help: 'A sawtooth with a comb notched through its harmonics, the teeth widening until only the even ones are left — which is the same waveform an octave up. Everything between the ends is hollow and slightly metallic.',
    amplitude(n, p) {
      const spacing = 0.5 * p;
      return ((0.5 + 0.5 * Math.cos(2 * Math.PI * n * spacing)) / n);
    },
  },
];

const TABLE_BY_ID = new Map(TABLE_LIST.map((table) => [table.id, table]));

/** What the panel offers, in the order it offers them. */
export function tableChoices() {
  return TABLE_LIST.map((table) => ({ value: table.id, label: table.name }));
}

export function tableHelp(id) {
  return TABLE_BY_ID.get(id)?.help ?? '';
}

export const DEFAULT_TABLE = TABLE_LIST[0].id;

// --- generation ---------------------------------------------------------------------------------

/**
 * One frame's worth of samples at one level, by inverse transform.
 *
 * Phase is very nearly inaudible on a static waveform, so it is chosen to make the *shape* right:
 * sine for anything descended from a sawtooth, cosine for a rectangle. The display draws these, and
 * a waveform with the right spectrum and the wrong shape is a picture that lies.
 */
function renderFrame(amplitude, p, harmonics, size, out, cosine) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const half = size / 2;
  for (let n = 1; n <= harmonics && n < half; n++) {
    const a = amplitude(n, p);
    if (!a) continue;
    const c = (a * size) / 2;
    // Conjugate-symmetric either way, so what comes back is real. Which half carries it is the
    // difference between a cosine and a sine at that harmonic.
    if (cosine) {
      re[n] = c;
      re[size - n] = c;
    } else {
      im[n] = -c;
      im[size - n] = c;
    }
  }
  ifft(re, im);
  for (let i = 0; i < size; i++) out[i] = re[i];
}

/**
 * Build every level of every frame for one table.
 *
 * The normalisation is the part worth reading twice. Each frame is scaled so its *fullest* level
 * peaks at 1, and every other level of that frame is scaled by the same number. Normalising each
 * level to its own peak would have been the obvious thing and is a bug: truncating harmonics
 * changes a waveform's peak, so a per-level scale would make the pyramid a set of slightly
 * different gains, and crossing a level boundary mid-note - which a pitch bend or a vibrato does
 * constantly - would step the volume. Normalising per frame instead means a level change alters
 * only the top harmonics, which is what a level change is supposed to be.
 */
function buildTable(definition) {
  const levels = [];
  for (let level = 0; level < LEVELS; level++) {
    levels.push({
      harmonics: levelHarmonics(level),
      size: levelSize(level),
      data: new Float32Array(levelSize(level) * FRAMES),
    });
  }

  const scratch = new Float32Array(TOP_SIZE);
  for (let frame = 0; frame < FRAMES; frame++) {
    const p = FRAMES === 1 ? 0 : frame / (FRAMES - 1);

    const cosine = definition.phase === 'cosine';
    renderFrame(definition.amplitude, p, MAX_HARMONICS, TOP_SIZE, scratch, cosine);
    let peak = 0;
    for (let i = 0; i < TOP_SIZE; i++) {
      const abs = Math.abs(scratch[i]);
      if (abs > peak) peak = abs;
    }
    const scale = peak > 1e-9 ? 1 / peak : 1;

    for (let level = 0; level < LEVELS; level++) {
      const { harmonics, size, data } = levels[level];
      const offset = frame * size;
      if (level === 0) {
        for (let i = 0; i < size; i++) data[offset + i] = scratch[i] * scale;
        continue;
      }
      const view = new Float32Array(size);
      renderFrame(definition.amplitude, p, harmonics, size, view, cosine);
      for (let i = 0; i < size; i++) data[offset + i] = view[i] * scale;
    }
  }

  return { id: definition.id, name: definition.name, frames: FRAMES, levels };
}

/**
 * A built table, memoised at module scope.
 *
 * Memoised rather than rebuilt because the data does not depend on an AudioContext - it is the same
 * numbers for the live context and for every throwaway OfflineAudioContext the scope creates, and
 * building it per measurement would put tens of milliseconds into every press of Measure. Held by
 * id rather than in a WeakMap for the same reason: there is nothing context-shaped to key on.
 */
const cache = new Map();

export function getTable(id) {
  const key = TABLE_BY_ID.has(id) ? id : DEFAULT_TABLE;
  let built = cache.get(key);
  if (!built) {
    built = buildTable(TABLE_BY_ID.get(key));
    cache.set(key, built);
  }
  return built;
}

/** The amplitude spec itself, for anything that wants to reason about a table without building it. */
export function tableAmplitude(id, n, p) {
  const definition = TABLE_BY_ID.get(id) ?? TABLE_LIST[0];
  return definition.amplitude(n, p);
}

// --- playback -----------------------------------------------------------------------------------

/**
 * Four-point Hermite interpolation between stored samples.
 *
 * A table read at a fractional rate images its content around the table's own sample rate, and the
 * interpolator's frequency response is the only thing attenuating those images. Linear responds as
 * sinc², which is nowhere near steep enough: measured against Hermite over the same tables it gives
 * up about 3dB at a ratio where both are already limited by the ratio, and falls apart faster as
 * the ratio tightens.
 *
 * The honest summary is that ratio and interpolator trade against each other, and the ratio is the
 * cheaper of the two to buy - so this is Hermite at 8:1 rather than something more elaborate at
 * 4:1. Ten more multiplies a sample than linear, and the images end up below where the oversampling
 * puts them rather than above.
 */
function hermite(y0, y1, y2, y3, t) {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

/**
 * One sample from one frame of one level, at `phase` in turns.
 *
 * `mask` is `size - 1`, passed in rather than derived because this is the innermost thing in the
 * synth and sizes are powers of two by construction - so wrapping is an AND, and computing the
 * mask here would be recomputing a constant several million times a second.
 */
export function sampleFrame(data, offset, size, mask, phase) {
  const pos = phase * size;
  const i1 = pos | 0;
  const t = pos - i1;
  const y0 = data[offset + ((i1 - 1) & mask)];
  const y1 = data[offset + i1];
  const y2 = data[offset + ((i1 + 1) & mask)];
  const y3 = data[offset + ((i1 + 2) & mask)];
  return hermite(y0, y1, y2, y3, t);
}

/**
 * One sample of a table at a morph position, blending the two frames either side of it.
 *
 * Blending samples rather than spectra, which is what every wavetable synth does and is worth being
 * honest about: it is not the same as interpolating the harmonics, and halfway between two frames
 * is not the frame you would have got by averaging their spectra. It is cheap, it is continuous,
 * and the difference is most of why wavetables have the character they do.
 */
export function sampleTable(level, position, phase) {
  const { data, size } = level;
  const mask = size - 1;
  const spot = Math.max(0, Math.min(1, position)) * (FRAMES - 1);
  const frameA = spot | 0;
  const frameB = frameA >= FRAMES - 1 ? frameA : frameA + 1;
  const mix = spot - frameA;
  const a = sampleFrame(data, frameA * size, size, mask, phase);
  if (mix <= 0 || frameB === frameA) return a;
  const b = sampleFrame(data, frameB * size, size, mask, phase);
  return a + (b - a) * mix;
}

/**
 * The visible waveform at a morph position: `count` samples of one cycle, from the fullest level.
 *
 * For the display, so it draws what the oscillator would actually produce at a low note rather
 * than an idealised curve - if a frame has a quirk, the picture should have it too.
 */
export function frameShape(id, position, count = 256) {
  const table = getTable(id);
  const level = table.levels[0];
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = sampleTable(level, position, i / count);
  return out;
}
