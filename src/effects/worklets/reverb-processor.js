// The reverb on the audio thread: a shell around ../reverb-dsp.js.
//
// Same split as the limiter and the compressor. The arithmetic is in a file with no Web Audio in it,
// which is how "the tail lasts as long as the knob says" became a measured number rather than a claim.

import { Reverb } from '../reverb-dsp.js';

class ReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.reverb = new Reverb(sampleRate, options?.processorOptions ?? {});
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.reverb.configure(data);
      else if (data?.type === 'reset') this.reverb.reset();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    if (!frames) return true;
    // Silence still has to be processed: the network is holding the last several seconds of the song,
    // and the only way the tail comes out is by continuing to run once the input has stopped.
    this.reverb.process(inputs[0] ?? [], output, frames);
    return true;
  }
}

registerProcessor('reverb', ReverbProcessor);
