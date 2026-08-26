// What an effect is, and how a part says which ones it has.
//
// Deliberately the same shape as instruments.js, because it is the same problem twice: a thing with
// declared parameters, a live half holding audio nodes, saved state that has to be read back as a
// suggestion, and a panel generated from the declaration rather than written by hand. Everything that
// was built for instruments - params.js, param-state.js, the control rows, the save rules - is reused
// here rather than reinvented, and the parts that genuinely differ are worth naming:
//
//   - **An effect processes rather than plays.** `create` hands back an `input` and an `output`
//     instead of a `noteOn`, and nothing about notes reaches it.
//   - **There are several at once, in an order.** An instrument is one per part; effects are a list,
//     and the list's order is part of the sound - a filter before a compressor is not a filter after
//     one. So the state a part saves is an array, and moving an entry is an edit.
//   - **Any of them can be turned off.** A bypass is not a parameter, it is a property of the slot:
//     it takes the effect out of the chain entirely rather than setting it to do nothing, because
//     "do nothing" is not something every effect can be asked for.

import { sanitizeFromParams, stateFromParams } from './param-state.js';

const registry = new Map();

/**
 * Register an effect.
 *
 * `create(ctx)` returns `{ input, output, setState, ready?, dispose }`. The two endpoints must exist
 * from the moment it returns and must not be replaced afterwards, because the chain wires to them
 * once - which is what lets an effect whose real work happens in a worklet splice the processor in
 * when it loads without anything upstream knowing (see worklet-effect.js).
 *
 * Spread rather than named, for the reason defineInstrument gives: naming the fields makes this a
 * second list of what an effect may have, and one that declares something not on the list loses it
 * silently.
 */
export function defineEffect(spec) {
  const definition = { ...spec };
  registry.set(definition.id, definition);
  return definition;
}

export function getEffect(id) {
  return registry.get(id) ?? null;
}

export function effectList() {
  return [...registry.values()];
}

export function defaultEffectState(type, overrides) {
  const definition = registry.get(type);
  return definition ? stateFromParams(definition.params, overrides) : {};
}

export function sanitizeEffectState(type, raw) {
  const definition = registry.get(type);
  if (!definition) return {};
  return sanitizeFromParams(definition.params, raw, defaultEffectState(type));
}

/**
 * One saved slot, or null if this build has never heard of the effect.
 *
 * Null rather than a default, which is the opposite of how a saved *instrument* is read, and the
 * difference is what the two are. A part must have an instrument, so an unknown one falls back to
 * something that makes a sound. A part need not have any effects at all, and there is no sensible
 * substitute for a reverb this build does not have - inventing one would put a sound in the song that
 * nobody asked for. So it is dropped, the same way a modulation routing naming a missing destination
 * is dropped.
 */
export function sanitizeEffectSlot(raw) {
  const type = raw?.type;
  if (typeof type !== 'string' || !registry.has(type)) return null;
  return {
    type,
    state: sanitizeEffectState(type, raw.state),
    bypass: raw.bypass === true,
  };
}

/** How many slots one chain may hold. A limit that exists so a corrupt save cannot ask for 40,000. */
export const MAX_EFFECTS = 8;
