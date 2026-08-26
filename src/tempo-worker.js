// The audio-thread-free shell around beat-dsp.js.
//
// All it does is move a message across the boundary and report progress on the way. The arithmetic
// is next door precisely so that it can be tested without one of these.

import { detectBeats } from './beat-dsp.js';

self.onmessage = (event) => {
  const { channel, sampleRate } = event.data;
  const result = detectBeats(channel, sampleRate, (done, total) =>
    self.postMessage({ type: 'progress', done, total }),
  );
  self.postMessage({ type: 'done', ...result });
};
