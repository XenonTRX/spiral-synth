// The editor behind a key flag on the ruler.
//
// A key change is a song event, not a track one - it applies to every part from its beat until
// the next marker - so it belongs on the ruler, which is the one strip every part is measured
// against. It also takes no time, which is why it is a flag on a boundary rather than anything
// occupying width: giving it any would push everything after it in one part off the beat it
// shares with the others.
//
// Two things follow at the spiral, and they are the reason markers are worth keeping in a
// prototype about notation: the spiral transposes so the tonic lands on the slot C4 occupies
// unkeyed, and slots outside the scale fade back. Because the tonic is pinned to that one slot,
// a mode shades the same angles whatever key it is rooted on - the shape is fixed and only the
// pitches underneath it change.
//
// Which is the claim this panel now has to make good on. It used to be a dropdown, and a
// dropdown is the one control that cannot: `Phrygian` is a word, and the whole argument for the
// notation is that a mode is a *shape*. So the list of names became a wall of dials - each one a
// single turn of the spiral with that mode shaded onto it - and choosing a mode is now choosing a
// figure you can see, next to twelve others you can see it is not. Pick Lydian beside Major and
// the difference is one slot moving a step round the circle, which is the thing the words never
// said.
//
// Under it, what the mode is *for*. A scale on its own is a filter - it tells you which notes are
// allowed - and that is the smaller half of what a key gives you. The larger half is the chords
// that fit inside it, and those are computable rather than a matter of taste: take every shape in
// the palette, root it on each tone of the scale, and keep the ones that land entirely inside.
// On a major scale that returns I ii iii IV V vi vii° exactly, without the panel knowing what a
// diatonic chord is - it falls out of the geometry, which is the nicest kind of agreement.

import {
  CHORD_TYPES,
  PITCH_CLASSES,
  SCALES,
  chordsInKey,
  keyContextLabel,
  midiFromOctavePc,
  scaleById,
} from './music-theory.js';
import { positionLabel } from './meter.js';
import { CHANGE } from './song.js';
import { audition } from './edits.js';
import { hueForSlot } from './views/common.js';
import { buildScaleDial } from './views/scale-dial.js';
import { buildChordDiagram } from './views/chord-diagram.js';

// Which chords the grid lists. Three buckets rather than one long list, because on any
// seven-note scale the first two come out at seven chords each - the triads and the sevenths
// every book prints - and dropping the suspensions in with them triples the count and buries
// them. `All` is still there for when the question really is "everything that fits".
const CHORD_FILTERS = [
  {
    id: 'triads',
    label: 'Triads',
    one: 'triad',
    many: 'triads',
    match: (chord) => chord.intervals.length === 3 && chord.quality !== 'suspended',
  },
  {
    id: 'sevenths',
    label: 'Sevenths',
    one: 'seventh',
    many: 'sevenths',
    match: (chord) => chord.intervals.length === 4,
  },
  { id: 'all', label: 'All', one: 'chord', many: 'chords', match: () => true },
];

const DIAL_SIZE = 120;
const CHIP_SIZE = 64;

export function createKeyEditor({ song }) {
  const element = document.createElement('div');
  element.className = 'key-editor';
  element.hidden = true;
  element.innerHTML = `
    <div class="key-editor__row">
      <strong class="key-editor__at"></strong>
      <button type="button" class="key-editor__remove" title="Remove this key change">Remove</button>
    </div>

    <div class="key-editor__key">
      <div class="key-editor__dial"></div>
      <div class="key-editor__summary">
        <label class="key-editor__field">
          <span class="key-editor__label">Tonic</span>
          <select class="key-editor__tonic"></select>
        </label>
        <strong class="key-editor__name"></strong>
        <p class="key-editor__pitches"></p>
        <p class="key-editor__note">
          Applies to every part from this beat until the next marker.
        </p>
      </div>
    </div>

    <section class="key-editor__section">
      <h4 class="key-editor__heading">Mode</h4>
      <div class="key-editor__modes"></div>
    </section>

    <section class="key-editor__section">
      <h4 class="key-editor__heading">
        <span>Chords that fit</span>
        <span class="key-editor__filters"></span>
      </h4>
      <div class="key-editor__chords"></div>
      <p class="key-editor__note key-editor__chord-note"></p>
    </section>
  `;

  const atEl = element.querySelector('.key-editor__at');
  const tonicEl = element.querySelector('.key-editor__tonic');
  const dialEl = element.querySelector('.key-editor__dial');
  const nameEl = element.querySelector('.key-editor__name');
  const pitchesEl = element.querySelector('.key-editor__pitches');
  const modesEl = element.querySelector('.key-editor__modes');
  const filtersEl = element.querySelector('.key-editor__filters');
  const chordsEl = element.querySelector('.key-editor__chords');
  const chordNoteEl = element.querySelector('.key-editor__chord-note');

  PITCH_CLASSES.forEach((name, pc) => {
    tonicEl.appendChild(new Option(name, String(pc)));
  });

  let openId = null;
  let filterId = 'triads';

  // --- what the dials are drawn from ----------------------------------------------------------

  // Position on a dial is semitones from the tonic, which is also the spiral's slot index modulo
  // a turn - so this is the spiral's own hue rule, and the picket follows the Colour by setting
  // without having to know what it says.
  function hueAtFor(tonicPc) {
    return (position) => hueForSlot(position, (tonicPc + position) % 12);
  }

  function openMarker() {
    return openId ? song.getKeyMarkers().find((m) => m.id === openId) ?? null : null;
  }

  // --- the key itself -------------------------------------------------------------------------

  function renderKey(marker, scale) {
    const inScale = new Set(scale.intervals);
    const hueAt = hueAtFor(marker.tonicPc);
    const names = scale.intervals.map((offset) => PITCH_CLASSES[(marker.tonicPc + offset) % 12]);

    dialEl.replaceChildren(
      buildScaleDial(inScale, {
        size: DIAL_SIZE,
        rInner: 22,
        rOuter: 38,
        width: 9,
        hueAt,
        labels: (position) => PITCH_CLASSES[(marker.tonicPc + position) % 12],
        title: `${keyContextLabel(marker)} — ${names.join(' ')}`,
      })
    );

    nameEl.textContent = keyContextLabel(marker);
    pitchesEl.textContent = `${names.length} notes · ${names.join(' ')}`;
  }

  // --- the modes ------------------------------------------------------------------------------

  // The chips are rebuilt only when the tonic moves, and for one reason beyond the drawing being
  // wasted work: pressing a chip changes the key, which re-renders the panel, and rebuilding the
  // grid there would delete the button under the press. A mouse never notices; a keyboard does,
  // because focus falls back to the document and the next Tab starts again from the top. What a
  // change of mode actually alters is which chip is marked, so that is all it changes.
  const modeChips = new Map();
  let chipsTonic = null;

  function buildModeChips(tonicPc) {
    const hueAt = hueAtFor(tonicPc);
    modeChips.clear();
    modesEl.replaceChildren();
    for (const scale of SCALES) {
      const names = scale.intervals.map((offset) => PITCH_CLASSES[(tonicPc + offset) % 12]);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mode-chip';
      chip.dataset.scaleId = scale.id;
      chip.title = `${PITCH_CLASSES[tonicPc]} ${scale.label} — ${names.join(' ')}`;
      chip.appendChild(buildScaleDial(new Set(scale.intervals), { size: CHIP_SIZE, hueAt }));
      const label = document.createElement('span');
      label.className = 'mode-chip__label';
      label.textContent = scale.label;
      chip.appendChild(label);
      chip.addEventListener('click', () => {
        if (openId) song.updateKeyMarker(openId, { scaleId: scale.id });
      });
      modesEl.appendChild(chip);
      modeChips.set(scale.id, chip);
    }
    chipsTonic = tonicPc;
  }

  function renderModes(marker) {
    if (chipsTonic !== marker.tonicPc) buildModeChips(marker.tonicPc);
    for (const [scaleId, chip] of modeChips) {
      const current = scaleId === marker.scaleId;
      chip.classList.toggle('is-current', current);
      chip.setAttribute('aria-pressed', String(current));
    }
  }

  // --- the chords -----------------------------------------------------------------------------

  // Built once and only re-marked afterwards, for the reason the mode chips are: rebuilding the
  // row would delete the button the press is still inside.
  const filterButtons = new Map();

  function buildFilters() {
    for (const filter of CHORD_FILTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'key-editor__filter';
      button.textContent = filter.label;
      button.addEventListener('click', () => {
        filterId = filter.id;
        markFilters();
        const marker = openMarker();
        if (marker) renderChords(marker, scaleById(marker.scaleId));
      });
      filtersEl.appendChild(button);
      filterButtons.set(filter.id, button);
    }
    markFilters();
  }

  function markFilters() {
    for (const [id, button] of filterButtons) {
      const current = id === filterId;
      button.classList.toggle('is-current', current);
      button.setAttribute('aria-pressed', String(current));
    }
  }

  // Heard rather than written: the picket is a flag on a boundary and the cursor is somewhere
  // else entirely, so a chip that placed notes would put them at a beat you were not looking at.
  // Pressing one plays it in the part you are editing, from the tonic the spiral is showing, which
  // answers the only question a chord list raises - what does that sound like here.
  function auditionChord(marker, entry) {
    const track = song.activeTrack();
    if (!track) return;
    const tonicMidi = midiFromOctavePc(song.getRefOctave(), marker.tonicPc);
    for (const interval of entry.chord.intervals) {
      audition(track, tonicMidi + entry.rootOffset + interval);
    }
  }

  function renderChords(marker, scale) {
    const filter = CHORD_FILTERS.find((f) => f.id === filterId) ?? CHORD_FILTERS[0];
    chordsEl.replaceChildren();

    // Chromatic is not a key, it is the absence of one: every shape fits at every root, so a grid
    // of 132 chips would be a very long way of saying nothing is ruled out.
    if (scale.id === 'chromatic') {
      chordNoteEl.textContent =
        'Chromatic rules nothing out — all twelve roots take all '
        + `${CHORD_TYPES.length} shapes. Pick a mode above to see what it narrows to.`;
      return;
    }

    const inScale = new Set(scale.intervals);
    const hueAt = hueAtFor(marker.tonicPc);
    const degrees = chordsInKey(marker.tonicPc, scale);
    let count = 0;

    for (const degree of degrees) {
      for (const entry of degree.chords) {
        if (!filter.match(entry.chord)) continue;
        count += 1;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chord-chip chord-chip--in-key';
        chip.title = `${entry.symbol} — ${entry.chord.intervals
          .map((i) => PITCH_CLASSES[(degree.rootPc + i) % 12])
          .join(' ')} · degree ${degree.degree} of ${keyContextLabel(marker)} · click to hear it`;

        const numeral = document.createElement('span');
        numeral.className = 'chord-chip__numeral';
        numeral.textContent = entry.roman ?? `${degree.degree}`;
        chip.appendChild(numeral);

        chip.appendChild(
          buildChordDiagram(entry.chord.intervals, { root: degree.rootOffset, ring: inScale, hueAt })
        );

        const label = document.createElement('span');
        label.className = 'chord-chip__label';
        label.textContent = entry.symbol;
        chip.appendChild(label);

        chip.addEventListener('click', () => auditionChord(marker, entry));
        chordsEl.appendChild(chip);
      }
    }

    // The count is of chords, not of shapes - the same triangle rooted on three different degrees
    // is three chords and one shape, and saying "3 of 11 shapes" would be counting the wrong thing.
    chordNoteEl.textContent = count
      ? `${count} ${count === 1 ? `${filter.one} fits` : `${filter.many} fit`} inside `
        + `${keyContextLabel(marker)}, `
        + `out of the ${CHORD_TYPES.length} shapes the palette can draw. The faint ring is the `
        + 'mode; the chord is the figure on it. Click one to hear it.'
      : `No ${filter.many} fit inside ${keyContextLabel(marker)}.`;
  }

  // --- render ---------------------------------------------------------------------------------

  function render() {
    const marker = openMarker();
    if (!marker) return close();
    const scale = scaleById(marker.scaleId);
    atEl.textContent = `Key at ${positionLabel(marker.beat)}`;
    tonicEl.value = String(marker.tonicPc);
    renderKey(marker, scale);
    renderModes(marker);
    renderChords(marker, scale);
  }

  tonicEl.addEventListener('change', () => {
    if (openId) song.updateKeyMarker(openId, { tonicPc: Number(tonicEl.value) });
  });
  element.querySelector('.key-editor__remove').addEventListener('click', () => {
    if (openId) song.removeKeyMarker(openId);
    close();
  });

  // The panel is now a reading of the marker rather than a form filled in from it, so it has to
  // follow the marker: pressing a mode chip changes the key, and the dials, the chord list and
  // the note names all have to agree with what was pressed.
  song.subscribe((kind) => {
    if (kind === CHANGE.KEYS && openId) render();
  });

  function close() {
    openId = null;
    element.hidden = true;
  }

  function open(markerId, x) {
    if (!song.getKeyMarkers().some((m) => m.id === markerId)) return;
    openId = markerId;
    element.hidden = false;
    render();
    if (!openId) return; // render() found the marker gone and closed us
    // Anchored to the flag but kept inside the window, since a marker near the right edge
    // would otherwise open half off screen.
    const width = element.offsetWidth || 372;
    const left = Math.max(8, Math.min(x - width / 2, window.innerWidth - width - 8));
    element.style.left = `${left}px`;
  }

  document.addEventListener('pointerdown', (event) => {
    if (element.hidden) return;
    if (element.contains(event.target) || event.target.closest('.roll__key-flag')) return;
    close();
  });

  buildFilters();

  return {
    element,
    open,
    close,
    // The dials are drawn in the spiral's colours, so a change of the Colour by setting has to
    // reach them too - a picket still in the old palette beside a spiral in the new one is the
    // exact disagreement the shared hue rule exists to prevent.
    refresh: () => {
      if (openId) render();
    },
  };
}
