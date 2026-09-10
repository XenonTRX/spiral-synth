// Where the live instruments are.
//
// A part's *state* is plain data on the track - it is saved, and undo restores it by swapping in
// a freshly parsed track object with the same id. A part's *instrument* is a live thing holding
// audio nodes, and if it lived on the track object undo would strand it: the object it was
// attached to no longer exists, and the one that replaced it has no sound. So the instances live
// here, keyed by track id, which is the one piece of identity that survives an undo.
//
// Instances are made on demand rather than when a part is created, because making one touches the
// AudioContext, and the context has to start from a user gesture or the browser keeps it
// suspended. Nothing here runs until the first note is played.
//
// **Why this is a pool and not a module of globals.** It used to be the second. There is one audio
// context, so there is one set of instruments, and half the app needs to make a sound without
// having been handed anything first - all true, and all still true of the *live* set, which is why
// the module-level functions below still exist and still work. What it missed is that rendering a
// file is a second context with a second set of instruments, sounding the same song into a buffer
// instead of the speakers, and a set of globals cannot be two things at once. So the machinery is
// a pool you construct against a context, and the live one is simply the first caller.

import { audioNow, ensureContext, masterBus, noteScheduled } from './audio.js';
import { fadeGainAt, hasFade, releaseToRest, scheduleCurve } from './automation.js';
import { createEffectChain } from './effects/chain.js';
import { getEffect } from './effects.js';
import { getInstrument } from './instruments.js';
import { midiToFreq } from './music-theory.js';

// Long enough to hear the pitch, short enough that a run of arrow keys doesn't leave a chord of
// everything you passed through ringing behind you.
export const AUDITION_SECONDS = 0.32;
const MAX_AUDITION_SECONDS = 1.2;

// What a part's tail is assumed to be when its instrument does not say. Every instrument so far
// happens to call its release `release`, and reading it is a good guess rather than a contract -
// so an instrument that means something else by the word, or has no such knob, can declare
// `tailSeconds(state)` and be believed instead.
const FALLBACK_TAIL_S = 2;

/**
 * How long a chain goes on making sound after its input has stopped.
 *
 * Summed rather than maximised, because effects are in series: a reverb into a delay is a tail into a
 * tail. Summing over-estimates when the second effect has nothing to hold, and an over-estimate here
 * costs a little silence at the end of a render, which the exporter trims anyway - an under-estimate
 * costs the end of the reverb, which nothing can put back.
 */
export function chainTailSeconds(slots) {
  let total = 0;
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (slot.bypass) continue;
    const declared = getEffect(slot.type)?.tailSeconds?.(slot.state);
    if (Number.isFinite(declared)) total += Math.max(0, declared);
  }
  return total;
}

export function tailSecondsFor(track) {
  const definition = getInstrument(track?.instrument?.type);
  if (!definition) return 0;
  const state = track.instrument.state;
  const declared = definition.tailSeconds?.(state);
  const voice = Number.isFinite(declared)
    ? Math.max(0, declared)
    : (Number.isFinite(Number(state?.release)) ? Number(state.release) : FALLBACK_TAIL_S);
  // A part with a four-second reverb on it is still sounding four seconds after its last note, and a
  // render that did not know would cut the tail off. This is the one place that has to add them up.
  return voice + chainTailSeconds(track.effects);
}

/**
 * One set of instruments, sounding into one context.
 *
 * `onNote` is told about every note committed, with the times it was actually given. The live pool
 * points that at the load meter; a render leaves it off, because a note in a file that is not being
 * played yet is not load.
 */
export function createInstrumentPool(ctx, destination, { onNote } = {}) {
  // trackId -> { typeId, instance, chain }
  const live = new Map();

  /**
   * Every part gets a chain, whether or not it has any effects in it.
   *
   * Two unity gains for a part with an empty chain is a rounding error, and having it there
   * unconditionally means the instrument is built against a node that exists for as long as the part
   * does. Building the chain on demand instead would mean the first effect you added had to move a
   * running instrument's output, which is the one thing this arrangement is designed to avoid.
   */
  function chainFor(track) {
    let entry = live.get(track.id);
    if (!entry) {
      // The fade gain sits *after* the chain, which is the whole reason it is a node here rather than a
      // multiplier on each note's velocity. A fade applied per note cannot fade a note that is already
      // sounding, and it cannot fade a reverb tail at all - so a part fading out over four bars would
      // stop making new sound and go on ringing at full level, which is the opposite of a fade.
      entry = { typeId: null, instance: null, chain: createEffectChain(ctx), fade: ctx.createGain() };
      entry.chain.output.connect(entry.fade);
      entry.fade.connect(destination);
      live.set(track.id, entry);
    }
    return entry;
  }

  function instrumentFor(track) {
    if (!track?.instrument) return null;
    const wanted = track.instrument.type;
    const definition = getInstrument(wanted);
    if (!definition) return null;

    const entry = chainFor(track);
    // The chain is reconciled here rather than only on an explicit edit, because the state is written
    // in place by the panel and replaced wholesale by undo, and neither announces what moved.
    entry.chain.setEffects(track.effects);
    // A part that changed instrument gets a new instance rather than a reconfigured one - the old
    // one owns nodes shaped for a different synth and there is nothing to carry across. The chain
    // survives it, because a chain belongs to the part rather than to its voice.
    if (entry.instance && entry.typeId !== wanted) {
      entry.instance.dispose();
      entry.instance = null;
    }
    if (!entry.instance) {
      entry.typeId = wanted;
      entry.instance = definition.create(ctx, entry.chain.input);
    }
    // Pushed every time rather than on change, because the state is edited in place by the panel
    // and replaced wholesale by undo, and neither announces which part of it moved.
    entry.instance.setState(track.instrument.state);
    return entry.instance;
  }

  /**
   * Start a note and schedule its ending in one go, and answer when it will have finished sounding.
   *
   * The sequencer knows both times, so it says both. That the instrument is told them separately is
   * the point: a keyboard knows only the first, and can now say the second when it happens.
   *
   * The end time comes back because a render has to know it. Live playback throws it away - it has
   * a clock and can simply wait - but a file has a length that must be decided in advance, and the
   * only honest check on that guess is what the notes actually said.
   *
   * `slide` is `{ fromMidi, seconds }` or nothing: the pitch this note arrives *from*, and how long
   * it takes to get there. It crosses this seam in Hz rather than in MIDI because that is the unit a
   * voice tunes in, and because the conversion is this file's job either way - it is already the one
   * turning the note into a frequency. Which pitch to leave from is the song's question and is
   * answered in timeline.js, so an instrument is told only what it has to do.
   */
  function playNote(track, midi, when, durationSeconds, velocity = 1, slide = null) {
    const instrument = instrumentFor(track);
    if (!instrument) return 0;
    const glide = slide && slide.seconds > 0 ? { fromFreq: midiToFreq(slide.fromMidi), seconds: slide.seconds } : null;
    const voice = instrument.noteOn(midi, midiToFreq(midi), when, velocity, glide);
    if (!voice) return 0;
    // Never before the envelope has had room to exist, or a note shorter than its own attack would
    // be cut off on the way up and click.
    const end = voice.release(Math.max(when + durationSeconds, voice.earliestEnd?.() ?? 0));
    onNote?.({ start: voice.start, end, voices: voice.oscillators ?? 1 });
    return end;
  }

  return {
    instrumentFor,
    playNote,

    /**
     * Load whatever has to be loaded before any of these parts can make a sound.
     *
     * Only worklet instruments have anything to do here, and only a caller that can wait should
     * call it - the live scheduler cannot, which is exactly why an instrument that needs loading
     * has to cope on its own (see instruments/ladder.js). A render can wait, and does.
     */
    async prepare(tracks) {
      const types = new Set(tracks.map((track) => track?.instrument?.type).filter(Boolean));
      // The chains are built here rather than being left to the first note, because a render has to
      // have every worklet in place before it starts and an effect's processor is one - a reverb
      // spliced in three milliseconds into a file would be three milliseconds of dry.
      const chains = tracks.map((track) => {
        const entry = chainFor(track);
        entry.chain.setEffects(track.effects);
        return entry.chain.ready();
      });
      await Promise.all([...[...types].map((type) => getInstrument(type)?.prepare?.(ctx)), ...chains]);
    },

    /** "You have all been told everything - exist now." Only an offline render needs this. */
    commit() {
      for (const entry of live.values()) entry.instance?.commit?.();
    },

    /**
     * Push every part's chain, without playing anything.
     *
     * Needed because a chain edit has to be audible at once. Playback pushes state on every note, so
     * during a song this happens by itself; with the transport stopped, or between two notes of a held
     * chord, nothing would otherwise carry a knob's new position across - and turning a filter while
     * a reverb tail rings is exactly when you are listening hardest.
     */
    syncEffects(tracks) {
      for (const track of tracks) {
        const entry = live.get(track.id);
        if (entry) entry.chain.setEffects(track.effects);
      }
    },

    /**
     * Commit one window of song time's worth of everything that moves by itself.
     *
     * `window` is `{ fromBeat, toBeat, startTime, endTime }` - a span of song position and the span of
     * audio time it lands in. That pairing is the only thing a caller has to supply and the only thing
     * that differs between playing and rendering: the transport has an anchor and a tempo, a render has
     * a tempo and starts at zero, and neither difference reaches any of the arithmetic.
     *
     * `shapeOf(track)` answers where the part begins, where it ends, and how long its two fades are -
     * all four already resolved, because only the song can resolve them. `end` is often not stored at
     * all (a part with no explicit end is as long as its material) and working it out needs the meter
     * and the note list; the fades are clamped to the span, and the clamp has to be the same number the
     * rack shows or the strip would report a figure the audio was not using.
     */
    scheduleAutomation(tracks, window, shapeOf) {
      for (const track of tracks) {
        const entry = live.get(track.id);
        if (!entry) continue;
        entry.chain.scheduleAutomation(window);
        const shape = shapeOf?.(track);
        if (!shape || !hasFade(shape)) continue;
        scheduleCurve(entry.fade.gain, { ...window, valueAt: (beat) => fadeGainAt(beat, shape) });
      }
    },

    /**
     * Everything that moves, back to where its knob says, after `afterTime`.
     *
     * `afterTime` is the end of the last window already committed rather than now, and that is the
     * point of it. Cancelling automation at `now` lands inside a curve that is already running, which
     * removes the whole curve and steps the parameter - measured, and audible as a click on a resonant
     * filter. Waiting for the committed windows to play out costs one lookahead of latency on the
     * cutoff going home, and nothing at all on anything you can hear.
     */
    restAutomation(afterTime) {
      for (const entry of live.values()) {
        entry.chain.restAutomation(afterTime);
        releaseToRest(entry.fade.gain, 1, afterTime);
      }
    },

    /**
     * How many voices the worklet instruments actually have sounding.
     *
     * This was meant to be a CPU figure, timed by the processor against its own deadline, and it
     * cannot be: `performance` does not exist in AudioWorkletGlobalScope, and the two clocks that
     * do (`currentTime`, `currentFrame`) count rendered audio rather than elapsed time, so they say
     * how much sound was made and not how long it took. `AudioContext.renderCapacity`, the API
     * specified for exactly this, is absent from the browser too. Between them there is no route to
     * live audio load, and inventing a plausible percentage would be worse than admitting that.
     *
     * What a worklet can still say is exactly how many voices it is running, which the node-graph
     * instruments can only estimate from what has been scheduled. For "can I afford this patch",
     * see the offline render cost the scope measures.
     *
     * Voices and oscillators are counted separately because they stopped being the same number. Up
     * to the wavetable every voice was one oscillator, so one count answered both "how many notes
     * are down" and "how much work is that" - and the meter quietly assumed it. Unison breaks the
     * assumption in the direction that matters: seven detuned copies is seven times the oscillator
     * work for the same three notes, and a meter reading three would have said a patch was cheap
     * while it was the most expensive thing in the app. An instrument that does not distinguish
     * them reports the same number twice and nothing changes for it.
     */
    dspVoices() {
      let voices = 0;
      let oscillators = 0;
      let reporting = 0;
      for (const entry of live.values()) {
        const report = entry.instance?.getLoad?.();
        if (!report) continue;
        reporting++;
        voices += report.voices;
        oscillators += report.oscillators ?? report.voices;
      }
      return reporting ? { voices, oscillators, reporting } : null;
    },

    /**
     * Tear down the instruments of parts that no longer exist.
     *
     * Removing a part is one way to get here and undoing is the other, which is why this reconciles
     * against the current list rather than being told what went - an undo can remove several at
     * once and announces only that the tracks changed.
     */
    reap(tracks) {
      const ids = new Set(tracks.map((track) => track.id));
      for (const [id, entry] of live) {
        if (ids.has(id)) continue;
        entry.instance?.dispose();
        entry.chain.dispose();
        entry.fade.disconnect();
        live.delete(id);
      }
    },

    dispose() {
      for (const entry of live.values()) {
        entry.instance?.dispose();
        entry.chain.dispose();
        entry.fade.disconnect();
      }
      live.clear();
    },
  };
}

// --- the live one -------------------------------------------------------------------------------

// Built on first use rather than on load, because building it touches the AudioContext and the
// context has to come from a user gesture. Everything below stays callable from page load: a
// question about instruments that do not exist yet is answered without bringing them into being.
let livePool = null;

function pool() {
  if (!livePool) {
    livePool = createInstrumentPool(ensureContext(), masterBus(), { onNote: noteScheduled });
  }
  return livePool;
}

export function instrumentFor(track) {
  return pool().instrumentFor(track);
}

export function playNote(track, midi, when, durationSeconds, velocity = 1, slide = null) {
  return pool().playNote(track, midi, when, durationSeconds, velocity, slide);
}

/**
 * A preview of the real thing: whatever the part you are editing actually sounds like.
 *
 * `delaySeconds` is how far into the future to put it, and exists for one caller: a strum is a chord
 * whose whole point is that its notes do *not* start together, so auditioning one as a block would
 * preview the thing the edit was made to stop being. Everything else leaves it at zero and starts now.
 */
export function auditionNote(track, midi, seconds = AUDITION_SECONDS, delaySeconds = 0) {
  if (!track) return;
  const at = audioNow() + (delaySeconds > 0 ? delaySeconds : 0);
  playNote(track, midi, at, Math.min(seconds, MAX_AUDITION_SECONDS));
}

export function dspVoices() {
  return livePool ? livePool.dspVoices() : null;
}

/** Make the live chains match the song, now, without waiting for a note. */
export function syncEffects(tracks) {
  livePool?.syncEffects(tracks);
}

/** One window of everything that moves by itself. Called by the transport; see the pool's copy. */
export function scheduleAutomation(tracks, window, regionOf) {
  livePool?.scheduleAutomation(tracks, window, regionOf);
}

/** And what stopping means: fades back to unity, sweeps back to their knobs. */
export function restAutomation(afterTime) {
  livePool?.restAutomation(afterTime);
}

export function reapInstruments(tracks) {
  livePool?.reap(tracks);
}
