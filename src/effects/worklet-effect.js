// The main-thread half of an effect whose work happens on the audio thread.
//
// Written once because there are three of these now - the bus limiter, the compressor and the reverb -
// and they differ only in which processor they load and what they call their parameters. The shape is
// the interesting part, and it is the answer to a collision this project hit repeatedly: a worklet
// cannot exist until `addModule` resolves, and everything that wants to connect to one is
// synchronous.
//
// So the wrapper owns its endpoints. `input` and `output` are two unity gains that exist from the
// first line, wired straight to each other, and when the processor turns up it is spliced in between
// them. Nothing above ever sees a node appear, the graph is complete before the module has loaded,
// and the failure case - a processor that will not load at all - leaves a wire rather than a hole.
//
// A pair of gain nodes sounds like ceremony until you consider the alternative, which is that every
// caller holds a nullable node and has to know whether it has arrived yet.

import { loadWorklet } from '../worklet-loader.js';

/**
 * `{ input, output, ready, post, active, dispose }`.
 *
 * `params` travels in `processorOptions` as well as through the port, because a port message is not
 * reliably delivered before the first `process()` - an OfflineAudioContext renders faster than the
 * message queue is serviced, which was measured rather than assumed. So anything that must be true
 * before the first sample goes through the constructor.
 */
export function createWorkletEffect(ctx, { url, name, params = {}, onMessage = null } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);

  let node = null;
  let latest = { ...params };

  function build() {
    if (node) return;
    // No `outputChannelCount`: with one input and one output the output follows the input's channel
    // count, so a mono chain stays mono and a future stereo one is not silently folded down.
    node = new AudioWorkletNode(ctx, name, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { ...latest },
    });
    if (onMessage) node.port.onmessage = ({ data }) => onMessage(data);
    input.disconnect(output);
    input.connect(node);
    node.connect(output);
  }

  const ready = loadWorklet(ctx, url)
    .promise.then(build)
    .catch(() => {
      // A processor that will not load leaves the straight wire in place, which is the right failure:
      // the effect does nothing instead of the part going silent.
    });

  return {
    input,
    output,
    ready: () => ready,
    active: () => node !== null,
    /** Update the parameters. Merged and kept, so a node built later starts from all of them. */
    post(next) {
      latest = { ...latest, ...next };
      node?.port.postMessage({ type: 'params', ...latest });
    },
    send(message) {
      node?.port.postMessage(message);
    },
    dispose() {
      node?.disconnect();
      input.disconnect();
      output.disconnect();
      node = null;
    },
  };
}
