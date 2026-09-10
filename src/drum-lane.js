// The step lane: a drum grid over the same notes the roll is editing.
//
// A piano roll is a pitch axis, and a kit has no pitch. Programming drums on one means finding the
// snare by counting semitones, drawing a note with a length that nothing will read, and reading a
// pattern off twelve rows scattered through eighty-four. The gutter labels fix the finding; they do
// not fix the rest, because the problem is the axis.
//
// So this is the other axis: one row per drum, one cell per step, which is how drum machines have
// presented this since 1980 for the good reason that a beat is a *pattern*, and a pattern is
// something you read at a glance and toggle rather than something you draw.
//
// **It is a view, not a second model.** A cell is a note in the song - the same note the roll draws
// and the transport plays - so there is no import, no sync, and no way for the two surfaces to
// disagree. Toggling a cell calls addNote or removeNotes, undo covers it because it covers those,
// and a pattern typed here appears on the roll as you type it. The alternative, a pattern object
// that gets rendered into notes, would have needed all of that machinery and would eventually have
// drifted; this cannot, because there is only one copy of the data.
//
// **A cell holds however many hits are in its step, not one.** This is the thing a grid of toggles
// gets wrong about drumming. A grid says a step is on or off, so everything faster than the grid is
// unwritable on it: a hi-hat that doubles for one sixteenth, a snare with a flam in front of it, a
// three-stroke fill at the end of a bar. The usual answer is to raise the resolution, which makes the
// *whole* lane four times as long and unreadable to solve a problem that occurs on two cells of it.
//
// So a cell is a step's worth of time and it draws what is in there: one hit fills it, two hits split
// it down the middle, three or four divide it further. Right-click cycles through those, which means
// the fast figures are reachable without leaving the grid, and - because a cell counts rather than
// toggles - notes written on the roll at a finer division show up here as the subdivision they are
// instead of being silently hidden. The count only ever describes the notes; nothing stores it.
//
// The subdivisions are exact fractions of the step rather than grid positions, which is what lets a
// triplet ratchet exist at all: three hits in a 1/16 sit on 1/48ths, and the resolution grid is
// binary. Starts are the one thing the model does not quantise (see grid.js), so they land where the
// arithmetic put them.

import { CHANGE, DEFAULT_VELOCITY } from './song.js';
import { getInstrument } from './instruments.js';
import { barBeats, subscribeMeter } from './meter.js';
import { getSnapBeats, subscribeGrid } from './grid.js';
import { auditionNote } from './engine.js';

// How much of a step a note fills. A drum ignores note length entirely - every voice is a one-shot
// - so this is chosen for how the roll draws it rather than for how it sounds: a note that filled
// the whole step would butt against the next one and read as a single held sound.
const CELL_FILL = 0.9;

/**
 * How many hits one cell can hold.
 *
 * Four, and the ceiling is about what the cell can *say* rather than about what the model could
 * store. Five slivers in a 16-pixel-wide square is not a picture of five hits, it is a texture; and
 * past four the figure stops being an ornament on the step and becomes a different rhythm, which is
 * what the resolution control is for. Two is a double, three is a triplet, four is a roll - that is
 * the whole vocabulary this gesture is for.
 */
const MAX_HITS = 4;

// Three levels, because a cell that offers a continuous velocity offers a fiddly drag on a 16px
// square. Accent, normal and ghost is what a drum machine gives you, it is most of the dynamic
// range that matters, and it is one click to cycle. The roll still edits velocity continuously for
// anything that needs a value between these.
const LEVELS = [
  { name: 'ghost', velocity: 0.35 },
  { name: 'normal', velocity: 0.7 },
  { name: 'accent', velocity: 1 },
];

// Which level a velocity counts as, for drawing and for deciding what the next click means.
function levelOf(velocity) {
  let best = 0;
  for (let i = 1; i < LEVELS.length; i++) {
    if (Math.abs(velocity - LEVELS[i].velocity) < Math.abs(velocity - LEVELS[best].velocity)) best = i;
  }
  return best;
}

// Enough to absorb the rounding of a start that has been through a beat-to-pixel-to-beat round trip,
// and far below anything the resolution grid can express - so a note is in the cell whose step it was
// written in and never in its neighbour.
const CELL_EPSILON = 1e-6;

export function createDrumLane({ song }) {
  const element = document.createElement('div');
  element.className = 'lane';
  element.hidden = true;
  element.innerHTML = `
    <div class="lane__head">
      <span class="lane__title"></span>
      <span class="lane__hint">Click to place · click again for accent, ghost, off · drag to paint · right-click for 2, 3, 4 hits in the step</span>
    </div>
    <div class="lane__body"></div>
  `;
  const title = element.querySelector('.lane__title');
  const body = element.querySelector('.lane__body');

  // What the grid currently describes, so it is rebuilt only when its shape changes rather than on
  // every note edit - the same reason the rack and the synth panel patch instead of replacing.
  let builtSignature = null;
  let rows = [];
  let stepBeats = 0.25;
  let stepCount = 0;

  /**
   * The step size, which is the snap setting rather than a size of this lane's own.
   *
   * Taking it from the toolbar means the lane and the roll agree about where a beat starts, and
   * that switching to triplets changes both. A lane with its own resolution would be a second
   * opinion about the grid, and the first time the two disagreed the notes would land somewhere
   * neither surface was showing.
   */
  function readGrid() {
    const snap = getSnapBeats() || 0.25;
    const bar = barBeats() || 1;
    // Always a whole number of bars, and at least two, so the pattern reads as bars rather than as
    // a strip that stops mid-phrase.
    const bars = Math.max(2, Math.ceil((song.songEndBeat() + bar * 0.5) / bar));
    return { stepBeats: snap, stepCount: Math.round((bars * bar) / snap), bar };
  }

  function activeKit() {
    const track = song.activeTrack();
    const definition = getInstrument(track?.instrument?.type);
    const steps = definition?.steps?.();
    return steps?.length ? { track, definition, steps } : null;
  }

  /**
   * Every note of this part on `midi` inside the step that begins at `beat`, in playing order.
   *
   * Half-open, which is the change that made subdivisions possible. It used to find the *one* note
   * within half a step of the line, which is nearest-cell matching: a second hit halfway through the
   * step was equally close to two cells, and whichever one claimed it, the other note vanished from a
   * surface that was supposed to be showing all of them. A step now owns exactly the time between
   * itself and the next one, so every note has one cell and every cell can hold several.
   */
  function notesIn(track, midi, beat) {
    const from = beat - CELL_EPSILON;
    const to = beat + stepBeats - CELL_EPSILON;
    return track.notes.filter((n) => n.midi === midi && n.start >= from && n.start < to);
  }

  function build(kit, grid) {
    body.replaceChildren();
    rows = [];
    const bar = grid.bar;
    const perBar = Math.max(1, Math.round(bar / grid.stepBeats));

    for (const drum of kit.steps) {
      const row = document.createElement('div');
      row.className = 'lane__row';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'lane__label';
      label.textContent = drum.name;
      label.title = `Audition ${drum.name}`;
      // The label is a pad. Hearing a drum without writing one is the first thing anybody wants,
      // and it is also how you check you are about to fill in the right row.
      label.addEventListener('click', () => auditionNote(song.activeTrack(), drum.midi, 0.6));
      row.appendChild(label);

      const cells = document.createElement('div');
      cells.className = 'lane__cells';
      const cellEls = [];
      for (let step = 0; step < grid.stepCount; step++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'lane__cell';
        // The downbeat of each bar, and the beat inside it, get a marking - without them a run of
        // sixteen identical squares is unreadable and you lose count.
        if (step % perBar === 0) cell.classList.add('lane__cell--bar');
        else if (grid.stepBeats < 0.25 && step % Math.max(1, Math.round(0.25 / grid.stepBeats)) === 0) {
          cell.classList.add('lane__cell--beat');
        }
        cell.dataset.step = String(step);
        cell.dataset.midi = String(drum.midi);
        // The fill lives on children rather than on the cell, one per hit. A cell holding three hits
        // has to be able to *draw* three, and a background cannot be divided into a variable number
        // of pieces - so the cell keeps the ground it always had (the bar and beat shading) and the
        // hits sit on top of it as boxes.
        cell.appendChild(document.createElement('i'));
        cells.appendChild(cell);
        cellEls.push(cell);
      }
      row.appendChild(cells);
      body.appendChild(row);
      rows.push({ drum, cells: cellEls });
    }
  }

  /**
   * Paint the cells from the song, without touching the structure.
   *
   * The one thing this does touch is how many boxes a cell has, and only when that number changes -
   * this runs on every note edit, and replacing twelve rows' worth of children sixty-four times over
   * to change one of them is the churn the rest of the app patches to avoid.
   */
  function paint() {
    const kit = activeKit();
    if (!kit) return;
    for (const { drum, cells } of rows) {
      for (let step = 0; step < cells.length; step++) {
        const notes = notesIn(kit.track, drum.midi, step * stepBeats);
        const cell = cells[step];
        const on = notes.length > 0;
        const hits = Math.max(1, notes.length);
        while (cell.childElementCount < hits) cell.appendChild(document.createElement('i'));
        while (cell.childElementCount > hits) cell.lastElementChild.remove();
        cell.classList.toggle('is-on', on);
        // The loudest hit in the cell decides its colour. A ratchet whose repeats are uneven is a
        // real thing to write and there is one square to say it in, so it says what the figure is
        // rather than averaging it into something that is true of none of the notes.
        const struck = on ? Math.max(...notes.map((n) => n.velocity ?? DEFAULT_VELOCITY)) : 0;
        for (let i = 0; i < LEVELS.length; i++) {
          cell.classList.toggle(`is-${LEVELS[i].name}`, on && levelOf(struck) === i);
        }
        cell.title = on
          ? `${drum.name} · ${LEVELS[levelOf(struck)].name}${notes.length > 1 ? ` · ${notes.length} hits` : ''}`
          : drum.name;
      }
    }
  }

  /**
   * One click on one cell.
   *
   * Empty becomes normal, normal becomes accent, accent becomes ghost, ghost becomes empty - a
   * cycle rather than a toggle, so the whole dynamic range is reachable from the one gesture the
   * grid affords. Starting at normal rather than accent matters: a pattern typed straight in should
   * not be at full velocity on every hit, which is the machine-gun sound this is meant to avoid.
   */
  function cycle(track, midi, beat) {
    const notes = notesIn(track, midi, beat);
    if (!notes.length) {
      song.pushUndo();
      song.addNote(track.id, { midi, start: beat, length: stepBeats * CELL_FILL, velocity: LEVELS[1].velocity });
      return 1;
    }
    // Every hit in the cell, together. A cell is one square and the click is one gesture, so a
    // subdivided step gets louder and softer as a figure - which is what a drummer does with a
    // double - rather than the first of its hits moving and the rest of them staying put.
    const level = levelOf(Math.max(...notes.map((n) => n.velocity ?? DEFAULT_VELOCITY)));
    song.pushUndo();
    if (level === 0) {
      song.removeNotes(track.id, notes.map((n) => n.id));
      return -1;
    }
    const next = level === 1 ? 2 : 0;
    for (const note of notes) song.updateNote(track.id, note.id, { velocity: LEVELS[next].velocity });
    return next;
  }

  /**
   * Rewrite a cell as `hits` evenly spaced strokes, keeping how hard it was already struck.
   *
   * Rewritten rather than added to, because "three hits in this step" is one statement about the cell
   * and the notes are how it is stored. Adding would have to decide what to do about hits already at
   * positions the new division does not have - a double turned into a triplet has a note half way
   * through the step and the triplet has none - and every answer to that leaves a cell that does not
   * look like the number it claims.
   */
  function setHits(track, midi, beat, hits) {
    const existing = notesIn(track, midi, beat);
    const velocity = existing.length
      ? Math.max(...existing.map((n) => n.velocity ?? DEFAULT_VELOCITY))
      : LEVELS[1].velocity;
    song.pushUndo();
    if (existing.length) song.removeNotes(track.id, existing.map((n) => n.id));
    const span = stepBeats / hits;
    for (let i = 0; i < hits; i++) {
      song.addNote(track.id, { midi, start: beat + i * span, length: span * CELL_FILL, velocity });
    }
  }

  /**
   * Right-click: how many hits are in this step, round the houses.
   *
   * The forward cycle includes coming back to one, so the gesture is its own undo - and an empty cell
   * cycles to two rather than to one, because one hit is what the left button is for and a right-click
   * on nothing is a request for the thing the left button cannot make.
   */
  function cycleHits(track, midi, beat) {
    const count = notesIn(track, midi, beat).length;
    const next = count === 0 ? 2 : count >= MAX_HITS ? 1 : count + 1;
    setHits(track, midi, beat, next);
  }

  /** Painting: hold and sweep to set a run of cells to whatever the first click produced. */
  let painting = null;

  function applyPaint(cell) {
    const kit = activeKit();
    if (!kit || painting === null) return;
    const midi = Number(cell.dataset.midi);
    const beat = Number(cell.dataset.step) * stepBeats;
    const existing = notesIn(kit.track, midi, beat);
    if (painting === -1) {
      if (existing.length) {
        song.pushUndo();
        song.removeNotes(kit.track.id, existing.map((n) => n.id));
      }
      return;
    }
    const wanted = LEVELS[painting].velocity;
    if (existing.length) {
      // Painting sets a level, and a subdivided cell keeps its subdivision while it does - sweeping a
      // row to accent it is a statement about how hard, not about how many.
      const changed = existing.filter((n) => (n.velocity ?? DEFAULT_VELOCITY) !== wanted);
      if (changed.length) {
        song.pushUndo();
        for (const note of changed) song.updateNote(kit.track.id, note.id, { velocity: wanted });
      }
      return;
    }
    song.pushUndo();
    song.addNote(kit.track.id, { midi, start: beat, length: stepBeats * CELL_FILL, velocity: wanted });
  }

  body.addEventListener('pointerdown', (event) => {
    // The left button only. A right-click also arrives here, and letting it start a paint meant the
    // context menu's own gesture cycled the velocity underneath it on the way past.
    if (event.button !== 0) return;
    const cell = event.target.closest('.lane__cell');
    if (!cell) return;
    const kit = activeKit();
    if (!kit) return;
    event.preventDefault();
    const midi = Number(cell.dataset.midi);
    const beat = Number(cell.dataset.step) * stepBeats;
    painting = cycle(kit.track, midi, beat);
    // Hearing what you just wrote, at the level you wrote it, is most of what makes a grid usable.
    if (painting >= 0) auditionNote(kit.track, midi, 0.6);
    body.setPointerCapture(event.pointerId);
  });

  body.addEventListener('pointermove', (event) => {
    if (painting === null) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.lane__cell');
    if (cell) applyPaint(cell);
  });

  const endPaint = () => { painting = null; };
  body.addEventListener('pointerup', endPaint);
  body.addEventListener('pointercancel', endPaint);

  // Right-click is the subdivision. Taken from the browser rather than added as a modifier because a
  // menu is what a right-click already means - "the other things I can do to this" - and because both
  // modifier keys are spoken for on this surface's other half: the roll reads Alt as "the selection"
  // and Shift as "bigger", and a lane that meant something else by either would be a third rule.
  body.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest('.lane__cell');
    if (!cell) return;
    const kit = activeKit();
    if (!kit) return;
    event.preventDefault();
    const midi = Number(cell.dataset.midi);
    cycleHits(kit.track, midi, Number(cell.dataset.step) * stepBeats);
    auditionNote(kit.track, midi, 0.6);
  });

  function render() {
    const kit = activeKit();
    // An instrument that declares no steps has no lane, and the workspace gets its height back.
    element.hidden = !kit;
    if (!kit) {
      builtSignature = null;
      return;
    }

    const grid = readGrid();
    const signature = `${kit.definition.id}:${grid.stepBeats}:${grid.stepCount}:${kit.track.id}`;
    if (signature !== builtSignature) {
      stepBeats = grid.stepBeats;
      stepCount = grid.stepCount;
      build(kit, grid);
      builtSignature = signature;
    }
    title.textContent = `${kit.track.name} — ${Math.round(stepCount * stepBeats / (grid.bar || 1))} bars of ${stepCount} steps`;
    paint();
  }

  song.subscribe(() => render());
  // The step size is the toolbar's snap and the bar length is the meter, and neither of those is a
  // change to the song - so the lane has to hear about them separately or switching to triplets
  // would leave a grid drawn in sixteenths over notes that are no longer on it.
  subscribeGrid(() => render());
  subscribeMeter(() => render());
  render();

  return { element, refresh: render };
}
