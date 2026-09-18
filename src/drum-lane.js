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
import { barBeats, pulseBeats, subscribeMeter } from './meter.js';
import {
  LANE_STEP_CHOICES,
  MAX_SWING,
  SWING_STRAIGHT,
  getSwing,
  laneStepBeats,
  setSwing,
  stepMark,
  subscribeGrid,
  trackLaneStepId,
} from './grid.js';
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

/**
 * The most cells one row may have.
 *
 * There has to be a number here now that the step is a control: a 1/32 lane over a thirty-two bar
 * song is 1024 cells a row and twelve thousand buttons in the document, which is slow to build and
 * unreadable once built. 256 is four bars of 1/16 times four, or eight bars of a 1/32 - past the
 * point where a grid is something you take in at a glance, which is the only thing it is better at
 * than the roll. Beyond it the lane shows the front of the song and says so in its title; the roll
 * is the surface for the rest, and a pattern length that made the lane loop instead of run out is
 * the proper answer, which this is not pretending to be.
 */
const MAX_STEPS = 256;

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
      <label class="lane__step">
        Step
        <select class="lane__step-select" title="How much time one cell of this part covers — its scale. Snap follows the toolbar; anything else is this part's own, so one kit can run at a 1/32 under another at a 1/8. It moves no notes, and swing is measured against it."></select>
      </label>
      <label class="lane__length" title="How many steps before the pattern comes round again — a drum machine's last step. It is the part's loop length, so the roll shows it too; steps past it keep their notes and stop playing, and come back if you lengthen it.">
        Length
        <input type="number" class="lane__length-input" min="1" max="${MAX_STEPS}" step="1" aria-label="How many steps the pattern is" />
      </label>
      <button type="button" class="btn btn--ghost btn--small btn--toggle lane__auto" aria-pressed="false" title="Let the pattern be as long as the material written into it, rounded up to a bar — which is what a part does until a length is set on it.">Auto</button>
      <label class="lane__swing" title="How late every other step plays, as the share of a two-step pair the first of the pair gets. 50% is straight and 67% is a triplet feel. It moves no notes — the roll goes on showing the straight grid, and this is how they are played.">
        Swing
        <input
          type="range"
          class="lane__swing-slider"
          min="${Math.round(SWING_STRAIGHT * 100)}"
          max="${Math.round(MAX_SWING * 100)}"
          step="1"
          aria-label="How late every other step plays"
        />
        <output class="lane__swing-value"></output>
      </label>
      <span class="lane__hint">Click to place · click again for accent, ghost, off · drag to paint · right-click for 2, 3, 4 hits in the step</span>
    </div>
    <div class="lane__body"></div>
  `;
  const title = element.querySelector('.lane__title');
  const body = element.querySelector('.lane__body');
  const stepSelect = element.querySelector('.lane__step-select');

  for (const choice of LANE_STEP_CHOICES) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    stepSelect.appendChild(option);
  }
  // The setting lives in grid.js, so this only ever asks for a change and redraws when it hears one -
  // the same shape as the toolbar's own two pickers, and the reason a song can save which one it was
  // written on.
  // The part's, not the lane's - so switching parts in the rack brings that part's scale with it,
  // and a kit at a 1/32 can sit under one at a 1/8. Undoable, because it is now a change to the song.
  stepSelect.addEventListener('change', () => {
    const track = song.activeTrack();
    if (!track) return;
    song.pushUndo();
    song.setTrackLaneStep(track.id, stepSelect.value);
  });

  const lengthInput = element.querySelector('.lane__length-input');
  const autoBtn = element.querySelector('.lane__auto');

  /**
   * Set the pattern length from the box, in steps of whatever the lane's step currently is.
   *
   * In steps because that is the unit the control is next to and the unit a machine states it in;
   * stored in whole notes because that is the unit everything else here is in. Which means the same
   * pattern reads as 16 on a 1/16 lane and 12 on a 1/8T one, and both are true.
   */
  function commitLength() {
    const track = song.activeTrack();
    if (!track) return;
    const steps = Math.round(Number(lengthInput.value));
    if (!Number.isFinite(steps) || steps < 1) {
      render();
      return;
    }
    song.pushUndo();
    song.setTrackPeriod(track.id, Math.min(MAX_STEPS, steps) * stepBeats);
  }

  // `change` rather than `input`: a number box fires on every digit, so committing per keystroke
  // would set the pattern to 1 on the way to typing 12 - and each of those is an undo entry and a
  // rebuild of every row.
  lengthInput.addEventListener('change', commitLength);

  autoBtn.addEventListener('click', () => {
    const track = song.activeTrack();
    if (!track) return;
    song.pushUndo();
    song.setTrackPeriod(track.id, null);
  });

  const swingSlider = element.querySelector('.lane__swing-slider');
  const swingValue = element.querySelector('.lane__swing-value');
  // No undo entry, and no `pushUndo`: swing is not an edit. It shifts nothing in the song, so there
  // is nothing for undo to put back - it is a setting, like snap, and it travels in the document the
  // same way. Which is also what makes it safe to sweep while the song is playing, which is the only
  // way anybody has ever found the right amount.
  swingSlider.addEventListener('input', () => setSwing(swingFromPercent(Number(swingSlider.value))));

  /**
   * The one notch on the slider that is a named thing, stored as the thing rather than as the notch.
   *
   * A whole-percent slider cannot reach two thirds - it stops at 0.67 - and the difference is about a
   * millisecond at 100bpm, which nobody can hear. It is corrected anyway, because the readout beside
   * it says "triplet" and this project has been bitten before by a panel naming a number the audio
   * was not using. At 67 a shuffled sixteenth now lands exactly on a 1/12, which is what the word
   * means. Every other notch is worth exactly what it says.
   */
  const TRIPLET_PERCENT = Math.round((2 / 3) * 100);
  const swingFromPercent = (percent) => (percent === TRIPLET_PERCENT ? 2 / 3 : percent / 100);

  /** 50% is straight, and two thirds is the one setting with a name. */
  function swingLabel(fraction) {
    const percent = Math.round(fraction * 100);
    if (percent <= Math.round(SWING_STRAIGHT * 100)) return 'straight';
    return percent === TRIPLET_PERCENT ? `${percent}% · triplet` : `${percent}%`;
  }

  // What the grid currently describes, so it is rebuilt only when its shape changes rather than on
  // every note edit - the same reason the rack and the synth panel patch instead of replacing.
  let builtSignature = null;
  let rows = [];
  let stepBeats = 0.25;
  let stepCount = 0;

  /**
   * The step size, and how many of them the strip is.
   *
   * The size is the lane's own setting now rather than the toolbar's, and it defaults to following
   * the toolbar - see the note on `LANE_STEP_CHOICES` in grid.js for why that stopped being the only
   * safe answer. What has not changed is that the *length* is the song's: a whole number of bars, at
   * least two, so the pattern reads as bars rather than as a strip that stops mid-phrase.
   */
  function readGrid() {
    const step = laneStepBeats(song.activeTrack());
    const bar = barBeats() || 1;
    const track = song.activeTrack();
    // One pass, which is the pattern - not the song. It used to be the song's length, and that was a
    // strip of mostly dead cells: the lane draws the part's *material*, which folds at the period, so
    // every cell past one pass was guaranteed empty and clicking one silently lengthened the pattern.
    // A part with nothing in it yet has no period at all, and gets a bar to write into.
    const period = (track ? song.trackPeriod(track) : 0) || bar;
    const wanted = Math.max(1, Math.round(period / step));
    return {
      stepBeats: step,
      stepCount: Math.min(MAX_STEPS, wanted),
      clipped: wanted > MAX_STEPS,
      bar,
      pulse: pulseBeats(),
    };
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
    // Beats are only worth marking when a cell is smaller than one; at a 1/4 step in 4/4 every cell
    // *is* a beat, and marking them all says nothing. Passing 0 is how `stepMark` is told not to.
    const pulse = grid.stepBeats < grid.pulse - 1e-9 ? grid.pulse : 0;

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
        // sixteen identical squares is unreadable and you lose count. Read off the cell's own time
        // rather than counted, so a triplet lane's bar lines land on the bars - see `stepMark`.
        const mark = stepMark(step * grid.stepBeats, grid.bar, pulse);
        if (mark) cell.classList.add(`lane__cell--${mark}`);
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
    // Never while it has focus and is open: writing a select's value back under a pointer that is
    // choosing from it closes the list. It cannot be stale anyway - the only thing that changes it is
    // a change this then hears about.
    const stepId = song.trackLaneStepId(kit.track);
    if (stepSelect.value !== stepId && document.activeElement !== stepSelect) {
      stepSelect.value = stepId;
    }
    const swing = getSwing();
    // Same rule as the picker: never write a value back into a control that is being dragged.
    if (document.activeElement !== swingSlider) swingSlider.value = String(Math.round(swing * 100));
    swingValue.textContent = swingLabel(swing);
    swingValue.classList.toggle('is-off', swing <= SWING_STRAIGHT);

    const signature = `${kit.definition.id}:${grid.stepBeats}:${grid.stepCount}:${kit.track.id}`;
    if (signature !== builtSignature) {
      stepBeats = grid.stepBeats;
      stepCount = grid.stepCount;
      build(kit, grid);
      builtSignature = signature;
    }
    const auto = song.trackOwnPeriod(kit.track) === null;
    if (document.activeElement !== lengthInput) lengthInput.value = String(stepCount);
    autoBtn.classList.toggle('is-on', auto);
    autoBtn.setAttribute('aria-pressed', String(auto));
    // Disabled when it is already what it does. The button stays on screen either way - the head must
    // not change width when a length is set, or every control in it would move under the pointer.
    autoBtn.disabled = auto;

    // Hits the pattern is no longer long enough to reach. They are still in the material and still on
    // the roll, so the count is the only thing that explains where they went.
    const period = song.trackPeriod(kit.track);
    const orphans = period > 0
      ? kit.track.notes.filter((n) => n.start >= period - 1e-9).length
      : 0;
    const bars = (stepCount * stepBeats) / (grid.bar || 1);
    const barLabel = Math.abs(bars - Math.round(bars)) < 1e-6
      ? `${Math.round(bars)} bar${Math.round(bars) === 1 ? '' : 's'}`
      : `${bars.toFixed(2)} bars`;
    title.textContent = `${kit.track.name} — ${stepCount} steps · ${barLabel}`
      + (auto ? '' : ' · set')
      + (orphans ? ` · ${orphans} hit${orphans === 1 ? '' : 's'} past the end` : '')
      + (grid.clipped ? ' · longer than the lane draws' : '');
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
