// The effects on a part, and the ones on everything.
//
// Two chains, one panel, because they are the same object twice and the difference between them is a
// single argument - `null` for the master. Splitting them into two panels would have meant two copies
// of the add/remove/reorder machinery and an invitation for them to drift.
//
// The order of the list *is* the sound, so it is shown as a list you can move things up and down in
// rather than as a set of boxes. A filter before a compressor is a compressor reacting to a filtered
// signal; a filter after one is a filter on a compressed signal. Nothing in either arrangement is
// wrong, and no interface can guess which you meant, so the only honest thing is to make the order
// visible and easy to change.
//
// Rows are rebuilt when the *shape* of a chain changes and only patched otherwise, the same rule the
// rack and the synth panel follow: replacing a live element ends any drag on it, and the drag is the
// whole point of a slider.

import { CHANGE } from './song.js';
import { MAX_EFFECTS, effectList, getEffect } from './effects.js';
import { buildParamRow, showParamActive, showParamValue } from './param-controls.js';

/** What the chain looked like when its rows were built. A knob moving must not appear in this. */
const shapeOf = (slots) => slots.map((slot) => `${slot.type}${slot.bypass ? '-off' : ''}`).join(',');

/**
 * `onChange` is called after anything is edited, structural or not, so the app can push the chains at
 * the audio thread and mark the song dirty. It is deliberately not told *what* changed: the chain
 * reconciles against the whole list anyway.
 */
export function createFxPanel({ song, onChange }) {
  const element = document.createElement('div');
  element.className = 'fx-panel';

  const note = document.createElement('p');
  note.className = 'dropdown-panel__note';
  note.textContent =
    'Effects run top to bottom, so the order is part of the sound. A part\'s chain sits between its instrument and the mix; the master chain sits between the mix and the limiter, which is always last and cannot be moved.';

  function buildSection(trackId, title, subtitle) {
    const section = document.createElement('section');
    section.className = 'fx-section';

    const heading = document.createElement('div');
    heading.className = 'fx-section__heading';
    const name = document.createElement('h3');
    name.textContent = title;
    const hint = document.createElement('span');
    hint.className = 'fx-section__hint';
    hint.textContent = subtitle;

    const add = document.createElement('select');
    add.className = 'fx-add';
    heading.append(name, hint, add);

    const list = document.createElement('div');
    list.className = 'fx-list';

    const empty = document.createElement('p');
    empty.className = 'fx-empty';
    empty.textContent = 'Nothing in the chain.';

    section.append(heading, list, empty);

    // A select rather than a button, because the choice and the action are one gesture. It shows a
    // placeholder and snaps back to it, so it reads as a menu rather than as a setting.
    const rebuildAdd = () => {
      add.replaceChildren();
      const placeholder = new Option('+ Add', '');
      placeholder.disabled = true;
      placeholder.selected = true;
      add.appendChild(placeholder);
      for (const definition of effectList()) add.appendChild(new Option(definition.name, definition.id));
    };
    rebuildAdd();
    add.addEventListener('change', () => {
      const type = add.value;
      add.selectedIndex = 0;
      if (!type) return;
      song.addEffect(trackId, type);
      onChange?.();
    });

    return { section, list, empty, add, rows: new Map(), shape: null };
  }

  /** One effect: what it is, whether it is on, where it is in the order, and its own knobs. */
  function buildSlot(trackId, index, slot) {
    const definition = getEffect(slot.type);
    const card = document.createElement('div');
    card.className = 'fx-slot';

    const head = document.createElement('div');
    head.className = 'fx-slot__head';

    const power = document.createElement('button');
    power.type = 'button';
    power.className = 'fx-slot__power';
    power.textContent = '⏻';
    power.title = 'Take this effect out of the chain, without losing its settings';
    power.addEventListener('click', () => {
      song.toggleEffectBypass(trackId, index);
      onChange?.();
    });

    const name = document.createElement('span');
    name.className = 'fx-slot__name';
    name.textContent = definition?.name ?? slot.type;

    const summary = document.createElement('span');
    summary.className = 'fx-slot__summary';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'fx-slot__move';
    up.textContent = '↑';
    up.title = 'Earlier in the chain';
    up.addEventListener('click', () => {
      song.moveEffect(trackId, index, -1);
      onChange?.();
    });

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'fx-slot__move';
    down.textContent = '↓';
    down.title = 'Later in the chain';
    down.addEventListener('click', () => {
      song.moveEffect(trackId, index, 1);
      onChange?.();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fx-slot__remove';
    remove.textContent = '×';
    remove.title = 'Remove this effect';
    remove.addEventListener('click', () => {
      song.removeEffect(trackId, index);
      onChange?.();
    });

    head.append(power, name, summary, up, down, remove);

    const presets = document.createElement('div');
    presets.className = 'fx-slot__presets';
    for (const preset of definition?.presets ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--ghost btn--small';
      button.textContent = preset.name;
      button.addEventListener('click', () => {
        song.setEffectPreset(trackId, index, preset.state);
        onChange?.();
      });
      presets.appendChild(button);
    }

    const rows = document.createElement('div');
    rows.className = 'fx-slot__rows';
    const controls = new Map();
    const showSummary = () => {
      summary.textContent = definition?.summary?.(slot.state) ?? '';
    };
    // Values are deliberately not touched here - only which rows are live. See showParamActive.
    const showActive = () => {
      for (const control of controls.values()) showParamActive(control, slot.state);
    };
    for (const param of definition?.params ?? []) {
      const control = buildParamRow(param, {
        onChange: (value) => {
          // Straight into the live state, like the synth panel's knobs and for the same reason: a
          // setter that copied and emitted would re-render this slider mid-drag and end the drag.
          slot.state[param.key] = value;
          // Only the summary and the enabled states, not the section: re-rendering would write to the
          // very slider being dragged. The summary was stale for a while - the audio followed the knob
          // and the words did not, which is the worst way round for a readout to be wrong - and the
          // enabled states have to follow too, because choosing a filter shape or a delay division is
          // exactly what decides whether the knob two rows down means anything.
          showSummary();
          showActive();
          onChange?.();
        },
      });
      controls.set(param.key, control);
      rows.appendChild(control.row);
    }

    card.append(head, presets, rows);
    return { card, power, summary, up, down, controls, definition, showSummary };
  }

  function updateSlot(refs, slot, index, total) {
    refs.card.classList.toggle('fx-slot--off', slot.bypass === true);
    refs.power.classList.toggle('is-on', !slot.bypass);
    refs.summary.textContent = refs.definition?.summary?.(slot.state) ?? '';
    refs.up.disabled = index === 0;
    refs.down.disabled = index === total - 1;
    for (const [key, control] of refs.controls) showParamValue(control, slot.state[key], slot.state);
  }

  function renderSection(section, trackId) {
    const slots = song.getEffects(trackId);
    const shape = shapeOf(slots);
    if (shape !== section.shape) {
      section.list.replaceChildren();
      section.rows.clear();
      slots.forEach((slot, index) => {
        const refs = buildSlot(trackId, index, slot);
        section.rows.set(index, refs);
        section.list.appendChild(refs.card);
      });
      section.shape = shape;
    }
    slots.forEach((slot, index) => {
      const refs = section.rows.get(index);
      if (refs) updateSlot(refs, slot, index, slots.length);
    });
    section.empty.hidden = slots.length > 0;
    section.add.disabled = slots.length >= MAX_EFFECTS;
    section.add.title = slots.length >= MAX_EFFECTS ? `${MAX_EFFECTS} is the limit` : 'Add an effect to this chain';
  }

  // The part's chain is rebuilt when the active part changes, because every handler in it closes over
  // a track id. The master's never is.
  let partSection = null;
  let partTrackId = null;
  const masterSection = buildSection(null, 'Master', 'everything, before the limiter');

  function render() {
    const track = song.activeTrack();
    if (track && partTrackId !== track.id) {
      partSection = buildSection(track.id, '', '');
      partTrackId = track.id;
      element.replaceChildren(partSection.section, masterSection.section, note);
    } else if (!partSection) {
      element.replaceChildren(masterSection.section, note);
    }
    if (track && partSection) {
      partSection.section.querySelector('h3').textContent = track.name;
      partSection.section.querySelector('.fx-section__hint').textContent = 'this part only';
      renderSection(partSection, track.id);
    }
    renderSection(masterSection, null);
  }

  song.subscribe((kind) => {
    if (kind === CHANGE.TRACKS) render();
  });
  render();

  return { element, refresh: render };
}
