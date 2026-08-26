// The step lane: a drum grid over the same notes the roll is editing.
//
// A piano roll is a pitch axis, and a kit has no pitch. Programming drums on one means finding the
// snare by counting semitones, drawing a note with a length that nothing will read, and reading a
// pattern off eleven rows scattered through eighty-four. The gutter labels fix the finding; they do
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

import { CHANGE, DEFAULT_VELOCITY } from './song.js';
import { getInstrument } from './instruments.js';
import { barBeats, subscribeMeter } from './meter.js';
import { getSnapBeats, subscribeGrid } from './grid.js';
import { auditionNote } from './engine.js';

// How much of a step a note fills. A drum ignores note length entirely - every voice is a one-shot
// - so this is chosen for how the roll draws it rather than for how it sounds: a note that filled
// the whole step would butt against the next one and read as a single held sound.
const CELL_FILL = 0.9;

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

const near = (a, b, tol) => Math.abs(a - b) < tol;

export function createDrumLane({ song }) {
  const element = document.createElement('div');
  element.className = 'lane';
  element.hidden = true;
  element.innerHTML = `
    <div class="lane__head">
      <span class="lane__title"></span>
      <span class="lane__hint">Click to place · click again for accent, ghost, off · drag to paint</span>
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

  /** Every note of this part sitting on `midi` at `beat`, within half a step. */
  function noteAt(track, midi, beat) {
    const tol = stepBeats * 0.5;
    return track.notes.find((n) => n.midi === midi && near(n.start, beat, tol)) ?? null;
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
        cells.appendChild(cell);
        cellEls.push(cell);
      }
      row.appendChild(cells);
      body.appendChild(row);
      rows.push({ drum, cells: cellEls });
    }
  }

  /** Paint the cells from the song, without touching the structure. */
  function paint() {
    const kit = activeKit();
    if (!kit) return;
    for (const { drum, cells } of rows) {
      for (let step = 0; step < cells.length; step++) {
        const note = noteAt(kit.track, drum.midi, step * stepBeats);
        const cell = cells[step];
        const on = Boolean(note);
        cell.classList.toggle('is-on', on);
        for (let i = 0; i < LEVELS.length; i++) {
          cell.classList.toggle(`is-${LEVELS[i].name}`, on && levelOf(note.velocity ?? DEFAULT_VELOCITY) === i);
        }
        cell.title = on
          ? `${drum.name} · ${LEVELS[levelOf(note.velocity ?? DEFAULT_VELOCITY)].name}`
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
    const note = noteAt(track, midi, beat);
    if (!note) {
      song.pushUndo();
      song.addNote(track.id, { midi, start: beat, length: stepBeats * CELL_FILL, velocity: LEVELS[1].velocity });
      return 1;
    }
    const level = levelOf(note.velocity ?? DEFAULT_VELOCITY);
    song.pushUndo();
    if (level === 1) song.updateNote(track.id, note.id, { velocity: LEVELS[2].velocity });
    else if (level === 2) song.updateNote(track.id, note.id, { velocity: LEVELS[0].velocity });
    else song.removeNotes(track.id, [note.id]);
    return level === 2 ? 0 : level === 1 ? 2 : -1;
  }

  /** Painting: hold and sweep to set a run of cells to whatever the first click produced. */
  let painting = null;

  function applyPaint(cell) {
    const kit = activeKit();
    if (!kit || painting === null) return;
    const midi = Number(cell.dataset.midi);
    const beat = Number(cell.dataset.step) * stepBeats;
    const existing = noteAt(kit.track, midi, beat);
    if (painting === -1) {
      if (existing) {
        song.pushUndo();
        song.removeNotes(kit.track.id, [existing.id]);
      }
      return;
    }
    const wanted = LEVELS[painting].velocity;
    if (existing) {
      if ((existing.velocity ?? DEFAULT_VELOCITY) !== wanted) {
        song.pushUndo();
        song.updateNote(kit.track.id, existing.id, { velocity: wanted });
      }
      return;
    }
    song.pushUndo();
    song.addNote(kit.track.id, { midi, start: beat, length: stepBeats * CELL_FILL, velocity: wanted });
  }

  body.addEventListener('pointerdown', (event) => {
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
