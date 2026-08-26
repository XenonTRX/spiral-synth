// How much of the audio thread is gone.
//
// Audio code has a deadline rather than a speed. The thread wakes up, gets 128 samples' worth of
// work done, and goes back to sleep - at 44.1kHz that is 2.9ms, every 2.9ms, forever. Miss it once
// and there is nothing to play, so the output drops out. That is the only performance question
// worth asking, and it has a number: what fraction of each of those windows is being used.
//
// The reason this is on screen all the time rather than behind a panel is that the number is only
// useful continuously. A synth that costs 8% today and 40% after a change did not fail any test -
// nothing dropped out, nothing sounded wrong, and by the time it does the cause is a fortnight of
// commits back. Watching it drift is the whole point; going to look at it is too late.
//
// `AudioContext.renderCapacity` is the real measurement and not every browser has it. Where it is
// missing there is no way to time the audio thread from outside, so the fallback reports what it
// can honestly know - how many voices are in flight - and says which of the two you are reading.

import { peekContext, voiceLoad } from './audio.js';
import { dspVoices } from './engine.js';

const POLL_MS = 250;
const UPDATE_INTERVAL_S = 0.5;

/**
 * Watch the audio thread and call `onUpdate` with what is known.
 *
 * Starts before there is a context, because there usually isn't one: it is created on the first
 * note so that it starts from a user gesture, which may be minutes after the page loads.
 */
export function createLoadMeter({ onUpdate }) {
  let attached = null;
  let capacity = null;
  let latest = null;

  function attach(ctx) {
    attached = ctx;
    if (!ctx.renderCapacity) return;
    capacity = ctx.renderCapacity;
    capacity.addEventListener('update', (event) => {
      latest = {
        average: event.averageLoad,
        peak: event.peakLoad,
        underrunRatio: event.underrunRatio,
      };
    });
    capacity.start({ updateInterval: UPDATE_INTERVAL_S });
  }

  function poll() {
    const ctx = peekContext();
    // The context arrives on the first note, so attaching is a thing that happens once, later.
    if (ctx && ctx !== attached) attach(ctx);

    const voices = voiceLoad();
    onUpdate({
      // Exact rather than inferred, and only for the parts running in a worklet - see dspVoices
      // for why this is a voice count and not the CPU figure it was supposed to be.
      dsp: dspVoices(),
      // No context yet means nothing has made a sound, which is different from a load of zero.
      idle: !ctx,
      supported: Boolean(capacity),
      sampleRate: ctx?.sampleRate ?? null,
      // The deadline itself, in milliseconds - the useful thing to compare a budget against.
      quantumMs: ctx ? (128 / ctx.sampleRate) * 1000 : null,
      baseLatencyMs: ctx?.baseLatency != null ? ctx.baseLatency * 1000 : null,
      load: latest,
      voices,
    });
  }

  const timer = setInterval(poll, POLL_MS);
  poll();

  return {
    stop() {
      clearInterval(timer);
      capacity?.stop();
    },
  };
}
