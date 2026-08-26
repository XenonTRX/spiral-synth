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

import { CHORD_TYPES, noteName, octaveFromMidi, pcFromMidi } from './music-theory.js';
import { buildChord, chordRoot } from './edits.js';
import { buildChordDiagram } from './views/chord-diagram.js';
import { CHANGE } from './song.js';

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
  `;

  const rootEl = element.querySelector('.chord-tools__root');
  const grid = element.querySelector('.chord-tools__grid');
  const note = element.querySelector('.chord-tools__note');
  const info = element.querySelector('.chord-tools__info');

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

  // The chips are static drawings, but what they would *do* moves with the cursor, so the
  // header names the root and each chip's tooltip spells the chord out in real note names.
  function render() {
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
  render();

  return { element, refresh: render };
}
