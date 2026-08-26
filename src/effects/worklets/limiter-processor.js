// The limiter on the audio thread.
//
// Almost nothing, which is the point: the arithmetic is in ../limiter-dsp.js so that it can be run
// in Node and checked against numbers, and this is the shell that gives it 128 samples at a time.
// The processors under src/instruments/ are the other way round - the DSP is in the processor and the
// shared parts were pulled out into voice-dsp.js - because an instrument is mostly its own voice
// handling. A limiter is one loop and a claim about its output, and the claim is what wanted testing.

import { PeakLimiter } from '../limiter-dsp.js';

// How often the meter reports, in render quanta. Eight is about 23ms at 44.1kHz: fast enough that a
// peak meter follows a kick rather than averaging it away, and rare enough that the reporting is not
// itself a cost. This is the one allocation on this thread - a small object per report, not per
// sample - and it is unavoidable, because postMessage copies whatever it is given.
const REPORT_EVERY = 8;

class LimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const initial = options?.processorOptions ?? {};
    this.limiter = new PeakLimiter(sampleRate, initial);
    // Off unless asked, because an offline render has nobody listening and would post a few thousand
    // reports into an empty room - it renders far faster than real time, so "every 23ms of audio" is
    // every fraction of a millisecond of work.
    this.metering = initial.meter === true;
    this.quanta = 0;

    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.limiter.configure(data);
      else if (data?.type === 'meter') this.metering = data.on !== false;
      else if (data?.type === 'reset') this.limiter.reset();
    };
    this.port.postMessage({
      type: 'ready',
      lookaheadSamples: this.limiter.lookahead,
      sampleRate,
    });
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length ?? 0;
    if (!frames) return true;
    // `inputs[0]` is an empty array when nothing is connected, and this still has to run: the delay
    // line is holding the last three milliseconds of the song, and silence is how they get out.
    this.limiter.process(inputs[0] ?? [], output, frames);

    if (this.metering && ++this.quanta >= REPORT_EVERY) {
      this.quanta = 0;
      const report = this.limiter.readMeter();
      report.type = 'meter';
      report.enabled = this.limiter.enabled;
      this.port.postMessage(report);
    }
    // Forever. This is the mix bus, not a voice - there is no point at which it is finished.
    return true;
  }
}

registerProcessor('limiter', LimiterProcessor);
