// The bus limiter's main-thread half.
//
// Almost nothing left in it: the endpoint-splicing that used to be written out here turned out to be
// the shape of every worklet effect, so it lives in worklet-effect.js and this is the limiter's own
// parameters and metering on top of it. What is worth keeping in mind is *why* the shape exists - a
// bus stage has no events, so it cannot hold work and deliver it late the way an instrument holds
// notes; something simply has to be connected to the speakers before there is anything to connect.

import { LIMITER_DEFAULTS } from './limiter-dsp.js';
import { createWorkletEffect } from './worklet-effect.js';

const PROCESSOR_URL = new URL('./worklets/limiter-processor.js', import.meta.url);
const PROCESSOR_NAME = 'limiter';

/**
 * A limiter to insert somewhere.
 *
 * `meter` asks the processor to report what it is doing; only the live bus wants it, because a render
 * has nobody listening and would post a few thousand reports into an empty room. `onMeter` is called
 * with `{ peakIn, peakOut, rms, gainFloor, clipped, enabled }` every 23ms or so - the extremes since
 * the last report rather than instantaneous values, so a peak between two reports cannot slip through
 * unseen.
 */
export function createLimiter(ctx, { meter = false, onMeter = null, ...params } = {}) {
  let settings = { ...LIMITER_DEFAULTS, ...params };
  const effect = createWorkletEffect(ctx, {
    url: PROCESSOR_URL,
    name: PROCESSOR_NAME,
    params: { ...settings, meter },
    onMessage: onMeter ? (data) => (data?.type === 'meter' ? onMeter(data) : undefined) : null,
  });

  return {
    input: effect.input,
    output: effect.output,
    /** Resolves once the processor is in the chain, or once it is known that it will not be. */
    ready: effect.ready,
    /** True when the audio really is going through it, which the meter has to be able to say. */
    active: effect.active,
    setParams(next) {
      settings = { ...settings, ...next };
      effect.post(settings);
    },
    getParams: () => ({ ...settings }),
    dispose: effect.dispose,
  };
}
