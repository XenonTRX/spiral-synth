// The delay on the audio thread: a shell around ../delay-dsp.js.
//
// The same split as the limiter, the compressor and the reverb - the arithmetic is in a file with no
// Web Audio in it, which is how "the repeats last as long as the feedback knob says" and "the wow is
// ±12 cents" became measured numbers rather than assertions.

import { Delay } from '../delay-dsp.js';

class DelayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.delay = new Delay(sampleRate, options?.processorOptions ?? {});
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.delay.configure(data);
      else if (data?.type === 'reset') this.delay.reset();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    if (!frames) return true;
    // Silence still has to be processed, for the same reason the reverb's does: the repeats are in
    // the line, and the only way they come out is by continuing to run after the input has stopped.
    this.delay.process(inputs[0] ?? [], output, frames);
    return true;
  }
}

registerProcessor('delay', DelayProcessor);
