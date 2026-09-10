// The chord palette, under the spiral.
//
// This used to be a second sidebar, and it was a reference only: nine diagrams that showed what
// each chord type's shape looks like, with a button to hear it. Everything it said was true and
// none of it did anything, so it competed for width with the one panel that does.
//
// Making the diagrams the control collapses the two. A chip is still exactly the drawing it
// always was - flattened to one turn, carrying the same angle guides the spiral draws, so the
// reference figure and the figure at your cursor are the same kind of picture and can be held
// against each other directly. It is now also the button that builds that chord, which means
// the documentation and the thing it documents are the same object: you read the triangle, you
// press the triangle, the triangle appears on the spiral rooted where you are.
//
// That is also the honest test of the claim. The chip shows the shape at an abstract root; the
// spiral shows it at yours. If they are congruent you can see it in one glance across four
// inches of screen, and if they are not, the prototype has failed at the only thing it exists
// to check.

import { CHORD_TYPES, noteName, octaveFromMidi, pcFromMidi, secondsForBeats } from './music-theory.js';
import { buildChord, chordRoot, strumSelection } from './edits.js';
import { buildChordDiagram } from './views/chord-diagram.js';
import { CHANGE } from './song.js';
import { MAX_SPREAD, MIN_SPREAD, getStrumSpread, setStrumSpread, subscribeStrum } from './strum.js';

// The slider's own unit. A strum's whole range is a 1/256 to a 1/16 of a whole note, which is 9ms to
// 150ms at 100bpm, so counting in 1/256ths gives thirty-one positions half a step apart - fine enough
// that no setting is out of reach and coarse enough that every position is a different gesture.
const SPREAD_UNIT = 256;

export function createChordTools({ song, getBpm }) {
  const element = document.createElement('section');
  element.className = 'chord-tools';
  element.innerHTML = `
    <header class="chord-tools__header">
      <span class="spiral-panel__label">Chords on</span>
      <strong class="chord-tools__root"></strong>
      <button type="button" class="chord-tools__info" aria-expanded="false" title="What these diagrams are">?</button>
    </header>
    <p class="chord-tools__note" hidden>
      Each diagram is the chord's shape as the spiral draws it, flattened to one turn so the
      pattern is easy to compare, with the same angle guides. Because the spiral has a fixed
      30&deg; per semitone, that shape reappears at every root — rotated to match, and a little
      larger at higher turns since the spiral widens as it goes out. Press one to build it where
      the cursor is; select a single note first to root it on that note instead, keeping its
      start and length.
    </p>
    <div class="chord-tools__grid"></div>
    <div class="chord-tools__strum">
      <span class="spiral-panel__label">Strum</span>
      <div class="chord-tools__strokes">
        <button type="button" class="btn btn--ghost btn--small chord-tools__strum-up">&uarr;</button>
        <button type="button" class="btn btn--ghost btn--small chord-tools__strum-down">&darr;</button>
      </div>
      <input
        type="range"
        class="chord-tools__spread"
        min="${MIN_SPREAD * SPREAD_UNIT}"
        max="${MAX_SPREAD * SPREAD_UNIT}"
        step="0.5"
        aria-label="How far apart a strum spaces the notes"
      />
      <output class="chord-tools__spread-value"></output>
    </div>
  `;

  const rootEl = element.querySelector('.chord-tools__root');
  const grid = element.querySelector('.chord-tools__grid');
  const note = element.querySelector('.chord-tools__note');
  const info = element.querySelector('.chord-tools__info');
  const strumUp = element.querySelector('.chord-tools__strum-up');
  const strumDown = element.querySelector('.chord-tools__strum-down');
  const spread = element.querySelector('.chord-tools__spread');
  const spreadValue = element.querySelector('.chord-tools__spread-value');

  info.addEventListener('click', () => {
    note.hidden = !note.hidden;
    info.setAttribute('aria-expanded', String(!note.hidden));
  });

  const chips = CHORD_TYPES.map((chord) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chord-chip';
    chip.appendChild(buildChordDiagram(chord.intervals));

    const label = document.createElement('span');
    label.className = 'chord-chip__label';
    label.textContent = chord.label;
    chip.appendChild(label);

    chip.addEventListener('click', () => buildChord(song, chord.intervals, getBpm()));
    grid.appendChild(chip);
    return { chord, chip };
  });

  // The two strokes, and how wide they are.
  //
  // Here rather than in the Note panel above, which is deliberately about exactly one note: a strum is
  // the one edit that is *only* meaningful on several, and this is the panel about chords. It is also
  // where a chord comes from - press a chip, get a chord already selected, strum it - so the gesture
  // and the thing it acts on are two controls apart.
  strumUp.addEventListener('click', () => strumSelection(song, 1, getBpm()));
  strumDown.addEventListener('click', () => strumSelection(song, -1, getBpm()));
  spread.addEventListener('input', () => setStrumSpread(Number(spread.value) / SPREAD_UNIT));

  /** How wide the stroke is, and whether there is anything to use it on. */
  function renderStrum() {
    const width = getStrumSpread();
    // Not while it is the thing being dragged: writing a value back into a range input mid-drag makes
    // the knob fight the hand holding it - the same rule the synth panel and the Note panel keep.
    if (document.activeElement !== spread) spread.value = String(width * SPREAD_UNIT);
    spreadValue.textContent = `${Math.round(secondsForBeats(width, getBpm()) * 1000)}ms`;
    const count = song.getSelection().size;
    const enough = count >= 2;
    strumUp.disabled = !enough;
    strumDown.disabled = !enough;
    const how = enough
      ? `${count} selected notes, ${Math.round(secondsForBeats(width, getBpm()) * 1000)}ms apart`
      : 'select two or more notes first';
    strumUp.title = `Play the chord upwards — the lowest note first (G). ${how}`;
    strumDown.title = `Play the chord downwards — the highest note first (⇧G). ${how}`;
  }

  // The chips are static drawings, but what they would *do* moves with the cursor, so the
  // header names the root and each chip's tooltip spells the chord out in real note names.
  function render() {
    renderStrum();
    const root = chordRoot(song);
    const name = (midi) => noteName(octaveFromMidi(midi), pcFromMidi(midi));
    rootEl.textContent = name(root.midi);
    for (const { chord, chip } of chips) {
      chip.title = `${name(root.midi)} ${chord.label} — ${chord.intervals
        .map((i) => name(root.midi + i))
        .join(' ')}`;
    }
  }

  song.subscribe((kind) => {
    if (kind === CHANGE.CURSOR || kind === CHANGE.SELECTION || kind === CHANGE.NOTES) render();
  });
  // The spread is not part of the song, so nothing above would announce it moving.
  subscribeStrum(renderStrum);
  render();

  return { element, refresh: render };
}
