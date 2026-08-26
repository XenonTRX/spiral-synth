// The subscribe/notify pair, written once.
//
// Six modules had grown their own copy - a `Set`, a loop that calls everything in it, and a
// `subscribe` that hands back the function to undo itself. They were identical apart from what
// gets passed to the listener, which is why this takes rest arguments rather than fixing an
// arity: `grid` and `meter` notify with nothing, `time-scale` and `song` with one value,
// `settings` with a key and a value.
//
// Iteration is a plain `for...of` over the `Set`, which is what all six were doing and is worth
// keeping deliberately. A listener that unsubscribes while the set is being walked is simply not
// visited if it has not been reached yet - the behaviour these modules already relied on.

/**
 * A set of listeners, and the two things anyone does with one.
 *
 * `subscribe` returns the function that removes the listener again.
 */
export function createListeners() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of listeners) fn(...args);
    },
  };
}
