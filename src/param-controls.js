// One knob, as a control.
//
// Extracted from synth-panel.js when the effects panel needed the same thing. Both build rows from
// descriptors declared with params.js, and the fiddly parts are the ones that are easy to get subtly
// wrong twice: a select that reads back the *declared* value rather than the string of it, a slider
// that quantises to the parameter's own step rather than the slider's, and a readout that never writes
// to a control the pointer is holding.

import { paramToUnit, unitToParam } from './params.js';

// Sliders work in whole steps, so a fractional parameter needs somewhere to put its precision. A
// thousand is finer than the eye on a 200px control and finer than the ear on all of these.
export const UNIT_STEPS = 1000;

/** The value a slider position means, quantised the way the parameter asks rather than as it likes. */
export function valueForUnit(param, unit) {
  let value = unitToParam(param, unit);
  // A declared step is the resolution the parameter is meant to have; the slider's own is an artefact
  // of it being a slider. Only a linear parameter gets it: a fixed step means something different at
  // each end of a logarithmic range, and in decibels it would be 0.09dB at the top of a level control
  // and 12dB near the bottom - the same mistake a linear taper makes, in miniature.
  const linear = !param.scale || param.scale === 'linear';
  if (param.step && linear) value = Math.round(value / param.step) * param.step;
  return Math.max(param.min, Math.min(param.max, value));
}

/** And the position a value sits at, in whole slider steps. */
export function unitForValue(param, value) {
  return Math.round(paramToUnit(param, value) * UNIT_STEPS);
}

/** `{ param, row, input, readout }`. `onChange` is called with the parameter's value, not the DOM's. */
export function buildParamRow(param, { onChange, className = 'synth-row' } = {}) {
  const row = document.createElement('div');
  row.className = className;

  const label = document.createElement('label');
  label.textContent = param.label;
  if (param.help) label.title = param.help;
  row.appendChild(label);

  if (param.kind === 'choice') {
    const select = document.createElement('select');
    for (const choice of param.choices) {
      const option = document.createElement('option');
      option.value = String(choice.value);
      option.textContent = choice.label;
      if (choice.help) option.title = choice.help;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      // The declared value, not the DOM's string of it. A select always reads back a string, and a
      // choice whose values are numbers - FM's ratio, say - would otherwise store "2" where the
      // declaration says 2. Nothing would fail until the next reload, when the sanitiser compares it
      // against the declared choices, finds no match, and quietly resets the parameter to its default.
      const chosen = param.choices.find((choice) => String(choice.value) === select.value);
      if (chosen) onChange?.(chosen.value);
    });
    row.appendChild(select);
    return { param, row, input: select, readout: null };
  }

  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = String(UNIT_STEPS);
  input.step = '1';
  if (param.help) input.title = param.help;

  const readout = document.createElement('span');
  readout.className = 'synth-row__value';

  input.addEventListener('input', () => {
    const value = valueForUnit(param, Number(input.value) / UNIT_STEPS);
    readout.textContent = param.format ? param.format(value) : String(value);
    onChange?.(value);
  });

  row.append(input, readout);
  return { param, row, input, readout };
}

/**
 * Grey out a row whose knob currently does nothing. See `activeWhen` in params.js.
 *
 * Separate from `showParamValue` because it is the half that is safe to call during a drag. Writing a
 * *value* onto a control the pointer is holding fights the pointer - and it would, even here: a
 * stepped parameter quantises, so the position that comes back out of a slider is not always the
 * position that went in, and refreshing every row on every input event would nudge the thumb under
 * the finger. Toggling `disabled` on the *other* rows cannot do that.
 */
export function showParamActive(control, state) {
  const { param, row, input } = control;
  if (!state || !param.activeWhen) return;
  const active = param.activeWhen(state) !== false;
  // Disabled rather than hidden: a knob that vanishes takes the layout with it, and the setting that
  // made it inert is usually one row above and about to be changed back.
  input.disabled = !active;
  row.classList.toggle('synth-row--inactive', !active);
}

/**
 * Show a value on a row built above, without disturbing a control being dragged.
 *
 * `state` is the whole of the thing being edited, and is only used for `activeWhen`. Optional, so a
 * caller with nothing to ask does not have to invent one.
 */
export function showParamValue(control, value, state = null) {
  const { param, input, readout } = control;
  showParamActive(control, state);
  if (param.kind === 'choice') {
    if (input.value !== String(value)) input.value = String(value);
    return;
  }
  // Only when it differs: writing to a range input mid-drag fights the pointer.
  const unit = String(unitForValue(param, value));
  if (input.value !== unit) input.value = unit;
  readout.textContent = param.format ? param.format(value) : String(value);
}
