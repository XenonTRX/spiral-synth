// The spiral, bound to the cursor.
//
// This is the answer to the thing the experiments settled: the spiral is very good at chords
// and very bad at time. It spends a whole plane to say one number, and it spends most of that
// plane drawing the thirty-three notes that are *not* sounding, so a lane of them runs out of
// room after about a bar. Give the time axis to a piano roll and the spiral has nothing left to
// carry but the vertical slice under the cursor - which is exactly the case it is best at, and
// it only has to be drawn once.
//
// So: the roll says when, the spiral says what. Move the cursor and the spiral re-reads; edit
// on the spiral and the roll re-draws. Both are editing the same notes.

import { createSpiralView, emptyFrame } from './views/spiral-view.js';
import { REF_INDEX } from './song.js';
import { TOTAL_NOTES } from './spiral-geometry.js';
import {
  isNamedLength,
  keyContextLabel,
  labelForBeats,
  midiToFreq,
  noteName,
  octaveFromMidi,
  pcFromMidi,
  scaleById,
  scaleDegree,
  titleForBeats,
} from './music-theory.js';
import { positionLabel } from './meter.js';
import { audition, toggleNoteAt } from './edits.js';
import { createChordTools } from './chord-tools.js';
import { createNoteTools } from './note-tools.js';

export function createSpiralPanel({ song, getBpm }) {
  const element = document.createElement('section');
  element.className = 'spiral-panel';
  element.innerHTML = `
    <header class="spiral-panel__header">
      <div class="spiral-panel__at">
        <span class="spiral-panel__label">At</span>
        <strong class="spiral-panel__position"></strong>
        <span class="spiral-panel__key"></span>
      </div>
      <div class="octave-control" title="Which three octaves the spiral shows">
        <button type="button" class="spiral-panel__oct-down">&minus;</button>
        <span class="spiral-panel__range"></span>
        <button type="button" class="spiral-panel__oct-up">+</button>
      </div>
    </header>
    <div class="spiral-panel__stage"></div>
    <footer class="spiral-panel__footer">
      <div class="spiral-panel__readout">
        <span class="spiral-panel__label">Cursor</span>
        <strong class="spiral-panel__cursor-note"></strong>
      </div>
      <div class="spiral-panel__readout">
        <span class="spiral-panel__label">New note</span>
        <strong class="spiral-panel__new-length"></strong>
      </div>
      <div class="spiral-panel__readout spiral-panel__readout--wide">
        <span class="spiral-panel__label">Sounding</span>
        <strong class="spiral-panel__sounding"></strong>
      </div>
    </footer>
  `;

  const stage = element.querySelector('.spiral-panel__stage');
  const positionEl = element.querySelector('.spiral-panel__position');
  const keyEl = element.querySelector('.spiral-panel__key');
  const rangeEl = element.querySelector('.spiral-panel__range');
  const cursorNoteEl = element.querySelector('.spiral-panel__cursor-note');
  const newLengthEl = element.querySelector('.spiral-panel__new-length');
  const soundingEl = element.querySelector('.spiral-panel__sounding');

  // What the one note you have picked *is*, under the readouts saying what sounds where you are.
  // Above the palette rather than below it, because the two are in the order you work in: this is
  // about the note you just clicked, and the palette is about what to build next.
  const noteTools = createNoteTools({ song, getBpm });
  element.appendChild(noteTools.element);

  // The chord palette lives here rather than in a sidebar of its own: it is rooted on the same
  // cursor the spiral reads, and it is documentation and control at once, so it belongs under
  // the drawing it documents.
  const chordTools = createChordTools({ song, getBpm });
  element.appendChild(chordTools.element);

  element
    .querySelector('.spiral-panel__oct-down')
    .addEventListener('click', () => song.setRefOctave(song.getRefOctave() - 1));
  element
    .querySelector('.spiral-panel__oct-up')
    .addEventListener('click', () => song.setRefOctave(song.getRefOctave() + 1));

  // The note being dragged, by id rather than by slot: the drag moves it, so the slot it is on
  // changes under the gesture while its identity does not.
  let dragging = null;

  // Every edit made here starts by moving the cursor to the slot it happened on, so the mouse
  // and the keyboard never disagree about where you are.
  function pointCursorAt(midi) {
    song.setPitchCursor(midi);
  }

  const view = createSpiralView({
    sizeKey: 'large',
    gestures: {
      // A click creates or removes; only a drag moves. The two have opposite outcomes on the
      // same slot, which is exactly why the view makes the pointer travel a few units before
      // it will call a press a drag.
      toggle(n) {
        const midi = song.midiForSlot(n);
        pointCursorAt(midi);
        // A note made here starts at the cursor and lasts the shortest thing already sounding
        // there - which is the whole reason the spiral needs no time axis of its own.
        toggleNoteAt(song, { midi, beat: song.getCursor(), bpm: getBpm() });
      },

      dragStart(n) {
        const track = song.activeTrack();
        const note = track && song.noteAtPitch(song.getCursor(), song.midiForSlot(n), track.id);
        if (!note) return;
        song.pushUndo();
        dragging = { trackId: track.id, id: note.id };
        song.setSelection([note.id]);
      },

      dragTo(_from, to) {
        if (!dragging) return;
        const midi = song.midiForSlot(to);
        const moved = song.updateNote(dragging.trackId, dragging.id, { midi });
        if (!moved) return;
        view.setDragTarget(to);
        pointCursorAt(midi);
        audition(song.activeTrack(), midi);
      },

      dragEnd(_from, to) {
        dragging = null;
        view.setDragTarget(null);
        pointCursorAt(song.midiForSlot(to));
      },
    },
  });
  stage.appendChild(view.element);

  // --- frame ----------------------------------------------------------------------------------

  // What sounds at the cursor, split into the track you are editing and everything else. The
  // rest of the arrangement comes back as ghosts rather than as fills, because the spiral has
  // no way to show *whose* note a slot is and a lit slot you cannot edit would be a lie.
  function buildFrame() {
    const frame = emptyFrame();
    const cursor = song.getCursor();
    const context = song.keyAt(cursor);
    const scale = scaleById(context.scaleId);
    const track = song.activeTrack();
    const sounding = song.notesAt(cursor);

    const mine = new Map();
    const others = new Set();
    for (const { track: owner, note } of sounding) {
      if (track && owner.id === track.id) mine.set(note.midi, note);
      else others.add(note.midi);
    }

    frame.explicit = context.explicit;
    for (let n = 0; n < TOTAL_NOTES; n++) {
      const midi = song.midiForSlot(n, cursor);
      const pc = pcFromMidi(midi);
      const note = mine.get(midi);
      const degree = scaleDegree(scale, n - REF_INDEX);
      const parts = [noteName(octaveFromMidi(midi), pc), `${midiToFreq(midi).toFixed(1)} Hz`];
      if (note) parts.push(labelForBeats(note.length));
      if (context.explicit) parts.push(degree === null ? 'outside key' : `degree ${degree}`);

      frame.slots[n] = {
        pc,
        active: Boolean(note),
        ghost: others.has(midi),
        degree,
        title: parts.join(' · '),
      };
    }
    return { frame, sounding, context, cursor };
  }

  // Re-rendering on every cursor move would be wasteful while the playhead is running - the
  // cursor changes sixty times a second and the drawing changes only when a note starts or
  // stops. So the frame gets a signature, and an identical one is skipped.
  let signature = null;

  function frameSignature({ frame, context }) {
    let key = `${context.tonicPc}:${context.scaleId}:${context.explicit}:${song.getRefOctave()}`;
    for (let n = 0; n < TOTAL_NOTES; n++) {
      const slot = frame.slots[n];
      key += slot.active ? 'A' : slot.ghost ? 'g' : '.';
    }
    return key;
  }

  function renderReadouts({ sounding, context, cursor }) {
    positionEl.textContent = positionLabel(cursor);
    keyEl.textContent = context.explicit ? keyContextLabel(context) : 'no key';
    keyEl.classList.toggle('is-unkeyed', !context.explicit);

    const low = song.midiForSlot(0, cursor);
    const high = song.midiForSlot(TOTAL_NOTES - 1, cursor);
    rangeEl.textContent = `${noteName(octaveFromMidi(low), pcFromMidi(low))}–${noteName(
      octaveFromMidi(high),
      pcFromMidi(high)
    )}`;

    const pitch = song.getPitchCursor();
    cursorNoteEl.textContent = noteName(octaveFromMidi(pitch), pcFromMidi(pitch));

    // Lengths are free, so most of them have no name. Saying so is the whole readout: a real
    // note value when it is one, and `custom` when it isn't, with the exact figure on hover
    // rather than printed as a fraction nobody can read at a glance.
    const length = song.newNoteLength();
    newLengthEl.textContent = labelForBeats(length);
    newLengthEl.title = titleForBeats(length);
    newLengthEl.classList.toggle('is-custom', !isNamedLength(length));

    const track = song.activeTrack();
    const names = sounding
      .filter(({ track: owner }) => track && owner.id === track.id)
      .map(({ note }) => noteName(octaveFromMidi(note.midi), pcFromMidi(note.midi)));
    soundingEl.textContent = names.length ? names.join(' ') : '—';
    soundingEl.classList.toggle('is-empty', names.length === 0);
  }

  function render({ force = false } = {}) {
    const built = buildFrame();
    const next = frameSignature(built);
    if (force || next !== signature) {
      signature = next;
      view.render(built.frame);
    }
    // Cheap enough to always refresh: the cursor outline and the readouts both move with the
    // cursor even when no note started or stopped.
    const slot = song.slotForMidi(song.getPitchCursor());
    view.setCursor(slot >= 0 && slot < TOTAL_NOTES ? slot : null);
    renderReadouts(built);
  }

  song.subscribe(() => render());
  render({ force: true });

  return {
    element,
    refresh: () => {
      render({ force: true });
      noteTools.refresh();
      chordTools.refresh();
    },
  };
}
