import { createLimiter } from './effects/limiter.js';
import { LIMITER_DEFAULTS } from './effects/limiter-dsp.js';
import { createEffectChain } from './effects/chain.js';

let ctx = null;
let bus = null;
// The monitor level a browser with no preference gets, as a gain: -3dB.
//
// It used to be 0.4, and that was a guess doing a second job - the mix arrived at the bus as much as
// eleven decibels over full scale, so a quiet monitor default was quietly the thing keeping the
// speakers safe. The limiter is that thing now, and it caps the bus at its ceiling whatever the parts
// do, so this can be what it says it is: a comfortable listening level with room to turn up.
let currentVolume = 0.708;
let limiterSettings = { ...LIMITER_DEFAULTS };
let meterListener = null;

// The output bus and the clock, and nothing about what a note sounds like.
//
// This used to hold the synth as well, which was fine while there was one of them. It is not fine
// now: an instrument is a thing that can be added, and if adding one meant editing this file then
// the mixer, the clock and every future instrument would be the same module. What is left here is
// what genuinely is shared - the single context, the master gain the volume slider moves, the
// limiter everything lands in, and the accounting the load meter reads. The voices live in
// src/instruments/.
//
// The bus is a *factory* rather than the singleton it used to be, because export renders the song
// into an OfflineAudioContext and a node cannot be connected across contexts. What used to happen
// instead is what the scope still did until now: connect the instrument straight to
// `offline.destination` and measure a voice that never met the mix bus. That is why its peak
// readout had to be labelled "pre-master" - it was not the level you hear. A file exported that
// way would have been wrong in the same way and much harder to notice.

/**
 * The mix bus: everything an instrument makes goes in one end and the speakers are on the other.
 *
 * Three stages, and the order of them is the whole design.
 *
 *   input → effects → limiter → volume → speakers
 *
 * **`input` is its own node** rather than being whichever stage happens to come first. It costs one
 * unity gain and it means the thing instruments connect to never changes identity, so what sits
 * between it and the limiter can change without any caller being told - which is what the master chain
 * now does, and it is the same `createEffectChain` a part uses. Reusing it rather than writing a
 * second version is the point of the chain owning its own endpoints.
 *
 * The master chain's *contents* live in the song, not here, because a reverb over everything is part
 * of what the song sounds like. What lives here is the wiring; `setEffects` is how it is told.
 *
 * **The limiter is before the volume**, because a monitor control has no business changing the sound.
 * Before the bus was rewired, turning the volume down attenuated the signal on its way *into* the
 * compressor, so a quiet monitor level meant a compressor that barely engaged - the mix genuinely
 * compressed differently depending on how loudly you happened to be listening. That was survivable
 * while listening was the only thing you could do with it, and stopped being survivable the moment
 * the same chain had to render a file, because then "which of those is the real mix" has to have an
 * answer. It is now: the mix is what the limiter puts out, and the volume is how loudly you are
 * hearing it. The exporter renders at unity for exactly this reason and gets the same mix.
 *
 * **The limiter replaced a `DynamicsCompressor` built with its defaults**, which was doing neither of
 * the two jobs a bus stage can do. See effects/limiter-dsp.js for the measurements; the short version
 * is that a -24dB threshold at 12:1 squashes the whole mix, and a 3ms attack with no lookahead lets
 * the peaks through anyway.
 */
export function createOutputBus(
  ctx,
  { volume = 1, limiter = limiterSettings, effects = [], meter = false, onMeter = null } = {},
) {
  const input = ctx.createGain();
  const chain = createEffectChain(ctx);
  const brickwall = createLimiter(ctx, { ...limiter, meter, onMeter });
  const master = ctx.createGain();
  master.gain.value = volume;

  input.connect(chain.input);
  chain.output.connect(brickwall.input);
  brickwall.output.connect(master);
  master.connect(ctx.destination);
  chain.setEffects(effects);

  return {
    /** Where instruments connect. */
    input,
    setVolume(v) {
      master.gain.value = v;
    },
    setLimiter(params) {
      brickwall.setParams(params);
    },
    setEffects(slots) {
      chain.setEffects(slots);
    },
    /**
     * One window of song time for the master chain, so a sweep on the whole mix works like one on a part.
     *
     * The bus is not in the instrument pool - it belongs to the context rather than to any track - so it
     * has to be told separately. Fades are a part's business and do not appear here: a fade on everything
     * is what the last part's fade already is, and a second one on the bus would be a mix automation
     * lane, which is a different feature.
     */
    scheduleAutomation(window) {
      chain.scheduleAutomation(window);
    },
    restAutomation(afterTime) {
      chain.restAutomation(afterTime);
    },
    /**
     * Everything is connected and the processor is really in the chain.
     *
     * Only a render needs to wait for this. Live playback cannot - the scheduler is synchronous -
     * and does not need to: the straight wire through the limiter's endpoints is already carrying
     * audio, so the worst case is that the first few milliseconds after the very first note are
     * unlimited, and in practice the module resolves long before a note is due to sound.
     */
    ready: () => Promise.all([brickwall.ready(), chain.ready()]),
    limiterActive: () => brickwall.active(),
  };
}

// Created lazily on the first note click so the AudioContext starts from an actual
// user gesture (browsers keep it suspended otherwise).
export function ensureContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    bus = createOutputBus(ctx, {
      volume: currentVolume,
      meter: true,
      // Read at call time rather than captured, so the master strip can start listening before
      // anything has made a sound - which is the normal case, since it is on screen from page load.
      onMeter: (data) => meterListener?.(data),
    });
  }
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  return ctx;
}

export function setMasterVolume(v) {
  currentVolume = v;
  bus?.setVolume(v);
}

export function getMasterVolume() {
  return currentVolume;
}

/**
 * Change the limiter, here and in every render from now on.
 *
 * Kept at module scope rather than only on the live bus because a render builds its own bus, and a
 * ceiling that applied to the speakers but not to the file would be the "which one is the real mix"
 * problem back again in a new costume.
 */
export function setLimiterParams(params) {
  limiterSettings = { ...limiterSettings, ...params };
  bus?.setLimiter(limiterSettings);
}

export function getLimiterParams() {
  return { ...limiterSettings };
}

/**
 * The master chain, from the song.
 *
 * Pushed rather than pulled, because this file has no idea what a song is and should not learn: the
 * bus is the wiring and the song is the content. A render builds its own bus and is handed the same
 * list (see export.js), which is the only way the file and the speakers can be the same mix.
 */
export function setMasterEffects(slots) {
  bus?.setEffects(slots);
}

/** One window of song time for the master chain. Nothing happens if no note has built a bus yet. */
export function scheduleMasterAutomation(window) {
  bus?.scheduleAutomation(window);
}

export function restMasterAutomation(afterTime) {
  bus?.restAutomation(afterTime);
}

/**
 * Watch what the limiter is doing: peaks in and out, how much gain it took off, whether anything got
 * through above full scale.
 *
 * One listener, because there is one mix bus and one place on screen that reads it. It is registered
 * before the context exists, which is why the bus reads it through a closure instead of being handed
 * the function.
 */
export function subscribeMasterMeter(fn) {
  meterListener = fn;
  return () => {
    if (meterListener === fn) meterListener = null;
  };
}

/** Whether the limiter's processor has actually loaded, so a readout can decline to claim it has. */
export function limiterActive() {
  return bus?.limiterActive() ?? false;
}

/**
 * The context if there is one, without creating it. The load meter runs from page load and has
 * to be able to say "nothing has made a sound yet" rather than force a context into existence -
 * a context created outside a user gesture starts suspended and stays that way.
 */
export function peekContext() {
  return ctx;
}

// Every note committed to the clock, kept until it has finished sounding, so the meter can say
// how much is in flight. Notes are scheduled up to a lookahead ahead of the present, so this is
// two different numbers - what you are hearing now, and what is already promised - and the
// distinction matters when reading a load figure: the cost of a scheduled note has not landed yet.
const inFlight = [];

export function voiceLoad() {
  const now = ctx?.currentTime ?? 0;
  let sounding = 0;
  let oscillators = 0;
  let pending = 0;
  for (let i = inFlight.length - 1; i >= 0; i--) {
    const note = inFlight[i];
    if (note.end <= now) {
      // Cheap unordered removal - nothing here cares what order these are in.
      inFlight[i] = inFlight[inFlight.length - 1];
      inFlight.pop();
      continue;
    }
    if (note.start <= now) {
      sounding++;
      oscillators += note.voices;
    } else {
      pending++;
    }
  }
  return { sounding, oscillators, pending };
}

// The audio clock, in seconds. It's the only clock accurate enough to line several tracks
// up against each other - setTimeout drifts by milliseconds a tick, which is inaudible on
// one track and turns into flamming between two. Callers schedule against this and hand the
// resulting time back to the instrument.
export function audioNow() {
  return ensureContext().currentTime;
}

/** Where instruments connect. Everything an instrument makes lands here and nowhere else. */
export function masterBus() {
  ensureContext();
  return bus.input;
}

/**
 * Told about a note that has been committed to the clock, so the load meter can count it.
 *
 * Reported by whoever scheduled it rather than counted here, because after the seam this file has
 * no idea what a note costs - an instrument might be three oscillators or one worklet, and only
 * it knows which.
 */
export function noteScheduled(note) {
  inFlight.push(note);
}
