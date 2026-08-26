// The selected note, as controls rather than as shortcuts.
//
// Everything a note *is* could already be set, and every route to it was a key or a modifier: `,`
// and `.` for velocity, `S` for a slide, an ⌥-drag, a seven-pixel grip at an edge. That is a fine
// set of routes for someone who has read the shortcut table, a poor one for anyone who has not, and
// no route at all on a machine or in a posture where those keys are awkward. A rectangle you can
// drag is a control; a chord you have to know about is not.
//
// So the two properties with no obvious rectangle of their own get one here. Pitch, start and length
// already have theirs - they *are* the rectangle in the roll - which is why this panel is two rows
// rather than a form with five fields in it.
//
// It sits under the spiral because that is where the app already answers "what is here": the
// readouts above say what sounds at the cursor, and this says what the one note you have picked is.
//
// **Its height does not change.** The controls disable rather than disappear, and the slide's time
// stays on screen while it is off. The alternative was measured against the thing this sidebar has
// been fighting all along - see the header's comment about reflow - and it is the same problem: the
// chord palette lives directly below, and a section that appears when you click a note would shove
// the palette down and back on every click.

import { CHANGE, MAX_SLIDE, MIN_VELOCITY, slideSources } from './song.js';
import { getInstrument, instrumentSlides } from './instruments.js';
import {
  labelForBeats,
  noteName,
  octaveFromMidi,
  pcFromMidi,
  secondsForBeats,
} from './music-theory.js';
import { positionLabel } from './meter.js';
import { toggleSlide } from './edits.js';

export function createNoteTools({ song, getBpm }) {
  const element = document.createElement('section');
  element.className = 'note-tools';
  element.innerHTML = `
    <header class="note-tools__header">
      <span class="spiral-panel__label">Note</span>
      <strong class="note-tools__name"></strong>
      <span class="note-tools__where"></span>
    </header>
    <div class="note-tools__row">
      <span class="spiral-panel__label">Velocity</span>
      <input
        type="range"
        class="note-tools__velocity"
        min="${Math.round(MIN_VELOCITY * 100)}"
        max="100"
        step="1"
        aria-label="How hard the selected note is struck"
      />
      <output class="note-tools__value note-tools__velocity-value"></output>
    </div>
    <div class="note-tools__row">
      <button type="button" class="btn btn--ghost btn--toggle note-tools__slide" aria-pressed="false">Slide</button>
      <input
        type="range"
        class="note-tools__slide-time"
        min="0"
        max="100"
        step="1"
        aria-label="How long the selected note takes to arrive at its pitch"
      />
      <output class="note-tools__value note-tools__slide-value"></output>
    </div>
  `;

  const nameEl = element.querySelector('.note-tools__name');
  const whereEl = element.querySelector('.note-tools__where');
  const velocity = element.querySelector('.note-tools__velocity');
  const velocityValue = element.querySelector('.note-tools__velocity-value');
  const slideBtn = element.querySelector('.note-tools__slide');
  const slideTime = element.querySelector('.note-tools__slide-time');
  const slideValue = element.querySelector('.note-tools__slide-value');

  /**
   * The one note these controls are for.
   *
   * Exactly one, deliberately. Every control here would have to mean something different for a
   * selection of several - a velocity would have to be a nudge rather than a value, or it would
   * flatten the dynamics of everything it touched - and a control whose meaning depends on how many
   * things are selected is worse than one that admits it is waiting. The keys still take a whole
   * passage at once; this is the single note, said plainly.
   */
  function selected() {
    const track = song.activeTrack();
    if (!track) return null;
    const notes = song.selectedNotes();
    return notes.length === 1 ? { track, note: notes[0] } : null;
  }

  /**
   * The longest slide this note can be given: it cannot outlast the note it is on, and it stops at
   * the model's own ceiling.
   *
   * The slider then works in hundredths of *that* rather than in a fixed number of milliseconds,
   * which is what keeps it usable across three orders of magnitude of note. A sixteenth at 100bpm
   * gets 1.5ms per step and a whole note gets 24ms, and that is the right way round: nobody is
   * placing a two-second glide to the millisecond, and a slide into a sixteenth is nothing *but*
   * milliseconds. The readout is in milliseconds either way, because that is what the number means.
   */
  const slideCeiling = (note) => Math.min(note.length, MAX_SLIDE);

  const ms = (beats) => `${Math.round(secondsForBeats(beats, getBpm()) * 1000)}ms`;

  // --- editing ---------------------------------------------------------------------------------

  // One undo entry per gesture rather than per pixel. A range input fires `input` continuously and
  // `change` when the drag ends - and once each, in that order, for every arrow key - so taking the
  // snapshot on the first `input` of an interaction gives a drag one entry and a keypress one entry,
  // which is what `,` and `.` already do.
  let live = null;

  function begin(control) {
    if (live === control) return;
    live = control;
    song.pushUndo();
  }

  // And a redraw on the way out, because the last edit of a gesture may have changed what the
  // controls should *look* like rather than what they say - dragging the time to nothing turns the
  // slide off, and the row it was dragged on has to go grey when the pointer lets go of it. Nothing
  // else would ask: the model did not change on release.
  const release = () => {
    live = null;
    render();
  };

  velocity.addEventListener('input', () => {
    const current = selected();
    if (!current) return;
    begin(velocity);
    song.updateNote(current.track.id, current.note.id, { velocity: Number(velocity.value) / 100 });
  });
  velocity.addEventListener('change', release);

  slideTime.addEventListener('input', () => {
    const current = selected();
    if (!current) return;
    begin(slideTime);
    // Dragged to nothing is a slide taken off, exactly as pulling the ramp in the roll back to the
    // note's own start is - the control disables itself on release, and the toggle beside it is how
    // it comes back. Two ways to do one thing, and they had better agree about what zero means.
    const slide = (Number(slideTime.value) / 100) * slideCeiling(current.note);
    song.updateNote(current.track.id, current.note.id, { slide });
  });
  slideTime.addEventListener('change', release);

  // The same operation the `S` key runs, rather than a second copy of the rule about which notes can
  // slide and what a fresh one is worth - see toggleSlide in edits.js.
  slideBtn.addEventListener('click', () => toggleSlide(song));

  // --- drawing ---------------------------------------------------------------------------------

  function renderEmpty() {
    nameEl.textContent = '—';
    whereEl.textContent = 'select a note';
    velocity.disabled = true;
    velocityValue.textContent = '';
    slideBtn.disabled = true;
    slideBtn.classList.remove('is-on');
    slideBtn.setAttribute('aria-pressed', 'false');
    slideBtn.title = 'Select one note to give it a slide';
    slideTime.disabled = true;
    slideValue.textContent = '';
    // Parked rather than left where the last note put them. A greyed-out thumb sitting two thirds
    // along with no figure beside it still says something, and what it says is about a note that is
    // no longer selected.
    velocity.value = '100';
    slideTime.value = '0';
  }

  function render() {
    const current = selected();
    element.classList.toggle('is-empty', !current);
    if (!current) {
      renderEmpty();
      return;
    }
    const { track, note } = current;

    // The instrument's own name for the pitch where it has one, so a kit part says Snare rather than
    // D2 - the same question the roll's gutter asks.
    const label = getInstrument(track.instrument?.type)?.noteLabel?.(note.midi);
    nameEl.textContent = label ?? noteName(octaveFromMidi(note.midi), pcFromMidi(note.midi));
    // In song time, not the part's own. A panel sitting directly under a readout that says `At 3|3`
    // must not describe the note under that cursor as being at 1|3, which is what the part's private
    // clock would call it.
    whereEl.textContent = `${labelForBeats(note.length)} · at ${positionLabel(note.start + song.trackBegin(track))}`;

    const struck = note.velocity ?? 1;
    velocity.disabled = false;
    // Never while it is the thing being dragged. Writing a value back into a range input mid-drag is
    // the same mistake the synth panel documents at length: the value round-trips through a rounding
    // and the knob fights the hand holding it.
    if (live !== velocity) velocity.value = String(Math.round(struck * 100));
    velocityValue.textContent = `${Math.round(struck * 100)}%`;

    const pitched = instrumentSlides(track.instrument?.type);
    const source = pitched ? slideSources(track.notes).get(note.id) : null;
    const sliding = note.slide > 0 && Boolean(source);

    slideBtn.disabled = !source;
    slideBtn.classList.toggle('is-on', sliding);
    slideBtn.setAttribute('aria-pressed', String(sliding));
    slideBtn.title = source
      ? `Arrive at this pitch from ${noteName(octaveFromMidi(source.midi), pcFromMidi(source.midi))}, instead of starting on it (S)`
      : pitched
        ? 'Nothing is struck before this note, so there is no pitch to arrive from'
        : "This part's instrument has no pitches for a slide to travel between";

    // Left alone while it is being dragged, including the moment it passes through zero: re-reading
    // the model there would disable the control under the pointer and end the drag at the one value
    // you are most likely to be sweeping past.
    if (live !== slideTime) {
      slideTime.disabled = !sliding;
      slideTime.value = String(Math.round((Math.min(note.slide, slideCeiling(note)) / slideCeiling(note)) * 100));
    }
    slideValue.textContent = sliding ? ms(Math.min(note.slide, slideCeiling(note))) : 'off';
    slideValue.classList.toggle('is-off', !sliding);
  }

  song.subscribe((kind) => {
    // Not the cursor: everything here is a property of a note, and moving the cursor changes none of
    // them. It is the one change that happens sixty times a second under Follow playhead.
    if (kind === CHANGE.NOTES || kind === CHANGE.SELECTION || kind === CHANGE.TRACKS) render();
  });
  render();

  return { element, refresh: render };
}
