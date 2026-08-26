// One worker, running one job, replacing whatever was still running.
//
// Extracted when the beat detector needed the same thing the spectrogram already had, and the two
// would have been the same forty lines - including the two parts that are easy to get subtly wrong
// twice. A **stale worker's message is ignored**, because terminating one does not un-queue a
// message it has already posted, and a result that arrives after it was replaced would overwrite a
// newer one with an older answer. And the *previous* run is cancelled rather than queued behind,
// because there is no yield point inside a synchronous ten-second loop at which a flag could be
// checked - terminating the worker is the only stop there is.
//
// That matters more than it sounds. Dragging the FFT-size control across five values asks for five
// analyses of the same file; without this, all five run, the page has five workers competing for
// cores, and the answer to the first one arrives last.

export function createWorkerRunner(makeWorker) {
  let worker = null;

  function cancel() {
    worker?.terminate();
    worker = null;
  }

  return {
    cancel,
    busy: () => worker !== null,
    /**
     * `transfer` lists buffers to hand over rather than copy. Anything transferred is unusable here
     * afterwards, which is what the callers want: the samples they send are a throwaway mixdown made
     * for the run, and structured-cloning forty megabytes of it would be a second copy for nothing.
     */
    run(message, { transfer = [], onProgress, onDone, onError } = {}) {
      cancel();
      let created;
      try {
        created = makeWorker();
      } catch (error) {
        onError?.(error);
        return;
      }
      worker = created;

      created.onmessage = (event) => {
        if (created !== worker) return;
        if (event.data?.type === 'progress') {
          onProgress?.(event.data.done / Math.max(1, event.data.total));
          return;
        }
        worker = null;
        created.terminate();
        onDone?.(event.data);
      };
      created.onerror = (event) => {
        if (created !== worker) return;
        worker = null;
        created.terminate();
        onError?.(new Error(event.message || 'the worker failed to start'));
      };

      created.postMessage(message, transfer);
    },
  };
}
