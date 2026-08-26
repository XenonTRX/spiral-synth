// Finding the pulse of a recording, so the BPM box can be filled in rather than guessed at.
//
// Arithmetic only - no worker, no DOM, no audio context - which is the same split the effects use
// (`limiter-dsp.js` and the processor that runs it). It is here for the same reason: this is the
// half that can be checked. Feeding it a click track at a known tempo and comparing what comes back
// is a test you can run in Node in a second, and it is the only way to know that a number like
// "127.9997" is right rather than merely plausible.
//
// Three steps, and the first two are the textbook ones (Ellis, *Beat Tracking by Dynamic
// Programming*, 2007). What is worth explaining is the third, because it is the one that decides
// whether the answer is usable for transcription rather than merely correct.
//
//   1. An **onset envelope** - how much new energy arrives at each moment - as half-wave rectified
//      spectral flux over a log-magnitude spectrogram.
//   2. A **tempo** - the lag at which that envelope most resembles itself, weighted by a prior, so
//      that a record with strong eighths is not automatically declared twice its own speed.
//   3. A **long-baseline fit** of the beat times, which is where the precision comes from.
//
// Step three exists because of arithmetic that catches people out. Nothing in this program stretches
// audio, so the recording and the bar lines only stay together if the tempo is *right*, not close.
// Four minutes at 120 BPM is 480 beats; half a BPM out is two whole beats of drift by the end, and
// the picture visibly walks off the grid. Half a BPM is 0.4%, and the autocorrelation lags near 120
// BPM are 2.3% apart - so the peak alone cannot possibly be good enough. Interpolating the peak gets
// close, and then fitting a straight line through four hundred detected beats pins it, because the
// error in a slope measured over that many samples is tiny compared with the error in any one of
// them.

import { fft } from './fft.js';

// A short window: this is looking for *when*, not for *what*, and 23ms of window with 12ms steps
// places a transient closely enough that the fit above can do the rest. The frequency resolution
// that costs - 43Hz a bin - would be useless for reading pitch and is plenty for noticing that a
// kick drum happened.
const FFT_SIZE = 1024;
const HOP = 512;

// The range a tactus is looked for in. Wider than most records need at both ends, and narrow enough
// that a candidate list is a list of tempos rather than of every multiple of one.
const MIN_BPM = 50;
const MAX_BPM = 210;

// Where the prior sits and how wide it is, in octaves of tempo. Without it, a track with a hi-hat on
// every eighth correlates just as well at half the beat as at the beat, and the answer would be a
// coin toss between 87 and 174. This is not a fix - it is a lean, and it is why the candidates are
// offered as a list rather than as one number.
const PRIOR_BPM = 120;
const PRIOR_OCTAVES = 0.9;

// The spectrum is reduced to bands before anything is differenced, and the reason is a measured one.
// Per-bin flux lets a **broadband** transient vote once per bin: a hi-hat covers two hundred bins and
// a kick drum covers three, so a quiet hat outscores a loud kick by any measure that counts bins.
// Measured on a kit with the kick alone on the beats and the hat alone between them, per-bin flux
// made the hats 1.6x the kicks and the beat was found half a beat late, on the off-beat. Bands close
// most of that gap; the low band below closes the rest.
const BANDS = 48;
const BAND_MIN_HZ = 30;
const BAND_MAX_HZ = 11000;

// And the other half of the same measurement: **decibels with a floor** are the wrong compression
// here. Everything between notes is near silence, so the rise into any onset is a ratio against the
// floor rather than against the music, and a whisper of noise scores nearly as much as a drum.
// `log(1 + g*amplitude)` bends the same way at the top and goes quietly to zero at the bottom, so
// what a transient scores is what it is worth. `g` puts the knee at about -60dBFS.
const COMPRESSION = 1000;

// Where the beat *is*, as opposed to how fast it is going, is decided from the bass alone.
//
// This is the one deliberately genre-shaped decision in the file, and it is worth being explicit
// about. In nearly all recorded popular music the bass drum states the beat and everything else
// decorates it, so restricting the phase question to the range a bass drum occupies turns a
// contest between the kick and the hat into a walkover: measured on that same kit, the kick
// outscores the hat 7.5 to 1 below 120Hz, against 0.9 to 1 across the full range.
//
// The tempo is still read from the whole spectrum, because everything that repeats is evidence of
// how fast a record is, and a piece with no drums at all still has a pulse to find.
const PHASE_MAX_HZ = 200;
// Below this there is nothing periodic down there to steer by - a solo guitar, a string quartet -
// and the full band, imperfect as it is, is the only thing left to ask.
const PHASE_MIN_MATCH = 0.1;

// How much of the envelope's own slow shape is subtracted before anything is measured. A chorus is
// louder than a verse, and an envelope that carries that difference correlates with itself at the
// length of the *song section* rather than at the length of a beat.
const FLATTEN_S = 0.4;

const CANDIDATES = 3;
// How far apart two candidates have to be to count as different tempos rather than as the same one
// found twice. Three percent is comfortably wider than the interpolated peak's own uncertainty.
const SEPARATION = 0.03;

// How far either side of a predicted beat the fit will look for the onset that belongs to it, as a
// fraction of the beat. An eighth of a beat is generous enough to absorb a starting tempo that is
// slightly wrong and tight enough that it cannot capture the off-beat instead.
const SEARCH_FRACTION = 8;
// How many beats the fit starts with, before it doubles its way out to the whole recording.
//
// It cannot start with all of them, and the arithmetic says why. The interpolated autocorrelation
// peak is good to about half a percent; the search window is an eighth of a beat, or twelve and a
// half percent - so a prediction built on the seed walks out of its own window after about
// twenty-five beats, and past that the fit is measuring whatever happened to be nearby. Measured, on
// a 128 BPM kit: fitting all 128 beats at once from a 128.50 seed *moved the answer to 128.67*,
// while doubling out from sixteen lands on 128.00. Each fit is accurate enough to make the next,
// longer one safe, which is what makes the doubling work.
const FIT_SEED_BEATS = 16;
// How far the fit is allowed to move the tempo before it is treated as having gone wrong - a fit
// that has locked onto the off-beat, or onto nothing, rather than one that has been refined.
const MAX_DRIFT = 0.06;

function hann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/**
 * Which FFT bins each band covers, log-spaced and never repeating a bin.
 *
 * Below a few hundred hertz a band would be narrower than one bin, so those come out one bin wide
 * and the spacing only starts widening further up. That is the right shape rather than a compromise:
 * it is where the drums are, and it is where a band per bin is affordable.
 */
function bandPlan(sampleRate, fromHz, toHz) {
  const binHz = sampleRate / FFT_SIZE;
  const bins = FFT_SIZE >> 1;
  const low = Math.max(1, Math.floor(fromHz / binHz));
  const high = Math.min(bins - 1, Math.ceil(toHz / binHz));
  const plan = [];
  let previous = low;
  for (let b = 1; b <= BANDS && previous < high; b++) {
    const edge = Math.min(high, Math.max(previous + 1, Math.round(low * Math.pow(high / low, b / BANDS))));
    if (edge > previous) plan.push([previous, edge]);
    previous = edge;
  }
  return plan;
}

/**
 * How much new energy arrives at each frame, in two versions of the same measurement: across the
 * whole spectrum, and across the bass alone.
 *
 * Only increases count. A note ending is not an onset, and letting decreases in would fill the gaps
 * between beats with exactly as much signal as the beats have.
 *
 * Both come out of one pass over the audio, because the expensive part is the transform and running
 * it twice to look at two ranges of the same spectrum would double the cost of the whole feature.
 */
function onsetEnvelopes(channel, sampleRate, report) {
  const win = hann(FFT_SIZE);
  const frames = Math.max(1, Math.floor((channel.length - FFT_SIZE) / HOP) + 1);
  const full = bandPlan(sampleRate, BAND_MIN_HZ, BAND_MAX_HZ);
  // How many of those bands are below the bass ceiling. They are the first ones, because the plan is
  // in ascending order - so the low envelope is a prefix of the full one and needs no second plan.
  const binHz = sampleRate / FFT_SIZE;
  let lowBands = 0;
  while (lowBands < full.length && full[lowBands][0] * binHz < PHASE_MAX_HZ) lowBands++;

  const wide = new Float32Array(frames);
  const bass = new Float32Array(frames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let previous = new Float32Array(full.length);
  let current = new Float32Array(full.length);
  const scale = 2 / FFT_SIZE;

  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (channel[offset + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);

    let wideFlux = 0;
    let bassFlux = 0;
    for (let b = 0; b < full.length; b++) {
      const [from, to] = full[b];
      let power = 0;
      for (let k = from; k < to; k++) power += re[k] * re[k] + im[k] * im[k];
      // Amplitude, scaled back to the units the samples were in, so the knee below means the same
      // thing whatever the window length is.
      const value = Math.log1p(COMPRESSION * Math.sqrt(power / (to - from)) * scale);
      current[b] = value;
      if (frame > 0) {
        const rise = value - previous[b];
        if (rise > 0) {
          wideFlux += rise;
          if (b < lowBands) bassFlux += rise;
        }
      }
    }
    wide[frame] = wideFlux;
    bass[frame] = bassFlux;

    const swap = previous;
    previous = current;
    current = swap;

    if ((frame & 255) === 0) report(frame, frames);
  }
  return { wide, bass };
}

/** The envelope with its own slow shape taken out, rectified, and centred ready to correlate. */
function flatten(env, radius) {
  const running = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) running[i + 1] = running[i] + env[i];

  const out = new Float32Array(env.length);
  let total = 0;
  for (let i = 0; i < env.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(env.length, i + radius + 1);
    const local = (running[to] - running[from]) / (to - from);
    out[i] = Math.max(0, env[i] - local);
    total += out[i];
  }
  // Centred, because an autocorrelation of a signal that never goes below zero has a peak everywhere
  // - every lag lines some energy up with some other energy - and the peaks that matter are the ones
  // that stand out from that, not the total.
  const mean = total / Math.max(1, env.length);
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/** Where the envelope resembles itself, per lag, as a correlation coefficient in [-1, 1]. */
function autocorrelation(env, minLag, maxLag) {
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i] * env[i];
  energy /= Math.max(1, env.length);
  if (!(energy > 0)) return null;

  const acf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < env.length; i++) sum += env[i] * env[i - lag];
    // Divided by the number of terms rather than by the length, so a long lag is not penalised for
    // having fewer of them - which would tilt every result towards the fastest tempo on offer.
    acf[lag] = sum / (env.length - lag) / energy;
  }
  return acf;
}

/** The true position of a peak that has been sampled at whole lags, to a fraction of one. */
function interpolatePeak(values, at) {
  const a = values[at - 1];
  const b = values[at];
  const c = values[at + 1];
  const denominator = a - 2 * b + c;
  if (!Number.isFinite(denominator) || denominator === 0) return at;
  const shift = (0.5 * (a - c)) / denominator;
  return Math.abs(shift) < 1 ? at + shift : at;
}

/** Which offset within one beat the onsets actually fall on. */
function bestPhase(env, period) {
  let best = -Infinity;
  let phase = 0;
  for (let start = 0; start < Math.round(period); start++) {
    let sum = 0;
    let count = 0;
    for (let t = start; t < env.length; t += period) {
      sum += env[Math.round(t)];
      count++;
    }
    if (count && sum / count > best) {
      best = sum / count;
      phase = start;
    }
  }
  return phase;
}

/**
 * Fit a straight line through the onsets nearest every predicted beat.
 *
 * Weighted by how strong each onset is, which is what keeps a quiet passage from voting. A bar of
 * silence still gets its predicted beats, and the loudest frame within the search window there is
 * noise - so it contributes, but with the weight of noise.
 */
function refine(env, period, phase, maxBeats = Infinity) {
  const window = Math.max(1, Math.round(period / SEARCH_FRACTION));
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;

  const beats = Math.min(maxBeats, Math.floor((env.length - 1 - phase) / period));
  for (let n = 0; n <= beats; n++) {
    const centre = Math.round(phase + n * period);
    let bestValue = -Infinity;
    let bestAt = centre;
    for (let i = Math.max(0, centre - window); i <= Math.min(env.length - 1, centre + window); i++) {
      if (env[i] > bestValue) {
        bestValue = env[i];
        bestAt = i;
      }
    }
    if (!(bestValue > 0)) continue;
    sw += bestValue;
    sx += bestValue * n;
    sy += bestValue * bestAt;
    sxx += bestValue * n * n;
    sxy += bestValue * n * bestAt;
  }

  const denominator = sw * sxx - sx * sx;
  if (!(Math.abs(denominator) > 1e-9)) return null;
  const slope = (sw * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / sw;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  // A fit that has moved the tempo this far has not refined the answer, it has found a different
  // one - usually the off-beat, or a passage that happens to be in another metre.
  if (Math.abs(slope / period - 1) > MAX_DRIFT) return null;
  return { period: slope, phase: intercept };
}

/**
 * Fit the beats, starting short and doubling out to the whole recording - see FIT_SEED_BEATS.
 */
function fitBeats(env, seedPeriod, seedPhase) {
  let period = seedPeriod;
  let phase = seedPhase;
  let span = FIT_SEED_BEATS;
  for (;;) {
    const fitted = refine(env, period, phase, span);
    if (fitted) {
      period = fitted.period;
      phase = fitted.phase;
    }
    const available = Math.floor((env.length - 1 - phase) / period);
    if (span >= available) return { period, phase };
    span = Math.min(available, span * 2);
  }
}

/**
 * The same fit with the tempo held still: only the offset moves.
 *
 * A weighted mean of where each beat's onset actually landed relative to where it was predicted.
 * With the slope fixed there is nothing for a bad stretch to lever against, so this can be run on a
 * sparse envelope - a kick four times a bar - without the risk that makes fitting a *slope* to the
 * same envelope a bad idea.
 */
function refinePhase(env, period, phase) {
  const window = Math.max(1, Math.round(period / SEARCH_FRACTION));
  let weight = 0;
  let offset = 0;

  const beats = Math.floor((env.length - 1 - phase) / period);
  for (let n = 0; n <= beats; n++) {
    const predicted = phase + n * period;
    const centre = Math.round(predicted);
    let bestValue = -Infinity;
    let bestAt = centre;
    for (let i = Math.max(0, centre - window); i <= Math.min(env.length - 1, centre + window); i++) {
      if (env[i] > bestValue) {
        bestValue = env[i];
        bestAt = i;
      }
    }
    if (!(bestValue > 0)) continue;
    weight += bestValue;
    offset += bestValue * (bestAt - predicted);
  }
  if (!(weight > 0)) return null;
  return phase + offset / weight;
}

/**
 * Everything, in order: onsets, tempo candidates, and where each one's beats fall.
 *
 * `onProgress(done, total)` is called through the slow part so a caller can say how far along it is.
 */
export function detectBeats(channel, sampleRate, onProgress = () => {}) {
  const raw = onsetEnvelopes(channel, sampleRate, onProgress);
  const framesPerSecond = sampleRate / HOP;
  const radius = Math.round(FLATTEN_S * framesPerSecond);
  const env = flatten(raw.wide, radius);
  const bass = flatten(raw.bass, radius);

  const minLag = Math.max(2, Math.floor((framesPerSecond * 60) / MAX_BPM));
  const maxLag = Math.ceil((framesPerSecond * 60) / MIN_BPM);
  // Two full periods of the slowest tempo on offer is the least that can be said to repeat at all.
  if (env.length < maxLag * 2 + 2) return { candidates: [], tooShort: true };

  const acf = autocorrelation(env, minLag, maxLag);
  if (!acf) return { candidates: [], silent: true };

  // Score every lag, then keep the peaks. The prior is applied to the score and not to the reported
  // match, so what comes back says how well the recording fits that tempo rather than how much this
  // code wanted it to.
  const peaks = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] <= acf[lag - 1] || acf[lag] < acf[lag + 1]) continue;
    const bpm = (framesPerSecond * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES, 2));
    peaks.push({ lag, score: acf[lag] * prior, match: acf[lag] });
  }
  peaks.sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const peak of peaks) {
    if (chosen.length >= CANDIDATES) break;
    if (chosen.some((other) => Math.abs(peak.lag / other.lag - 1) < SEPARATION)) continue;
    chosen.push(peak);
  }

  const bassAcf = autocorrelation(bass, minLag, maxLag);

  const candidates = [];
  for (const peak of chosen) {
    let period = interpolatePeak(acf, peak.lag);
    // **How fast** comes from the whole spectrum. Every repeating thing on the record is evidence
    // about the tempo, and a slope is measured better the more points are on the line. With the
    // doubling fit above doing the heavy lifting the two are close - measured, fitting the bass
    // alone costs nothing at all on a kit with a four-to-the-floor kick, and about three times the
    // error (0.0024 BPM against 0.0008) on material whose bass is sparse. Both are negligible; the
    // full band is chosen because it is the one that does not depend on there being a kick drum.
    const fitted = fitBeats(env, period, bestPhase(env, period));
    period = fitted.period;
    let phase = fitted.phase;

    // **Where** comes from the bass, with the tempo now held still - see PHASE_MAX_HZ. Two questions,
    // two different best answers, and separating them is what lets each have the evidence it wants.
    const bassMatch = bassAcf ? (bassAcf[Math.round(period)] ?? 0) : 0;
    const fromBass = bassMatch >= PHASE_MIN_MATCH;
    if (fromBass) {
      const seeded = bestPhase(bass, period);
      phase = refinePhase(bass, period, seeded) ?? seeded;
    }

    // Back to the first beat at or after the start of the file. The fit's intercept is beat zero of
    // wherever it happened to start counting, which can be slightly negative.
    let first = phase;
    while (first < 0) first += period;
    candidates.push({
      bpm: (framesPerSecond * 60) / period,
      // A frame is centred on its own window, so the moment it describes is half a window in. This is
      // the convention rather than a correction: a transient raises the flux of the frames whose
      // window contains it, and the middle of that window is the least wrong single answer. What is
      // left is a systematic offset of a few milliseconds, which is what the nudges are for.
      anchor: (first * HOP + FFT_SIZE / 2) / sampleRate,
      match: peak.match,
      // Which envelope placed the beats, so a caller can say when it was working without drums.
      fromBass,
    });
  }

  return { candidates, frameSeconds: HOP / sampleRate };
}
