// The chorus on the audio thread: a shell around ../chorus-dsp.js.
//
// The same split as the other four - the arithmetic is in a file with no Web Audio in it, which is
// how "the depth knob is worth ±13 cents at these settings" and "two voices at 0.9 feedback would
// have run away" became numbers instead of hopes.

import { Chorus } from '../chorus-dsp.js';

class ChorusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chorus = new Chorus(sampleRate, options?.processorOptions ?? {});
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.chorus.configure(data);
      else if (data?.type === 'reset') this.chorus.reset();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    if (!frames) return true;
    this.chorus.process(inputs[0] ?? [], output, frames);
    return true;
  }
}

registerProcessor('chorus', ChorusProcessor);
