// Where the cutoff was *told* to go, as a line the Sweep view can draw over what actually happened.
//
// This is the overlay's whole value: the spectrogram shows where the energy went, and this shows
// where it was asked to go, and the two lining up is the evidence. It lives on its own because two
// instruments now have exactly this filter - the same envelope parameters, the same octave units,
// the same routing destination - and a second copy of it would be a second chance for the picture
// and the sound to disagree, which is the one failure a measurement tool must not have.
//
// This is main-thread only. It is not what the filter does; it is what the filter was asked to do,
// derived from the same state the processor is reading.

import { exponentialStageAt } from '../params.js';
import { hasRoutingTo, modulationAt } from '../modulation.js';

const CUTOFF_MIN_HZ = 20;
const CUTOFF_MAX_HZ = 18000;
const clamp = (hz) => Math.max(CUTOFF_MIN_HZ, Math.min(CUTOFF_MAX_HZ, hz));

// How finely the modulated case is sampled. A straight ADSR needs five points; anything with an
// LFO on it needs enough to draw the wobble, and 400 across a 1.5s render is about one point per
// four milliseconds - finer than the spectrogram's own frames, so the line is never the coarser of
// the two things being compared.
const MODULATED_STEPS = 400;

/**
 * @param state    the instrument's state - cutoff, filterEnvAmount, filterAttack/Decay/Sustain,
 *                 release, and the modulation matrix
 * @param options  duration and releaseAt of the render, and the note, since key tracking makes the
 *                 line depend on which note was played
 */
export function cutoffTrajectory(state, { duration, releaseAt, midi = 60 }) {
  const base = clamp(state.cutoff);
  const octaves = state.filterEnvAmount ?? 0;
  const modulated = hasRoutingTo(state, 'cutoff');

  // Nothing moves it at all, so the honest line is a flat one.
  if (octaves === 0 && !modulated) {
    return { label: 'cutoff', points: [[0, base], [duration, base]] };
  }

  const top = clamp(base * 2 ** octaves);
  const held = clamp(base * 2 ** (octaves * state.filterSustain));
  const attackEnd = Math.max(0.001, state.filterAttack);
  const decayEnd = attackEnd + Math.max(0.001, state.filterDecay);

  if (!modulated) {
    return {
      label: 'cutoff',
      points: [
        [0, base],
        [attackEnd, top],
        [Math.min(decayEnd, releaseAt), held],
        [releaseAt, held],
        [Math.min(duration, releaseAt + state.release), base],
      ],
    };
  }

  // Once something else can reach the cutoff, an overlay that knew only about the envelope would
  // draw a straight line across a visibly wobbling spectrogram - not merely unhelpful but actively
  // misleading, since the obvious reading is that the synth is ignoring the instruction. So the
  // envelope is evaluated point by point and the matrix is added to it, in octaves, exactly the way
  // the processor sums them.
  const envelopeAt = (t) => {
    if (octaves === 0) return base;
    if (t <= releaseAt) {
      return exponentialStageAt(t, { start: 0, attackEnd, decayEnd, from: base, peak: top, sustain: held });
    }
    const gone = Math.min(1, (t - releaseAt) / Math.max(0.001, state.release));
    return held * (base / held) ** gone;
  };

  const points = [];
  for (let i = 0; i <= MODULATED_STEPS; i++) {
    const t = (i / MODULATED_STEPS) * duration;
    points.push([t, clamp(envelopeAt(t) * 2 ** modulationAt(state, 'cutoff', t, releaseAt, midi))]);
  }
  return { label: 'cutoff', points };
}

/**
 * The envelope parameters parked flat, for the Spectrum view.
 *
 * Anything moving during the measurement window is a smear in frequency rather than a feature of
 * the spectrum, so the sweep, the amp envelope and the whole modulation matrix are held still. What
 * is deliberately *not* held is anything being measured for its own sake - resonance, drive, the
 * waveform - because parking those would be measuring a different patch.
 */
export function steadyFilterState(state, extra) {
  return {
    ...state,
    attack: 0.005,
    decay: 0.001,
    sustain: 1,
    release: 0.01,
    filterAttack: 0.005,
    filterDecay: 0.001,
    filterSustain: 1,
    filterEnvAmount: 0,
    mod: [],
    ...extra,
  };
}
