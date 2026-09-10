// The main-thread half every worklet instrument has, written once.
//
// An `AudioWorkletNode` cannot exist until `ctx.audioWorklet.addModule()` has resolved, and the
// scheduler that plays notes is synchronous by construction - it commits notes to the audio clock
// from inside a 25ms tick and has nowhere to put an `await`. Every worklet instrument therefore has
// to absorb its own asynchrony rather than exporting it: a note arriving before the processor exists
// is neither dropped nor waited on, it is *held with the audio-clock time it was meant for* and
// delivered when the node appears. Loading takes a few milliseconds and the scheduler commits 150ms
// ahead, so in practice the queue drains long before the first note was due to sound.
//
// That was worked out in instruments/ladder.js, which explains it at length and is worth reading for
// the two ways it went wrong first. What is here is the same code, factored out when the third,
// fourth and fifth instruments needed it: three more copies of an eighty-line dance around a race
// condition is exactly the situation `effects/worklet-effect.js` exists for on the effects side.
//
// The existing three worklet instruments each still have their own copy. That is not an oversight and
// not an endorsement - they work, they are measured, and rewriting a working instrument to prove a
// point about duplication is how a refactor becomes a bug. New ones come here.

import { loadWorklet } from '../worklet-loader.js';

/**
 * One instrument instance, bound to one context.
 *
 * `outputTrim` is the measured factor that puts one note at full scale when Level is at 100%. It
 * rides along with the *state* rather than being applied to the node's output, which matters: a
 * modulation aimed at the level travels with it, so scaling the level scales its modulation too and
 * a tremolo keeps its depth relative to the note. Scaling the output would leave the modulation
 * behind.
 *
 * `releaseSeconds(state)` is how long after being let go a voice is still making sound, which the
 * caller needs to know the moment it lets go - see `playNote` in engine.js. It is per-instrument
 * because "release" means something different to a damper, a bow and a hand on a string.
 */
export function createWorkletVoice(ctx, destination, { url, name, outputTrim = 1, releaseSeconds }) {
  let node = null;
  let state = {};
  let nextId = 1;
  let load = null;

  // Notes that arrived before the processor did, each keeping the audio-clock time it was meant for -
  // which is the whole trick, and only works because this engine schedules against the clock rather
  // than against "now".
  const queued = [];

  const send = (message) => {
    if (node) node.port.postMessage(message);
    else queued.push(message);
  };

  /**
   * Construct the node, handing it everything it has been told so far.
   *
   * Deliberately not called from here directly. Whatever is known before the first sample has to
   * travel through `processorOptions`, because a port message does not reliably arrive before then:
   * an OfflineAudioContext renders as fast as it can and finishes before the message queue has been
   * serviced. So the queue is not a fallback for a node that does not exist yet - it is the note
   * schedule, and building late enough to carry it is the point.
   */
  function build() {
    if (node) return;
    node = new AudioWorkletNode(ctx, name, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { state, events: queued },
    });
    node.port.onmessage = (event) => {
      if (event.data?.type === 'load') load = event.data;
    };
    node.connect(destination);
    queued.length = 0;
  }

  const module = loadWorklet(ctx, url);
  // Live playback: build at the end of this task, so the burst of notes the scheduler commits in one
  // tick travels in the constructor and everything after it goes by port, which is reliable on a
  // context running in real time.
  if (module.ready) queueMicrotask(build);
  else {
    module.promise.then(build).catch(() => {
      // A worklet that will not load is a part that makes no sound, which is bad, and is still better
      // than an exception thrown out of the scheduler every 25ms, which is worse.
      queued.length = 0;
    });
  }

  return {
    setState(next) {
      state = { ...next, gain: (next.gain ?? 1) * outputTrim };
      // Only when there is something to send it to. Before the node exists the state travels in
      // `processorOptions` instead, and queueing it here was actively harmful: the queue is the note
      // schedule, the processor drains it by comparing `event.time` against the clock, and a params
      // message has no time - so it sat at the head of the queue and every note behind it waited
      // forever, and the render came back silent.
      if (node) node.port.postMessage({ type: 'params', state });
    },

    noteOn(midi, freq, when, velocity = 1, glide = null) {
      const id = nextId++;
      // The pitch travels as well as the frequency, because a modulation source can be the note
      // itself. A slide crosses as two plain numbers rather than as an object, because everything on
      // this port is copied per note and a nested shape is a second allocation for something that is
      // nearly always `0, 0`.
      send({
        type: 'noteOn',
        id,
        freq,
        midi,
        velocity,
        time: when,
        glideFrom: glide ? glide.fromFreq : 0,
        glideSeconds: glide ? glide.seconds : 0,
      });
      let released = false;
      return {
        // One node for the whole instrument, however many notes are sounding. The count the load
        // meter wants is voices, and the processor reports the real one; this is the per-note
        // contribution, which for a worklet is one voice rather than one oscillator.
        oscillators: 1,
        start: when,
        release(at) {
          if (released) return at;
          released = true;
          send({ type: 'noteOff', id, time: at });
          return at + Math.max(0, releaseSeconds(state));
        },
        earliestEnd: () => when,
      };
    },

    /**
     * "You have been told everything — exist now."
     *
     * Only an offline render needs this, and it needs it because it is about to start a render that
     * will finish faster than a message can cross a thread. Live playback never calls it.
     */
    commit() {
      if (module.ready) build();
    },

    /** The real per-quantum cost, measured on the thread that has the deadline. */
    getLoad: () => load,

    dispose() {
      if (!node) return;
      node.port.postMessage({ type: 'panic' });
      node.disconnect();
      node = null;
    },
  };
}
