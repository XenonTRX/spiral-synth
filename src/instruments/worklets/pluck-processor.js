// The audio-thread shell around pluck-dsp.js, and deliberately nothing else.
//
// The two worklets written before these put the whole instrument in the processor: the voice pool,
// the event queue, the routing matrix and the arithmetic, all inside a class extending
// `AudioWorkletProcessor`. It works, and it costs one specific thing - none of it can be tested,
// because `AudioWorkletProcessor` does not exist in Node and there is no way to construct one of
// those classes outside a browser. So the measurements that keep this project honest could only ever
// be taken by rendering in a page and reading a picture.
//
// These three are split the way CLAUDE.md asks for: the *engine* is a plain object in
// instruments/pluck-dsp.js, and this file is the twenty lines that cannot be anything else - the
// registration, the two audio-thread globals (`sampleRate` and `currentTime`), the port, and the
// load report. Everything a test would want to ask is on the other side of that line, which is why
// tests/ can pluck a string, bow one, strike one, and check the pitch it came out at.
//
// `processorOptions` rather than the port for anything that must be true before the first sample.
// A message posted to a port is delivered between render quanta, and an OfflineAudioContext renders
// as fast as it can and finishes before the main thread's message queue has been serviced - measured
// with a probe processor, not assumed. See the long note in instruments/ladder.js.

import { createPluckEngine } from '../pluck-dsp.js';

const REPORT_EVERY = 43;

class PluckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = createPluckEngine(sampleRate, 10);
    this.engine.init(options?.processorOptions);
    this.quanta = 0;
    this.port.onmessage = (event) => this.engine.message(event.data);
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    this.engine.render(out, out.length, currentTime);
    if (++this.quanta >= REPORT_EVERY) {
      this.port.postMessage({ type: 'load', voices: this.engine.sounding() });
      this.quanta = 0;
    }
    return true;
  }
}

registerProcessor('pluck', PluckProcessor);
