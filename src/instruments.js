// What an instrument is, and how a part says which one it wants.
//
// The old arrangement had a voice described in three places that had to agree: a slider in the
// HTML, an entry in a table in main.js, and a clamp in audio.js. They already disagreed - the
// cutoff slider stopped at 12kHz while the clamp allowed 20k - which was harmless only because
// nothing yet depended on the two meaning the same thing. Adding a second instrument would have
// meant a second copy of all three, and the disagreements would stop being harmless.
//
// So a parameter is described once, here, and everything else is derived from that description:
// the control in the panel, the default a new part gets, the clamp a save from an older version
// is read through, and the range the analyser sweeps. A new instrument is a list of these plus a
// function that makes sound. It is not an edit to song.js, storage.js or the panel.
//
// This is deliberately close in shape to what a Web Audio Module plugin declares, because that is
// where this is going. Adopting that shape costs nothing while there is one instrument and saves
// the rewrite when there are several.

import { MOD_SOURCE_PARAMS, modTargetParams, sanitizeMatrix } from './modulation.js';
import { sanitizeFromParams, stateFromParams } from './param-state.js';

// The knob descriptors live in params.js and are re-exported here, so that every instrument keeps
// importing them from the one place it always has. They moved because modulation.js declares knobs
// of its own and this file has to read a saved routing matrix, which the two of them together would
// otherwise make into an import cycle.
export {
  choiceParam,
  exponentialStageAt,
  holdParamAt,
  levelParam,
  linearStageAt,
  numberParam,
  paramToUnit,
  unitToParam,
} from './params.js';

const registry = new Map();

/**
 * The plain harmonic series of `f0`, which is what most things are asked to produce.
 *
 * Here rather than in analysis.js so that an instrument can describe its own spectrum without
 * importing the thing that measures it. Most instruments that produce something other than a
 * plain harmonic series still want to start from this and add to it.
 */
export function harmonicSeries(f0, nyquist) {
  const partials = [];
  for (let n = 1; n * f0 < nyquist; n++) partials.push(n * f0);
  return partials;
}

/**
 * Register an instrument.
 *
 * `create(ctx, destination)` returns a live instance; `presets` are the voices a new part is
 * given in turn, so adding one produces something audibly its own before you touch a control.
 * Anything else an instrument chooses to declare - a `badge` for the rack, a `measurement` for
 * the scope - is carried through untouched.
 *
 * Spreading rather than naming the fields, because naming them means this function is a second
 * list of what an instrument may have, and a definition that declares something not on the list
 * loses it silently. Which is exactly what happened: the rack quietly fell back to showing the
 * instrument's name because its `badge` had been dropped on the way into the registry, and
 * nothing failed - it just stopped saying what it was supposed to say.
 */
export function defineInstrument(spec) {
  const definition = { presets: [], ...spec };
  // An instrument that declares even one modulatable knob gets the modulation sources' own knobs
  // appended to its parameter list. Appended rather than handled specially, so that every piece of
  // machinery already built - the defaults, the sanitiser, the save format, the panel - carries an
  // LFO rate without being taught what one is. The instrument does not list them and cannot forget
  // to; declaring a destination is the whole of opting in.
  if (definition.params?.some((param) => param.mod)) {
    definition.params = [...definition.params, ...MOD_SOURCE_PARAMS];
    definition.modTargets = modTargetParams(definition).map((param) => param.key);
  }
  registry.set(definition.id, definition);
  return definition;
}

export function getInstrument(id) {
  return registry.get(id) ?? null;
}

/**
 * Whether one of this instrument's notes can slide into the next.
 *
 * Opt-*out*, and deliberately: an instrument that says nothing plays pitches, which is what all but
 * one of them do, and a new one should not have to declare something to get behaviour it was always
 * going to have. The kit declines - see instruments/drums.js.
 */
export function instrumentSlides(id) {
  return getInstrument(id)?.slides !== false;
}

export function instrumentList() {
  return [...registry.values()];
}

/** The first one registered - what a part gets when nothing says otherwise. */
export function defaultInstrumentId() {
  return registry.keys().next().value ?? null;
}

export function defaultState(id, overrides) {
  const definition = registry.get(id);
  if (!definition) return {};
  const base = stateFromParams(definition.params, undefined);
  // Nothing routed anywhere, so an instrument that gained a matrix sounds exactly as it did before it
  // had one. A preset can override this with routings of its own.
  if (definition.modTargets) base.mod = [];
  const next = { ...base, ...overrides };
  // Never the preset's own array. A preset object is module-level and shared by every part that has
  // ever been given it, so handing the live state a reference to it would mean editing one part's
  // routings edited them everywhere, and the next new part would start from someone else's edits.
  if (Array.isArray(next.mod)) next.mod = next.mod.map((routing) => ({ ...routing }));
  return next;
}

/**
 * A saved state read as a suggestion rather than as data.
 *
 * The rules are in param-state.js because effects keep the same promise about the same kind of
 * declaration. What is here is the part song.js could not do on an instrument's behalf: it does not
 * know what a particular instrument's fields mean and, once these are plugins, will not have the
 * option of finding out. So the promise is kept by delegation - each instrument checks its own
 * state, and the boundary catches anything that throws while trying. An instrument that cannot read
 * its own save gets a working default, which is the same outcome a missing field has always had.
 */
export function sanitizeState(id, raw) {
  const definition = registry.get(id);
  if (!definition) return {};
  const state = sanitizeFromParams(definition.params, raw, defaultState(id));
  if (!raw || typeof raw !== 'object') return state;
  // The matrix is the one part of a state that is not a knob, so it is read by the one thing that
  // knows what a routing is. A routing naming a source or a destination this build no longer has is
  // dropped rather than defaulted - see sanitizeMatrix for why that is the odd one out.
  if (definition.modTargets) state.mod = sanitizeMatrix(raw.mod, definition);
  return state;
}

/** The instrument a part names, or the default if it names one this build has never heard of. */
export function resolveInstrument(rawType) {
  if (typeof rawType === 'string' && registry.has(rawType)) return rawType;
  return defaultInstrumentId();
}
