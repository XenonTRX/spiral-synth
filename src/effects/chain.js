// A row of effects between one point and another.
//
// The chain's two endpoints exist for as long as the chain does and are never replaced, which is the
// whole design. An instrument connects to `input` when it is built and never hears about it again;
// the bus connects `output` once. Everything else - adding an effect, removing one, dragging one up
// the list, switching one off - happens strictly *inside*, by rewiring between those two nodes. So
// none of it can strand a voice mid-note or leave a part connected to something that has been thrown
// away, which are the two bugs a naive "disconnect and rebuild" version has.
//
// Rebuilt from the state rather than mutated by instructions. The panel does not tell the chain
// "insert a reverb at index 1"; it changes the part's saved list and the chain reconciles against it.
// That is the same choice the rack made about note counts and undo made about tracks, and for the same
// reason: undo replaces the whole list at once, and there is no sequence of insert/remove calls that
// could be derived from that reliably.

import { getEffect } from '../effects.js';

/** What the live chain is currently wired for, so it is only rewired when it has to be. */
const signatureOf = (slots) => slots.map((slot) => `${slot.type}${slot.bypass ? ':off' : ''}`).join('>');

export function createEffectChain(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);

  // [{ type, instance }] in chain order, bypassed slots included - a bypassed effect keeps its
  // instance so that switching it back on does not rebuild a worklet and lose the tail of whatever
  // it was doing. It is simply not wired in.
  let live = [];
  let wiredFor = null;

  function rewire() {
    input.disconnect();
    for (const entry of live) entry.instance.output.disconnect();
    let from = input;
    for (const entry of live) {
      if (entry.bypass) continue;
      from.connect(entry.instance.input);
      from = entry.instance.output;
    }
    from.connect(output);
  }

  return {
    input,
    output,

    /**
     * Make the live chain match `slots`, and push every effect its state.
     *
     * Called on every note as well as on every edit, because the state is written in place by the
     * panel and replaced wholesale by undo, and neither announces which field moved - the same reason
     * the instrument pool pushes an instrument's state every time it plays a note.
     */
    setEffects(slots) {
      const wanted = Array.isArray(slots) ? slots : [];
      const signature = signatureOf(wanted);
      if (signature !== wiredFor) {
        // Anything whose type no longer occupies its slot is gone. Kept by position rather than by
        // identity because a slot has no id - it is a place in a list, and two reverbs in a row are
        // genuinely interchangeable.
        const previous = live;
        const next = [];
        for (let i = 0; i < wanted.length; i++) {
          const slot = wanted[i];
          const definition = getEffect(slot.type);
          if (!definition) continue;
          const reusable = previous[i]?.type === slot.type ? previous[i] : null;
          if (reusable) {
            reusable.bypass = slot.bypass === true;
            next.push(reusable);
            previous[i] = null;
          } else {
            next.push({
              type: slot.type,
              bypass: slot.bypass === true,
              instance: definition.create(ctx),
            });
          }
        }
        for (const entry of previous) entry?.instance.dispose();
        live = next;
        wiredFor = signature;
        rewire();
      }
      // The state is kept on the entry as well as pushed, so that anything else which needs it later -
      // the automation below - does not have to index back into `wanted` and hope the two lists line up.
      // They do line up today, because an unknown effect type is dropped by the sanitiser long before
      // it gets here, but that is a guarantee made in another file and this is one fewer place relying
      // on it.
      for (let i = 0; i < live.length; i++) {
        live[i].state = wanted[i].state ?? {};
        live[i].instance.setState(live[i].state);
      }
    },

    /**
     * Hand one window of song time to any effect in the chain that has something that moves.
     *
     * Optional on an effect, and only one has it so far - see the filter's sweep. The four worklet
     * effects cannot take part yet for a concrete reason worth writing down: their parameters travel
     * as port messages rather than as AudioParams, and only an AudioParam can be handed a curve. Giving
     * them `parameterDescriptors` is the work that would open this up, and none of it changes here.
     *
     * Bypassed slots are skipped, because an effect that is not in the chain should not be quietly
     * moving; its state is untouched, so switching it back on picks up from the current position.
     */
    scheduleAutomation(window) {
      for (const entry of live) {
        if (entry.bypass) continue;
        entry.instance.schedule?.(entry.state ?? {}, window);
      }
    },

    /** Everything that moves, back to its knob, after `afterTime`. What stopping the transport means. */
    restAutomation(afterTime) {
      for (const entry of live) entry.instance.restAutomation?.(afterTime);
    },

    /** Everything in the chain is really in the chain - only a render needs to wait for this. */
    ready() {
      return Promise.all(live.map((entry) => entry.instance.ready?.() ?? Promise.resolve()));
    },

    dispose() {
      for (const entry of live) entry.instance.dispose();
      live = [];
      wiredFor = null;
      input.disconnect();
      output.disconnect();
    },
  };
}
