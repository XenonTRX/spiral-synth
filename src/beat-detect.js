// Asking a recording what tempo it is, from the main thread's side.
//
// The arithmetic is in tempo-worker.js; what is here is the request, and the one piece of judgement
// that does not belong in a worker: **the mix is what gets analysed, whatever the Channel control
// says.** Side is left minus right, which cancels whatever is panned centre - and on almost every
// record that is the kick and the snare, which is to say the beat. Isolating a melody and then
// asking what tempo the melody implies is a much harder question than the one being asked, and the
// answer would be worse for a setting that has nothing to do with tempo.

import { createWorkerRunner } from './worker-run.js';

export function createBeatDetector() {
  const runner = createWorkerRunner(
    () => new Worker(new URL('./tempo-worker.js', import.meta.url), { type: 'module' }),
  );

  return {
    cancel: runner.cancel,
    busy: runner.busy,
    run({ channel, sampleRate }, handlers) {
      runner.run({ channel, sampleRate }, { transfer: [channel.buffer], ...handlers });
    },
  };
}
