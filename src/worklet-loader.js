// Loading a processor module, once per context.
//
// This is eight lines that had been written three times - once in each worklet instrument - and the
// limiter would have been the fourth. Three copies of eight lines is a shrug; four is a decision, and
// the decision is worth making because all four copies have the same two non-obvious properties and
// nothing about them says so.
//
// **Per context, not per page.** `addModule` is a method on a context's `audioWorklet`, so a module
// loaded into the live context is not loaded into the OfflineAudioContext the scope or the exporter
// builds. Every render is a new context that has to load again.
//
// **A WeakMap, not a Map.** A measurement builds a context, renders, and throws it away. Holding one
// alive to remember a boolean would be a leak that grows every time you press Measure - which, at
// one context per keystroke while dragging a knob, is a lot of contexts.
//
// The `ready` flag beside the promise is not redundant either. A caller that can await does
// (`prepare`); a caller that cannot needs to know synchronously whether it may build the node right
// now, because "already loaded" and "loading" lead to genuinely different code paths - see the note
// on `commit` in instruments/ladder.js.

const byContext = new WeakMap();

/**
 * Start loading `url` into `ctx` if nothing has yet, and hand back the same entry to everyone.
 *
 * `{ ready, promise }`, where `ready` is true once the module is there.
 */
export function loadWorklet(ctx, url) {
  let modules = byContext.get(ctx);
  if (!modules) {
    modules = new Map();
    byContext.set(ctx, modules);
  }
  let entry = modules.get(url);
  if (!entry) {
    entry = { ready: false, promise: null };
    entry.promise = ctx.audioWorklet.addModule(url).then(() => {
      entry.ready = true;
    });
    modules.set(url, entry);
  }
  return entry;
}
