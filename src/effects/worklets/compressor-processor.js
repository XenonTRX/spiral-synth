// The compressor on the audio thread: a shell around ../compressor-dsp.js.
//
// The same split as the limiter, for the same reason - the arithmetic is in a file with no Web Audio
// in it so that its claims can be checked against numbers in Node, and this is the 128 samples at a
// time it gets fed.

import { Compressor } from '../compressor-dsp.js';

// Roughly every 23ms at 44.1kHz. Off unless asked, because an offline render has nobody listening.
const REPORT_EVERY = 8;

class CompressorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const initial = options?.processorOptions ?? {};
    this.compressor = new Compressor(sampleRate, initial);
    this.metering = initial.meter === true;
    this.quanta = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.compressor.configure(data);
      else if (data?.type === 'meter') this.metering = data.on !== false;
      else if (data?.type === 'reset') this.compressor.reset();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    if (!frames) return true;
    this.compressor.process(inputs[0] ?? [], output, frames);
    if (this.metering && ++this.quanta >= REPORT_EVERY) {
      this.quanta = 0;
      const report = this.compressor.readMeter();
      report.type = 'meter';
      this.port.postMessage(report);
    }
    // Forever: an insert is not a voice, so there is no point at which it is finished.
    return true;
  }
}

registerProcessor('compressor', CompressorProcessor);
