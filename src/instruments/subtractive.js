// The original voice, behind the instrument interface - and now with a filter that moves.
//
// Two things changed on the way through. It is described by parameter declarations rather than a
// flat object of defaults and a separate table of clamps (see instruments.js), and it answers
// note-on and note-off instead of note-plus-duration. The second is the important one. A note
// whose whole envelope is committed at the moment it starts cannot be held, cannot be let go
// early, and cannot respond to anything that happens while it is sounding - which is fine for a
// sequencer reading a list of lengths, and is not fine for a keyboard, or for a knob you expect
// to hear move. The sequencer still knows both times up front and simply schedules both.
//
// The filter envelope is the reason any of this started. It is a second envelope on the cutoff,
// and the only subtlety is that it is measured in octaves rather than in Hz: pitch is logarithmic
// and so is the ear, so a sweep of "eight thousand Hz" opens dramatically from a low cutoff and
// does almost nothing audible from a high one. In octaves the same setting sounds like the same
// gesture wherever you put the cutoff. It defaults to zero, so every patch written before it
// existed sounds exactly as it did.

import { choiceParam, defineInstrument, exponentialStageAt, harmonicSeries, holdParamAt, levelParam, linearStageAt, numberParam } from '../instruments.js';
import { attachModulation, hasRoutingTo, modTarget, modulationAt } from '../modulation.js';
import { ms, pct } from '../format.js';

const WAVEFORMS = ['sine', 'triangle', 'sawtooth', 'square'];

// Web Audio will not ramp a value exponentially to or from zero, and a filter has no business
// below hearing anyway.
const MIN_HZ = 20;
const MAX_HZ = 20000;

// A ramp needs somewhere to happen. Two automation events at the identical timestamp are not an
// error but they are not a ramp either - the later one simply wins - so every stage gets at least
// this long, which is short enough to read as instant.
const MIN_STAGE_S = 0.001;


export const SUBTRACTIVE_PARAMS = [
  choiceParam({
    key: 'waveform',
    label: 'Waveform',
    def: 'triangle',
    choices: WAVEFORMS.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
  }),
  numberParam({
    key: 'cutoff',
    label: 'Filter cutoff',
    min: MIN_HZ,
    max: MAX_HZ,
    scale: 'log',
    def: 4000,
    mod: 'octaves',
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
  }),
  numberParam({
    key: 'resonance',
    label: 'Filter resonance',
    min: 0.0001,
    max: 40,
    scale: 'log',
    def: 0.7,
    mod: 'q',
    format: (v) => v.toFixed(1),
  }),
  numberParam({
    key: 'filterEnvAmount',
    label: 'Filter sweep',
    min: -4,
    max: 4,
    def: 0,
    step: 0.05,
    help: 'How far the cutoff moves when a note starts, in octaves. Negative sweeps downward.',
    format: (v) => (v === 0 ? 'off' : `${v > 0 ? '+' : ''}${v.toFixed(2)} oct`),
  }),
  numberParam({
    key: 'filterAttack',
    label: 'Sweep attack',
    min: 0,
    max: 2,
    def: 0.005,
    step: 0.005,
    format: ms,
  }),
  numberParam({
    key: 'filterDecay',
    label: 'Sweep decay',
    min: 0,
    max: 2,
    def: 0.18,
    step: 0.005,
    format: ms,
  }),
  numberParam({
    key: 'filterSustain',
    label: 'Sweep sustain',
    min: 0,
    max: 1,
    def: 0,
    step: 0.01,
    help: 'How much of the sweep is still held while the note sustains. 0 falls all the way back.',
    format: pct,
  }),
  numberParam({ key: 'attack', label: 'Attack', min: 0, max: 2, def: 0.01, step: 0.005, format: ms }),
  numberParam({ key: 'decay', label: 'Decay', min: 0, max: 2, def: 0.12, step: 0.005, format: ms }),
  numberParam({ key: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.6, step: 0.01, format: pct }),
  numberParam({ key: 'release', label: 'Release', min: 0.01, max: 4, def: 0.22, step: 0.01, format: ms }),
  numberParam({
    key: 'detune',
    label: 'Unison thickness',
    min: 0,
    max: 100,
    def: 6,
    step: 1,
    format: (v) => `${Math.round(v)}¢`,
  }),
  // Fine tuning, and the destination anything aimed at pitch arrives at - a vibrato is an LFO routed
  // here. Worth having as a knob in its own right, but it earns its place twice.
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
 * apart: at Level 100% one note peaked at +3.3dBFS here against +3.3dBFS on the subtractive synth and -23.9dBFS on the wavetable at the extremes. So the same
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
const OUTPUT_TRIM = 0.6809;

/** This part's level, calibrated. Everything that makes a sound here goes through it. */
const level = (state) => (state.gain ?? 1) * OUTPUT_TRIM;

const PRESETS = [
  { name: 'Keys', state: {} },
  {
    name: 'Bass',
    state: { waveform: 'sawtooth', cutoff: 900, resonance: 4, decay: 0.2, sustain: 0.45, release: 0.16 },
  },
  {
    name: 'Pad',
    state: { waveform: 'triangle', cutoff: 2200, attack: 0.12, decay: 0.3, sustain: 0.75, release: 0.5, detune: 12 },
  },
  {
    name: 'Pluck',
    state: { waveform: 'square', cutoff: 3200, resonance: 2.5, attack: 0.004, decay: 0.09, sustain: 0.2, release: 0.12 },
  },
  // The one the whole exercise was for, kept as a preset so the sound is one click away rather
  // than four sliders away.
  {
    name: 'Sweep',
    state: {
      waveform: 'sawtooth',
      cutoff: 320,
      resonance: 9,
      filterEnvAmount: 3.2,
      filterAttack: 0.01,
      filterDecay: 0.42,
      filterSustain: 0.15,
      attack: 0.005,
      decay: 0.3,
      sustain: 0.7,
      release: 0.3,
      detune: 8,
    },
  },
  // The matrix, made discoverable. A feature reachable only by pressing "+ Route" and guessing is a
  // feature most people never hear; this is one click and immediately obviously a moving filter.
  {
    name: 'Wah',
    state: {
      waveform: 'sawtooth',
      cutoff: 500,
      resonance: 11,
      attack: 0.01,
      decay: 0.2,
      sustain: 0.8,
      release: 0.25,
      detune: 6,
      lfo1Rate: 2.4,
      lfo1Shape: 'sine',
      mod: [{ source: 'lfo1', target: 'cutoff', depth: 1.7 }],
    },
  },
];

const clampHz = (hz) => Math.max(MIN_HZ, Math.min(MAX_HZ, hz));

/**
 * Fit an attack and a decay into the time actually available before the release.
 *
 * Shared rather than written twice because the amp envelope and the filter envelope have to make
 * the same decision about a short note: a sixteenth at speed has no room for a 300ms sweep, and
 * if the two disagree about how to shorten one the filter finishes opening after the note has
 * gone. Scaling them together keeps the shape and loses only the scale.
 */
function fitStages(attack, decay, budget) {
  const room = Math.max(MIN_STAGE_S, budget);
  const total = attack + decay;
  if (total <= room || total <= 0) return { attack, decay };
  const scale = room / total;
  return { attack: attack * scale, decay: decay * scale };
}

/**
 * One sounding note.
 *
 * Built at note-on with no ending scheduled, because at note-on there may not be one yet. The
 * sequencer knows and says so immediately; a held key does not, and says so later.
 */
function startVoice(ctx, destination, state, freq, when, midi, velocity = 1, glide = null) {
  const now = Math.max(when, ctx.currentTime);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.setValueAtTime(state.resonance, now);

  const env = ctx.createGain();
  filter.connect(env);
  env.connect(destination);

  const tuneCents = (state.tune ?? 0) * 100;
  // A note that is sliding starts at the pitch it is leaving and arrives at its own.
  //
  // The ramp is exponential for the same reason the filter's is: a ratio of frequencies is what the
  // ear reads as an interval, so an exponential ramp is a straight line in pitch and a linear one
  // would spend most of its travel somewhere the ear hears as the destination. It is on `frequency`
  // rather than on `detune` because detune already has two jobs here - the tune knob and the unison
  // spread - and a vibrato routed at it must be free to ride on top of a moving note.
  const glideEnd = glide ? now + Math.max(MIN_STAGE_S, glide.seconds) : now;
  const oscillators = [];
  const addOsc = (cents) => {
    const osc = ctx.createOscillator();
    osc.type = state.waveform;
    osc.frequency.setValueAtTime(glide ? glide.fromFreq : freq, now);
    if (glide) osc.frequency.exponentialRampToValueAtTime(freq, glideEnd);
    // Always set, because the tune knob and the unison spread are both in cents and both land here.
    // Modulation aimed at pitch is *connected* to this same param rather than written to it, and Web
    // Audio sums a param's automation with its inputs - so a vibrato rides on top of the tuning
    // instead of replacing it.
    osc.detune.setValueAtTime(cents + tuneCents, now);
    osc.connect(filter);
    oscillators.push(osc);
  };
  addOsc(0);
  if (state.detune > 0) {
    addOsc(state.detune);
    addOsc(-state.detune);
  }

  // Peak backs off when the extra voices are in play so summing them doesn't push the total
  // louder than a single voice would be.
  const peak = (oscillators.length > 1 ? 0.5 : 0.75) * level(state) * velocity;
  const sustainLevel = peak * state.sustain;

  // The attack and decay the note gets if nobody stops it early. A note released during its
  // attack simply ramps down from wherever it had got to, which is what the ramp already does.
  const amp = fitStages(state.attack, state.decay, Number.POSITIVE_INFINITY);
  const attackEnd = now + Math.max(MIN_STAGE_S, amp.attack);
  const decayEnd = attackEnd + amp.decay;

  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(peak, attackEnd);
  env.gain.linearRampToValueAtTime(sustainLevel, decayEnd);

  // The filter envelope, in octaves either side of the cutoff. Exponential ramps, because a
  // linear ramp through frequency spends most of its travel somewhere the ear reads as one place.
  const base = clampHz(state.cutoff);
  const octaves = state.filterEnvAmount ?? 0;
  const top = clampHz(base * 2 ** octaves);
  const held = clampHz(base * 2 ** (octaves * (state.filterSustain ?? 0)));
  const swept = fitStages(state.filterAttack, state.filterDecay, Number.POSITIVE_INFINITY);
  const sweepAttackEnd = now + Math.max(MIN_STAGE_S, swept.attack);
  let filterDecayEnd = now;
  if (octaves === 0) {
    filter.frequency.setValueAtTime(base, now);
  } else {
    filterDecayEnd = sweepAttackEnd + Math.max(MIN_STAGE_S, swept.decay);
    filter.frequency.setValueAtTime(base, now);
    filter.frequency.exponentialRampToValueAtTime(top, sweepAttackEnd);
    filter.frequency.exponentialRampToValueAtTime(held, filterDecayEnd);
  }

  // The routings, wired to the parameters that are actually them. `detune` for the two frequency
  // destinations rather than `frequency` and `cutoff`: a detune input is in cents and therefore
  // exponential, so ±1 octave means the same gesture whether the filter is at 200Hz or 8kHz, and it
  // adds to whatever the filter envelope is already doing rather than fighting it.
  const modulation = attachModulation(ctx, {
    state,
    midi,
    targets: {
      cutoff: modTarget('octaves', filter.detune),
      tune: modTarget('semitones', ...oscillators.map((osc) => osc.detune)),
      resonance: modTarget('q', { param: filter.Q, scale: 1 }),
      gain: modTarget('level', { param: env.gain, scale: peak }),
    },
  });
  modulation.start(now);

  for (const osc of oscillators) osc.start(now);

  let stopped = false;

  return {
    oscillators: oscillators.length,
    start: now,
    /**
     * Let the note go at `when`, and answer when it will have finished sounding.
     *
     * Everything already scheduled past that moment has to be cancelled first, or a release
     * during the attack would be overrun by the attack ramp still arriving behind it.
     */
    release(when) {
      if (stopped) return this.end ?? now;
      stopped = true;
      const at = Math.max(when, ctx.currentTime, now);
      const tail = Math.max(MIN_STAGE_S, state.release);
      const end = at + tail;

      // Anchored at the value the envelope will actually have reached by then, computed from the
      // same numbers that scheduled it - see holdParamAt, which is where getting this wrong cost
      // first a click on every note and then a sustain that quietly wasn't one.
      holdParamAt(env.gain, at, linearStageAt(at, { start: now, attackEnd, decayEnd, peak, sustain: sustainLevel }));
      env.gain.linearRampToValueAtTime(0, end);

      if (octaves !== 0) {
        const cutoffNow = exponentialStageAt(at, {
          start: now,
          attackEnd: sweepAttackEnd,
          decayEnd: filterDecayEnd,
          from: base,
          peak: top,
          sustain: held,
        });
        holdParamAt(filter.frequency, at, cutoffNow);
        filter.frequency.exponentialRampToValueAtTime(base, Math.max(end, at + MIN_STAGE_S));
      }

      modulation.release(at, end);

      for (const osc of oscillators) osc.stop(end + 0.02);
      modulation.stop(end + 0.02);
      this.end = end;
      return end;
    },
    /** The moment nothing further can be scheduled into - used to fit a note into its slot. */
    earliestEnd: () => Math.max(decayEnd, filterDecayEnd),
  };
}

export const SUBTRACTIVE_ID = 'subtractive';

export default defineInstrument({
  id: SUBTRACTIVE_ID,
  // Declared as well as applied, because the loader has to be able to undo it for a song written
  // before the levels were calibrated - see storage.js.
  outputTrim: OUTPUT_TRIM,
  name: 'Subtractive',
  params: SUBTRACTIVE_PARAMS,
  badge: (state) => state.waveform.slice(0, 3),
  /**
   * How long after its notated end this voice can still be sounding - what a render has to leave
   * room for, since a file's length is decided before a note of it exists.
   *
   * The release is the obvious part and not the whole of it: `earliestEnd` refuses to release a
   * note before its envelopes have had room to happen, so a sixteenth note with a two-second filter
   * decay sounds for two seconds. Guessing `release` alone would have cut exactly those patches
   * off, and quietly - the file would simply have been missing its last sound.
   */
  tailSeconds: (state) =>
    Math.max(state.attack + state.decay, state.filterAttack + state.filterDecay) + state.release,
  // What the scope needs to know. Holding the note flat isolates the oscillator and the filter;
  // an envelope is a multiplication in time and therefore a smear in frequency, and the filter
  // sweep is worse still, since a cutoff moving during the window blurs every partial above it.
  // The cost is real and worth stating: the scope cannot show you the sweep, only what the voice
  // sounds like with the sweep parked.
  measurement: {
    steadyState: (state) => ({
      ...state,
      attack: 0.005,
      decay: 0,
      sustain: 1,
      release: 0.01,
      filterEnvAmount: 0,
      // The matrix is parked for the same reason the envelopes are, and more urgently: an LFO on the
      // cutoff moves the filter during the window, which smears every partial above it into a band
      // and would be read as noise the synth is making. The Sweep view is where modulation is meant
      // to be looked at - it keeps the patch exactly as set.
      mod: [],
    }),
    // Unison voices are not harmonics of the root - they sit a few cents either side of it, and
    // so does every one of their partials - so a patch with any thickness at all would otherwise
    // have its own unison reported as contamination.
    /**
     * Where the cutoff was *told* to go, for the sweep view to draw over where the sound
     * actually went.
     *
     * Worth being clear about what this is: it is the intention, not a measurement. Drawing it
     * alone would be a plot of the envelope maths re-derived from the same numbers that produced
     * it, which can only ever agree with itself and would prove nothing. Drawn on top of a
     * spectrogram it becomes the useful thing - the two either line up or they don't, and when
     * they don't the sound is what is right.
     */
    trajectory: (state, { duration, releaseAt, midi = 60 }) => {
      const base = clampHz(state.cutoff);
      const octaves = state.filterEnvAmount ?? 0;
      const modulated = hasRoutingTo(state, 'cutoff');
      // A flat line is still the answer when there is no sweep and nothing routed, and a more useful
      // one than nothing: it says where the filter is sitting.
      if (octaves === 0 && !modulated) {
        return { label: 'cutoff', points: [[0, base], [duration, base]] };
      }
      const top = clampHz(base * 2 ** octaves);
      const held = clampHz(base * 2 ** (octaves * (state.filterSustain ?? 0)));
      const attackEnd = Math.max(MIN_STAGE_S, state.filterAttack);
      const decayEnd = attackEnd + Math.max(MIN_STAGE_S, state.filterDecay);

      // The envelope alone, as a function of time rather than as five corners - which is what a
      // modulated version has to be added to.
      const envelopeAt = (t) => {
        if (octaves === 0) return base;
        if (t <= releaseAt) {
          return exponentialStageAt(t, { start: 0, attackEnd, decayEnd, from: base, peak: top, sustain: held });
        }
        const gone = Math.min(1, (t - releaseAt) / Math.max(MIN_STAGE_S, state.release));
        return held * (base / held) ** gone;
      };

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

      // Densely, because a wobble drawn as five corners is not a wobble. 400 points across a render
      // is finer than the spectrogram's own frames, so the line cannot be the coarser of the two.
      const points = [];
      const steps = 400;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * duration;
        const octavesOfMod = modulationAt(state, 'cutoff', t, releaseAt, midi);
        points.push([t, clampHz(envelopeAt(t) * 2 ** octavesOfMod)]);
      }
      return { label: 'cutoff', points };
    },
    // The tune knob moves the note, so the series has to move with it - measured against an
    // unshifted f0 a detuned patch would have every one of its own harmonics counted as
    // contamination and score about as badly as it is possible to score.
    partials: (state, f0, nyquist) => {
      const root = f0 * 2 ** ((state.tune ?? 0) / 12);
      const cents = state.detune ?? 0;
      if (cents <= 0) return harmonicSeries(root, nyquist);
      const ratio = 2 ** (cents / 1200);
      return [root, root * ratio, root / ratio].flatMap((each) => harmonicSeries(each, nyquist));
    },
  },
  presets: PRESETS,
  create(ctx, destination) {
    // The instance's own copy, because a worklet instrument would have pushed these across to the
    // audio thread and could not read them back out of the song on demand. Keeping the same rule
    // here means the seam behaves the same way whichever side of it an instrument lives on.
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
