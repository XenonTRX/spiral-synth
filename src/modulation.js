// Any source to any destination.
//
// This is the thing that separates a synth with knobs from a synth. Until now a moving parameter
// meant a parameter with an envelope hard-wired to it: `filterEnvAmount` in subtractive.js, the same
// idea again in ladder.js, `index` in fm.js. Three instruments, three private answers to the same
// question, and every new instrument would have brought a fourth. A matrix generalises all of them -
// an envelope on the cutoff is one routing out of many rather than a feature someone had to build.
//
// **A source is defined once and realized twice.** That is the only structurally interesting thing
// here and it is worth being plain about why, because "twice" looks like a smell.
//
// The node-graph instruments get their modulation the way Web Audio intends: an AudioParam sums its
// own automation with every signal connected to it, so an LFO is an OscillatorNode connected to
// `filter.detune` through a gain, and the summing is done in C++ at audio rate for free. A worklet
// cannot use that. One AudioWorkletNode plays every voice, and an AudioParam belongs to the node, not
// to a voice - so a per-voice envelope simply cannot be an AudioParam, and the processor has to
// compute its own. Two mechanisms, because the platform has two.
//
// What they share is this file. Each source carries both realizations side by side - `create` builds
// nodes, `sample` returns a number - and the audio thread imports this module directly, which works
// because an AudioWorklet module is an ES module and static imports resolve inside it (verified, not
// assumed). So there is one definition of what "LFO 1" *is*: one rate knob, one shape list, one set
// of defaults, one name in the panel. The parts that differ are the parts the platform forces to
// differ, and they sit ten lines apart where a drift between them is visible.
//
// The pairing is also *testable*, which is the real payoff: render a source through its nodes, walk
// the same source through `sample`, and compare. See the README.

import { choiceParam, holdParamAt, numberParam } from './params.js';
import { ms, pct, signed } from './format.js';

const MIN_STAGE_S = 0.001;

/** More than this and the panel is a spreadsheet. Eight is already a lot of moving parts. */
export const MAX_ROUTINGS = 8;

/**
 * What a *depth* means, per destination kind.
 *
 * The unit is the point. A cutoff modulated "by 2000" is a different gesture at every cutoff, which
 * is the mistake the filter envelope already learned not to make - the ear reads frequency
 * logarithmically, so frequency destinations are modulated in octaves (or semitones, for pitch,
 * because ±0.3 octaves is not how anyone describes vibrato) and reach the parameter through a
 * `detune` input, which is exponential and therefore does the right thing wherever the parameter
 * happens to be sitting.
 *
 * `taperOnRelease` is a correctness flag rather than a taste one. See `attachModulation`.
 */
export const MOD_UNITS = {
  octaves: { range: 5, step: 0.05, format: (v) => signed(v, 2, ' oct') },
  semitones: { range: 24, step: 0.1, format: (v) => signed(v, 1, ' st') },
  // The one that must reach zero, or a note never stops. Amp destinations only.
  level: { range: 1, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`, taperOnRelease: true },
  // A parameter that already runs 0..1 and is not the amplitude.
  amount: { range: 1, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` },
  // Whatever the parameter itself is counted in - an FM index, a drive factor.
  units: { range: 12, step: 0.1, format: (v) => signed(v, 1, '') },
  q: { range: 20, step: 0.1, format: (v) => signed(v, 1, ' Q') },
};

// --- the shapes, shared by both realizations ----------------------------------------------------

export const LFO_SHAPES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Square' },
];

/**
 * One cycle of an LFO, from a phase in turns, as -1..1.
 *
 * Written to match what `OscillatorNode` actually produces rather than to a textbook, because the
 * node-graph half uses the browser's oscillator and this half has to agree with it. The phases were
 * measured off Chrome's own output; the notable one is `square`, which starts at +1 rather than
 * crossing zero, so a square LFO jumps to its extreme the instant a note begins.
 */
export function lfoAt(shape, phase) {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'triangle':
      // Starts at 0, up to +1 at a quarter turn, through 0 at a half, -1 at three quarters.
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 'sawtooth':
      // Rises through zero at the start of the cycle and wraps at the half turn.
      return p < 0.5 ? 2 * p : 2 * p - 2;
    case 'square':
      return p < 0.5 ? 1 : -1;
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

/**
 * An ADSR at time `t` after note-on, released at `releasedAt`, as 0..1.
 *
 * Positional arguments and no closures on purpose: the worklet calls this once per sample per voice,
 * and the processor's one hard rule is that nothing allocates on the audio thread.
 */
export function adsrAt(attack, decay, sustain, release, t, releasedAt) {
  if (t <= 0) return 0;
  const a = attack > MIN_STAGE_S ? attack : MIN_STAGE_S;
  const d = decay > MIN_STAGE_S ? decay : MIN_STAGE_S;
  const x = t < releasedAt ? t : releasedAt;
  let held;
  if (x < a) held = x / a;
  else if (x < a + d) held = 1 + (sustain - 1) * ((x - a) / d);
  else held = sustain;
  if (t < releasedAt) return held;
  const r = release > MIN_STAGE_S ? release : MIN_STAGE_S;
  const gone = (t - releasedAt) / r;
  return gone >= 1 ? 0 : held * (1 - gone);
}

/** Note pitch as a bipolar amount: +1 two octaves above middle C, -1 two octaves below. */
export function keytrackAt(midi) {
  return (midi - 60) / 24;
}

/**
 * One cycle of a shape as an AudioBuffer, so the node-graph half plays exactly what `lfoAt` computes.
 *
 * The obvious way to build an LFO is an `OscillatorNode` set to `square`, and it was, and it was
 * wrong. An OscillatorNode is *band-limited* - it is built for audio, where an ideal square would
 * alias - so its square is a Fourier sum with Gibbs ripple, normalised so the overshoot peaks at 1,
 * which leaves the flat part at 0.848. Measured against this file's own definition the two disagreed
 * by 18% on square and 16% on sawtooth: a patch moved between a node instrument and the worklet
 * would have had visibly different depth, and the shared definition would have been a shared
 * definition of nothing.
 *
 * Band-limiting is pointless here anyway. An LFO runs at 40Hz at the very most, so there is nothing
 * above Nyquist to protect, and a square modulation source is *supposed* to be a hard switch between
 * two values rather than a ripple around them. A looping one-cycle buffer gives that exactly, and the
 * only residual is a buffer sample of linear interpolation across the discontinuities.
 *
 * Cached per context, in a WeakMap because a render makes an OfflineAudioContext and throws it away,
 * and keeping those alive to remember four little buffers would be a leak that grows every time you
 * press Measure.
 */
const CYCLE_POINTS = 2048;
const cycleCache = new WeakMap();

function cycleBuffer(ctx, shape) {
  let byShape = cycleCache.get(ctx);
  if (!byShape) {
    byShape = new Map();
    cycleCache.set(ctx, byShape);
  }
  let buffer = byShape.get(shape);
  if (!buffer) {
    buffer = ctx.createBuffer(1, CYCLE_POINTS, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < CYCLE_POINTS; i++) data[i] = lfoAt(shape, i / CYCLE_POINTS);
    byShape.set(shape, buffer);
  }
  return buffer;
}

// --- the sources --------------------------------------------------------------------------------

function lfoSource(index, { rate, label }) {
  const id = `lfo${index}`;
  const rateKey = `${id}Rate`;
  const shapeKey = `${id}Shape`;
  const fadeKey = `${id}Fade`;
  return {
    id,
    label,
    bipolar: true,
    help: 'Retriggered by every note, so all the voices in a chord move together. A shared free-running LFO is a different sound and not one this has yet.',
    params: [
      numberParam({
        key: rateKey,
        label: `${label} rate`,
        min: 0.05,
        max: 40,
        scale: 'log',
        def: rate,
        format: (v) => (v >= 10 ? `${v.toFixed(0)} Hz` : `${v.toFixed(2)} Hz`),
      }),
      choiceParam({ key: shapeKey, label: `${label} shape`, def: 'sine', choices: LFO_SHAPES }),
      numberParam({
        key: fadeKey,
        label: `${label} fade-in`,
        min: 0,
        max: 4,
        def: 0,
        step: 0.01,
        help: 'How long it takes to reach full depth. Vibrato that arrives after the note has settled sounds played rather than applied.',
        format: (v) => (v <= 0 ? 'off' : ms(v)),
      }),
    ],
    create(ctx, state) {
      const shape = state[shapeKey] ?? 'sine';
      const osc = ctx.createBufferSource();
      osc.buffer = cycleBuffer(ctx, shape);
      osc.loop = true;
      const fade = ctx.createGain();
      osc.connect(fade);
      const fadeSeconds = Math.max(0, state[fadeKey] ?? 0);
      return {
        output: fade,
        start(at) {
          // One cycle of buffer covers CYCLE_POINTS/sampleRate seconds at rate 1, so this is the
          // playback rate that makes it come round once every 1/rate seconds.
          const hz = Math.max(0.05, state[rateKey] ?? 1);
          osc.playbackRate.setValueAtTime((hz * CYCLE_POINTS) / ctx.sampleRate, at);
          if (fadeSeconds > 0) {
            fade.gain.setValueAtTime(0, at);
            fade.gain.linearRampToValueAtTime(1, at + fadeSeconds);
          } else {
            fade.gain.setValueAtTime(1, at);
          }
          osc.start(at);
        },
        stop(at) {
          osc.stop(at);
        },
      };
    },
    sample(state, t) {
      const fadeSeconds = Math.max(0, state[fadeKey] ?? 0);
      const fade = fadeSeconds > 0 ? Math.min(1, t / fadeSeconds) : 1;
      return lfoAt(state[shapeKey] ?? 'sine', t * Math.max(0.05, state[rateKey] ?? 1)) * fade;
    },
  };
}

const ENV2 = {
  id: 'env2',
  label: 'Envelope 2',
  bipolar: false,
  help: 'A second envelope with nothing wired to it until you say so. This is what the filter sweep used to be, before it was a routing.',
  params: [
    numberParam({ key: 'env2Attack', label: 'Env 2 attack', min: 0, max: 2, def: 0.01, step: 0.005, format: ms }),
    numberParam({ key: 'env2Decay', label: 'Env 2 decay', min: 0, max: 4, def: 0.3, step: 0.01, format: ms }),
    numberParam({ key: 'env2Sustain', label: 'Env 2 sustain', min: 0, max: 1, def: 0.3, step: 0.01, format: pct }),
    numberParam({ key: 'env2Release', label: 'Env 2 release', min: 0.005, max: 4, def: 0.2, step: 0.005, format: ms }),
  ],
  create(ctx, state) {
    // A constant of 1 through a gain that carries the shape. The gain *is* the envelope; what it
    // multiplies never changes.
    const source = ctx.createConstantSource();
    source.offset.value = 1;
    const shape = ctx.createGain();
    source.connect(shape);
    let startedAt = 0;
    return {
      output: shape,
      start(at) {
        startedAt = at;
        const attackEnd = at + Math.max(MIN_STAGE_S, state.env2Attack ?? 0);
        const decayEnd = attackEnd + Math.max(MIN_STAGE_S, state.env2Decay ?? 0);
        shape.gain.setValueAtTime(0, at);
        shape.gain.linearRampToValueAtTime(1, attackEnd);
        shape.gain.linearRampToValueAtTime(state.env2Sustain ?? 0, decayEnd);
        source.start(at);
      },
      release(at) {
        // The value it has reached, read off the shared per-sample definition with the release
        // suppressed. The node path needs this number for the same reason the amp envelope does:
        // a ramp with nothing anchored at the release time starts from the last real event instead,
        // which is the end of the decay - see holdParamAt.
        const value = adsrAt(state.env2Attack ?? 0, state.env2Decay ?? 0, state.env2Sustain ?? 0, 1, at - startedAt, Infinity);
        holdParamAt(shape.gain, at, value);
        shape.gain.linearRampToValueAtTime(0, at + Math.max(MIN_STAGE_S, state.env2Release ?? 0.2));
      },
      stop(at) {
        source.stop(at);
      },
    };
  },
  sample(state, t, releasedAt) {
    return adsrAt(state.env2Attack ?? 0, state.env2Decay ?? 0, state.env2Sustain ?? 0, state.env2Release ?? 0.2, t, releasedAt);
  },
};

const KEYTRACK = {
  id: 'keytrack',
  label: 'Note pitch',
  bipolar: true,
  help: 'How high the note is, as ±1 over four octaves either side of middle C. Aimed at the cutoff this is filter key tracking, which is what keeps a patch from going dull as you play up the keyboard.',
  params: [],
  create(ctx, state, { midi }) {
    const source = ctx.createConstantSource();
    source.offset.value = keytrackAt(midi);
    return {
      output: source,
      start(at) {
        source.start(at);
      },
      stop(at) {
        source.stop(at);
      },
    };
  },
  sample(state, t, releasedAt, midi) {
    return keytrackAt(midi);
  },
};

export const MOD_SOURCES = [
  ENV2,
  lfoSource(1, { rate: 5, label: 'LFO 1' }),
  lfoSource(2, { rate: 0.5, label: 'LFO 2' }),
  KEYTRACK,
];

export function modSource(id) {
  return MOD_SOURCES.find((source) => source.id === id) ?? null;
}

/**
 * Every knob the sources own, tagged with which source owns it.
 *
 * These are appended to an instrument's own parameter list (see `defineInstrument`), which means the
 * existing machinery carries them without being told: they are saved, sanitised, defaulted and drawn
 * by the same code that handles a cutoff. The tag is only so the panel can leave out the ones for
 * sources nothing is currently using - eleven knobs for four sources, most of them idle, would bury
 * the instrument's own.
 */
export const MOD_SOURCE_PARAMS = MOD_SOURCES.flatMap((source) =>
  source.params.map((param) => ({ ...param, modSource: source.id })),
);

// --- the matrix ---------------------------------------------------------------------------------

/** The slider for one routing's depth, in whatever unit its destination is measured in. */
export function depthParam(targetParam) {
  const unit = MOD_UNITS[targetParam.mod];
  return numberParam({
    key: 'depth',
    label: 'Depth',
    min: -unit.range,
    max: unit.range,
    step: unit.step,
    def: 0,
    format: (v) => (v === 0 ? 'off' : unit.format(v)),
  });
}

export function modTargetParams(definition) {
  return definition.params.filter((param) => param.mod && MOD_UNITS[param.mod]);
}

/**
 * A saved matrix read as a suggestion, like everything else that comes off disk.
 *
 * A routing naming a source or a destination this build no longer has is dropped rather than
 * defaulted, because unlike a knob there is no sensible value to fall back to - "some other
 * destination" is not a repair. Which is also why depth 0 is dropped: it is a routing that does
 * nothing, and keeping it would mean the panel filling up with rows that have no effect.
 */
export function sanitizeMatrix(raw, definition) {
  if (!Array.isArray(raw)) return [];
  const targets = modTargetParams(definition);
  const out = [];
  for (const entry of raw) {
    if (out.length >= MAX_ROUTINGS) break;
    if (!entry || typeof entry !== 'object') continue;
    const source = modSource(entry.source);
    const target = targets.find((param) => param.key === entry.target);
    if (!source || !target) continue;
    const depth = Number(entry.depth);
    if (!Number.isFinite(depth) || depth === 0) continue;
    const { range } = MOD_UNITS[target.mod];
    out.push({ source: source.id, target: target.key, depth: Math.max(-range, Math.min(range, depth)) });
  }
  return out;
}

/**
 * Everything aimed at one destination, summed, at one moment of a note - in units of depth.
 *
 * The third caller of `sample`, and the one that shows why having it was worth the trouble. The Sweep
 * view draws where the cutoff was *told* to go on top of a spectrogram of where the sound actually
 * went; the two lining up is the whole value of the picture. Once an LFO can reach the cutoff, an
 * overlay that only knew about the filter envelope would draw a straight line across a visibly
 * wobbling spectrogram - not merely unhelpful but actively misleading, since the obvious reading is
 * that the synth is ignoring the instruction. Rather than re-deriving the LFO for drawing, this walks
 * the same definitions the sound came from.
 */
export function modulationAt(state, target, t, releasedAt, midi) {
  const matrix = Array.isArray(state?.mod) ? state.mod : [];
  let sum = 0;
  for (const routing of matrix) {
    if (routing.target !== target || !routing.depth) continue;
    const source = modSource(routing.source);
    if (source) sum += routing.depth * source.sample(state, t, releasedAt, midi);
  }
  return sum;
}

/** Whether anything is aimed at a destination at all - what decides if a drawing needs to be dense. */
export function hasRoutingTo(state, target) {
  const matrix = Array.isArray(state?.mod) ? state.mod : [];
  return matrix.some((routing) => routing.target === target && routing.depth);
}

/** The routings that will actually do something to this voice. */
export function activeRoutings(state, targets) {
  const matrix = Array.isArray(state?.mod) ? state.mod : [];
  return matrix.filter((routing) => routing.depth && targets[routing.target] && modSource(routing.source));
}

const NOTHING = { start() {}, release() {}, stop() {} };

// Frequency destinations reach their parameter through a `detune` input measured in cents, so the
// factor is a property of the unit rather than of the instrument and there is no reason to make every
// instrument restate it - or get it wrong once.
const IMPLIED_SCALE = { octaves: 1200, semitones: 100 };

/**
 * Declare one destination on a voice: what unit its depth is in, and which AudioParams are it.
 *
 * For a frequency destination, pass the `detune` params bare - the factor is implied. For everything
 * else pass `{ param, scale }`, where `scale` is that parameter's own units per unit of depth: the
 * voice's peak level for a tremolo, the modulator frequency for an FM index.
 *
 * Several params for one destination is normal rather than an edge case. Unison pitch is three
 * oscillators, and modulating one of them would be a chorus instead of a vibrato.
 */
export function modTarget(unit, ...entries) {
  const implied = IMPLIED_SCALE[unit];
  return {
    unit,
    params: entries.map((entry) =>
      implied ? { param: entry, scale: implied } : { param: entry.param, scale: entry.scale ?? 1 }),
  };
}

/**
 * Wire a voice's modulation up, for an instrument built out of Web Audio nodes.
 *
 * `targets` maps a destination key to the AudioParams that are it, each with the factor converting
 * one unit of depth into that parameter's own units - 1200 for octaves into a `detune`, the voice's
 * peak level for a tremolo, the modulator frequency for an FM index. A key can name several params:
 * unison pitch is three oscillators and modulating one of them is a chorus, not a vibrato.
 *
 * Sources are built once per voice however many routings use them, so an LFO aimed at both the
 * cutoff and the pitch is one oscillator and two gains, and the two destinations move together
 * because they are reading the same signal rather than two copies of it.
 */
export function attachModulation(ctx, { state, targets, midi }) {
  const routings = activeRoutings(state, targets);
  if (!routings.length) return NOTHING;

  const sources = new Map();
  // The gains that have to be taken back to nothing when the note is let go, and only those. A
  // tremolo that keeps adding to the amp gain after the release ramp has reached zero is a note that
  // never stops - so `level` destinations are tapered. The others are left alone deliberately: their
  // source has its own release, and tapering as well would multiply two shapes together and quietly
  // make Env 2's release knob mean almost nothing.
  const taper = [];

  for (const routing of routings) {
    let source = sources.get(routing.source);
    if (!source) {
      source = modSource(routing.source).create(ctx, state, { midi });
      sources.set(routing.source, source);
    }
    const target = targets[routing.target];
    for (const { param, scale } of target.params) {
      const gain = ctx.createGain();
      const depth = routing.depth * scale;
      gain.gain.value = depth;
      source.output.connect(gain);
      gain.connect(param);
      // The depth is carried alongside, because tapering it later means ramping *from* it and a gain
      // with no scheduled events has nothing for a ramp to start from - it would fade across the
      // whole note instead of the release. Same trap as the amp envelope, one line of prevention.
      if (MOD_UNITS[target.unit]?.taperOnRelease) taper.push({ gain, depth });
    }
  }

  return {
    start(at) {
      for (const source of sources.values()) source.start(at);
    },
    release(at, end) {
      for (const source of sources.values()) source.release?.(at);
      for (const { gain, depth } of taper) {
        holdParamAt(gain.gain, at, depth);
        gain.gain.linearRampToValueAtTime(0, end);
      }
    },
    stop(at) {
      for (const source of sources.values()) source.stop?.(at);
    },
  };
}
