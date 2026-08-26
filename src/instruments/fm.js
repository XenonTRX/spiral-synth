// Two-operator FM: one oscillator bending another one's pitch, fast.
//
// The second instrument, and chosen to be as unlike the first as two things that both make notes
// can be. It has no filter, so nothing about it is subtractive; its character knob is a *ratio*
// rather than a frequency; and the parameter that does what a filter envelope does - opens the
// sound up at the start of a note and lets it close - is an envelope on the modulation index. If
// the instrument abstraction only fitted things shaped like the synth it was extracted from, this
// is where that would have shown, and the one place it did was the scope (see `measurement`).
//
// Why it sounds different rather than merely being different: subtractive synthesis starts with a
// harmonically rich wave and takes things away, so it is always at most as bright as its
// oscillator. FM *adds* - sidebands appear at the carrier plus and minus whole multiples of the
// modulator, and how many there are depends on how hard you push. When the ratio is a whole
// number those sidebands land on harmonics of the note and it sounds like an instrument; when it
// isn't they land between them, and it sounds like a bell. That one knob is the whole range from
// electric piano to gong.

import { choiceParam, defineInstrument, harmonicSeries, holdParamAt, levelParam, linearStageAt, numberParam } from '../instruments.js';
import { attachModulation, modTarget } from '../modulation.js';
import { ms, pct } from '../format.js';

const MIN_STAGE_S = 0.001;


// Ratios that land on a harmonic, and the ones between them. Named rather than free because the
// difference between 2.00 and 2.02 is the difference between a note and a slightly sour note,
// and a slider makes hitting the whole number a matter of luck. The inharmonic ones are chosen,
// not just "not integers" - these are the classic bell and tine ratios.
const RATIOS = [0.5, 1, 1.41, 2, 2.76, 3, 3.5, 4, 5, 7, 8].map((value) => ({
  value,
  label: Number.isInteger(value) ? `${value} : 1  (harmonic)` : `${value} : 1  (bell)`,
}));

export const FM_PARAMS = [
  choiceParam({
    key: 'ratio',
    label: 'Ratio',
    def: 2,
    choices: RATIOS,
    help: 'Modulator pitch against the note. Whole numbers sound like instruments; the others ring.',
  }),
  numberParam({
    key: 'index',
    label: 'Brightness',
    min: 0,
    max: 24,
    def: 5,
    step: 0.1,
    mod: 'units',
    help: 'The modulation index — how far the modulator bends the carrier, and so how many sidebands there are.',
    format: (v) => v.toFixed(1),
  }),
  numberParam({
    key: 'indexAttack',
    label: 'Bright attack',
    min: 0,
    max: 2,
    def: 0.002,
    step: 0.001,
    format: ms,
  }),
  numberParam({ key: 'indexDecay', label: 'Bright decay', min: 0, max: 4, def: 0.6, step: 0.01, format: ms }),
  numberParam({
    key: 'indexSustain',
    label: 'Bright sustain',
    min: 0,
    max: 1,
    def: 0.1,
    step: 0.01,
    help: 'How much brightness is left once the note has settled. Low is what makes a struck sound.',
    format: pct,
  }),
  choiceParam({
    key: 'modWave',
    label: 'Modulator',
    def: 'sine',
    choices: [
      { value: 'sine', label: 'Sine' },
      { value: 'triangle', label: 'Triangle' },
      { value: 'square', label: 'Square' },
      { value: 'sawtooth', label: 'Sawtooth' },
    ],
    help: 'A sine gives the classic FM spectrum. The others fill it in harder and rougher.',
  }),
  numberParam({ key: 'attack', label: 'Attack', min: 0, max: 2, def: 0.002, step: 0.001, format: ms }),
  numberParam({ key: 'decay', label: 'Decay', min: 0, max: 4, def: 0.9, step: 0.01, format: ms }),
  numberParam({ key: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.15, step: 0.01, format: pct }),
  numberParam({ key: 'release', label: 'Release', min: 0.01, max: 4, def: 0.4, step: 0.01, format: ms }),
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
];

/**
 * The measured factor that puts one note at full scale when Level is at 100%.
 *
 * Every instrument here has one now. Before they were measured they were five unrelated fudge
 * factors, each nudged until that instrument sounded reasonable on its own, and they were 27dB
 * apart: at Level 100% one note peaked at -2.5dBFS here against +3.3dBFS on the subtractive synth and -23.9dBFS on the wavetable at the extremes. So the same
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
const OUTPUT_TRIM = 1.3357;

/** This part's level, calibrated. Everything that makes a sound here goes through it. */
const level = (state) => (state.gain ?? 1) * OUTPUT_TRIM;

const PRESETS = [
  {
    name: 'E-Piano',
    state: { ratio: 3, index: 4.5, indexDecay: 0.5, indexSustain: 0.06, decay: 1.2, sustain: 0.12, release: 0.5 },
  },
  {
    name: 'Bell',
    state: { ratio: 1.41, index: 9, indexDecay: 1.6, indexSustain: 0.02, decay: 2.6, sustain: 0.05, release: 1.6 },
  },
  {
    name: 'FM Bass',
    state: { ratio: 1, index: 7, indexDecay: 0.14, indexSustain: 0.08, decay: 0.3, sustain: 0.5, release: 0.15 },
  },
  {
    name: 'Glass',
    state: { ratio: 2.76, index: 3.5, indexDecay: 2.2, indexSustain: 0.25, attack: 0.03, decay: 2.0, sustain: 0.2, release: 1.2 },
  },
  {
    name: 'Clav',
    state: { ratio: 4, index: 6, indexDecay: 0.09, indexSustain: 0.04, decay: 0.22, sustain: 0.1, release: 0.12, modWave: 'square' },
  },
  // Two routings at once, and deliberately the two that sound least alike: a slow vibrato that
  // arrives after the note has settled, and brightness breathing underneath it.
  {
    name: 'Warble',
    state: {
      ratio: 2,
      index: 4,
      indexDecay: 0.4,
      indexSustain: 0.4,
      attack: 0.02,
      decay: 1.4,
      sustain: 0.45,
      release: 0.6,
      lfo1Rate: 5.2,
      lfo1Fade: 0.45,
      lfo2Rate: 0.7,
      mod: [
        { source: 'lfo1', target: 'tune', depth: 0.25 },
        { source: 'lfo2', target: 'index', depth: 2.5 },
      ],
    },
  },
];

/**
 * One sounding note: a carrier, a modulator wired into its frequency, and two envelopes.
 *
 * The depth is set in Hz rather than as a bare number because that is what `carrier.frequency`
 * is measured in. Standard FM defines the peak deviation as index times the *modulator*
 * frequency, which is the definition that makes the index mean the same thing at every pitch -
 * the sideband pattern stays put and only the whole thing transposes. Multiply by the carrier
 * instead and the same setting is a different timbre in every octave.
 */
function startVoice(ctx, destination, state, freq, when, midi, velocity = 1, glide = null) {
  const now = Math.max(when, ctx.currentTime);
  const modFreq = freq * state.ratio;
  const tuneCents = (state.tune ?? 0) * 100;

  // A slide moves *both* oscillators, in step. The ratio between them is the timbre - see the
  // detune two lines below, which is the same argument - so a carrier that slid on its own would
  // sweep the sideband pattern across the spectrum and sound like the patch changing rather than
  // like a pitch moving. What is left behind is the index: `peakDepth` is a deviation in Hz worked
  // out at the pitch the note is arriving at, and it stays that all the way, so a long slide is
  // very slightly brighter at its start than a note struck there would be. It is a fraction of a
  // sideband over a few tens of milliseconds, and correcting it would mean fighting the index
  // envelope for the same AudioParam.
  const glideEnd = glide ? now + Math.max(MIN_STAGE_S, glide.seconds) : now;

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(glide ? glide.fromFreq : freq, now);
  if (glide) carrier.frequency.exponentialRampToValueAtTime(freq, glideEnd);
  carrier.detune.setValueAtTime(tuneCents, now);

  const modulator = ctx.createOscillator();
  modulator.type = state.modWave;
  modulator.frequency.setValueAtTime(glide ? glide.fromFreq * state.ratio : modFreq, now);
  if (glide) modulator.frequency.exponentialRampToValueAtTime(modFreq, glideEnd);
  // Both oscillators, by the same number of cents. Detuning only the carrier would change the
  // *ratio* between them, and the ratio is the timbre - a vibrato would sound like the instrument
  // changing character as it wobbled rather than like a pitch moving.
  modulator.detune.setValueAtTime(tuneCents, now);

  const depth = ctx.createGain();
  modulator.connect(depth);
  depth.connect(carrier.frequency);

  const env = ctx.createGain();
  carrier.connect(env);
  env.connect(destination);

  // The index envelope. Linear ramps, unlike the subtractive synth's filter sweep: this is a
  // deviation in Hz around a fixed centre rather than a cutoff travelling across the spectrum,
  // and it has to be able to reach zero, which an exponential ramp cannot do.
  const peakDepth = state.index * modFreq;
  const indexAttackEnd = now + Math.max(MIN_STAGE_S, state.indexAttack);
  const indexDecayEnd = indexAttackEnd + Math.max(MIN_STAGE_S, state.indexDecay);
  depth.gain.setValueAtTime(0, now);
  depth.gain.linearRampToValueAtTime(peakDepth, indexAttackEnd);
  depth.gain.linearRampToValueAtTime(peakDepth * state.indexSustain, indexDecayEnd);

  const peak = 0.75 * level(state) * velocity;
  const attackEnd = now + Math.max(MIN_STAGE_S, state.attack);
  const decayEnd = attackEnd + Math.max(MIN_STAGE_S, state.decay);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(peak, attackEnd);
  env.gain.linearRampToValueAtTime(peak * state.sustain, decayEnd);

  // `depth.gain` is the index expressed in Hz of peak deviation, so one unit of index depth is one
  // modulator frequency - the same conversion the static index uses two lines up, which is what keeps
  // a modulated index meaning the same thing as a knobbed one.
  const modulation = attachModulation(ctx, {
    state,
    midi,
    targets: {
      tune: modTarget('semitones', carrier.detune, modulator.detune),
      index: modTarget('units', { param: depth.gain, scale: modFreq }),
      gain: modTarget('level', { param: env.gain, scale: peak }),
    },
  });
  modulation.start(now);

  carrier.start(now);
  modulator.start(now);

  let stopped = false;

  return {
    oscillators: 2,
    start: now,
    release(at) {
      if (stopped) return this.end ?? now;
      stopped = true;
      const from = Math.max(at, ctx.currentTime, now);
      const end = from + Math.max(MIN_STAGE_S, state.release);

      // Anchored at the value each envelope will actually have reached by then - see holdParamAt.
      holdParamAt(
        env.gain,
        from,
        linearStageAt(from, { start: now, attackEnd, decayEnd, peak, sustain: peak * state.sustain }),
      );
      env.gain.linearRampToValueAtTime(0, end);

      // The modulator is silenced along with the note. Left running it would keep bending a
      // carrier whose level is falling, which sounds like the pitch sagging as the note dies.
      holdParamAt(
        depth.gain,
        from,
        linearStageAt(from, {
          start: now,
          attackEnd: indexAttackEnd,
          decayEnd: indexDecayEnd,
          peak: peakDepth,
          sustain: peakDepth * state.indexSustain,
        }),
      );
      depth.gain.linearRampToValueAtTime(0, end);

      modulation.release(from, end);

      carrier.stop(end + 0.02);
      modulator.stop(end + 0.02);
      modulation.stop(end + 0.02);
      this.end = end;
      return end;
    },
    earliestEnd: () => Math.max(decayEnd, indexDecayEnd),
  };
}

export default defineInstrument({
  id: 'fm',
  // Declared as well as applied, because the loader has to be able to undo it for a song written
  // before the levels were calibrated - see storage.js.
  outputTrim: OUTPUT_TRIM,
  name: 'FM',
  params: FM_PARAMS,
  presets: PRESETS,
  badge: () => 'FM',
  // Both envelopes hold a note open past its notated end (see `earliestEnd`), and the index one is
  // usually the longer of the two here - a bell's brightness decays for seconds. See
  // subtractive.js's note on why the release alone is not the answer.
  tailSeconds: (state) =>
    Math.max(state.attack + state.decay, state.indexAttack + state.indexDecay) + state.release,
  measurement: {
    // Held still, both envelopes. The index envelope matters more here than the amp one: the
    // number of sidebands is a function of the index, so an index that is moving means a spectrum
    // whose *shape* changes during the window, not merely its level.
    steadyState: (state) => ({
      ...state,
      attack: 0.005,
      decay: 0,
      sustain: 1,
      release: 0.01,
      indexAttack: 0.005,
      indexDecay: 0,
      indexSustain: 1,
      // Parked for the same reason, and it matters more here: modulating the index changes how many
      // sidebands there are, so an LFO on it means a spectrum whose shape is different in every
      // frame of the window.
      mod: [],
    }),
    /**
     * FM's sidebands, which are not a harmonic series and are the reason the scope had to stop
     * asking instruments for a detune and start asking them for their partials.
     *
     * They sit at the carrier plus and minus every whole multiple of the modulator. Negative
     * results are not missing - a sideband pushed below zero reflects back up as its absolute
     * value, which is a real component at a real frequency and would otherwise be reported as a
     * fault. This holds for any modulator wave, not just a sine, because whatever shape it is it
     * still repeats at the modulator frequency, so every component it contributes is still some
     * whole number of modulator-widths from the carrier.
     */
    partials: (state, f0, nyquist) => {
      // Tuned, both of them - the ratio is preserved, so the whole sideband pattern transposes.
      const carrier = f0 * 2 ** ((state.tune ?? 0) / 12);
      const modFreq = carrier * state.ratio;
      if (!(modFreq > 0)) return harmonicSeries(carrier, nyquist);
      const out = [];
      const reach = Math.ceil(nyquist / modFreq) + 1;
      for (let k = -reach; k <= reach; k++) {
        const freq = Math.abs(carrier + k * modFreq);
        if (freq > 0 && freq < nyquist) out.push(freq);
      }
      return out;
    },
  },
  create(ctx, destination) {
    let state = {};
    return {
      setState(next) {
        state = { ...next };
      },
      noteOn(midi, freq, when, velocity = 1, glide = null) {
        return startVoice(ctx, destination, state, freq, when, midi, velocity, glide);
      },
      dispose() {},
    };
  },
});
