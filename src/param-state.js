// Turning a list of knob descriptions into a state object, and reading a saved one back.
//
// This was inside instruments.js, where it read a *registered instrument's* params. Effects have
// params too, declared with the same helpers from params.js and saved into the same document, and the
// rules for reading a saved one back are not merely similar - they have to be identical, because they
// are the whole of what this project promises about an old save. So the rules live here, once, and
// the two registries each apply them to their own descriptors.

/** Every knob at its default, then whatever the caller wants to override. */
export function stateFromParams(params, overrides) {
  const state = {};
  for (const param of params) state[param.key] = param.def;
  return { ...state, ...overrides };
}

/**
 * A saved state read as a suggestion rather than as data.
 *
 * This is the same promise the rest of the app makes about saves - parse it, check every field
 * against what today's code expects, drop anything unreadable in favour of the default.
 */
export function sanitizeFromParams(params, raw, state) {
  if (!raw || typeof raw !== 'object') return state;
  for (const param of params) {
    const value = raw[param.key];
    if (param.kind === 'choice') {
      // Matched loosely and stored as the *declared* value, so a choice whose values are numbers
      // survives having been through anything that stringifies - a form control, a URL, someone
      // hand-editing a save. Only a value that names a real choice is accepted either way; this
      // just declines to throw one away over its type, which is the same spirit as the rest of the
      // loading rules. What comes out is always the declaration's own value.
      const chosen = param.choices.find((choice) => String(choice.value) === String(value));
      if (chosen) state[param.key] = chosen.value;
      continue;
    }
    const number = Number(value);
    // Web Audio answers a NaN or a negative envelope time with a thrown exception rather than an odd
    // noise, so this is the difference between an old save sounding wrong and it not loading at all.
    if (Number.isFinite(number)) state[param.key] = Math.max(param.min, Math.min(param.max, number));
  }
  return state;
}
