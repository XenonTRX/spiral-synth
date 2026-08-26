// The piano roll: pitch up the page, time across it.
//
// This is the half of the screen the spiral was bad at. Time is a real axis - a note's width is
// its length, so a 1/16 is a quarter the width of a 1/4, and two tracks line up vertically
// because they are measured against the same ruler rather than because they happen to have the
// same number of cells. Nothing here is novel; that is the point. The notation experiment is
// in the spiral, and it needs an ordinary, dense, boring surface next to it to be worth
// anything.
//
// Everything is one scroll container with panes hung off it: the ruler and the active part's fade lane
// track it horizontally, the key gutter vertically, and the grid gets both. They are separate elements
// rather than sticky children because sticky inside a transformed, absolutely-positioned canvas
// is a fight, and three lines of scroll-sync are cheaper than winning it.

import { MIDI_HIGH, MIDI_LOW, BEAT_EPSILON, CHANGE, slideSources } from './song.js';
import { selectionSpan, stretchSelection } from './edits.js';
import {
  PITCH_CLASSES,
  labelForBeats,
  midiToFreq,
  noteName,
  octaveFromMidi,
  pcFromMidi,
  scaleById,
  scaleDegree,
  secondsForBeats,
} from './music-theory.js';
import {
  barBeats,
  barLinesBetween,
  getMeterId,
  groupLinesBetween,
  positionLabel,
  pulseBeats,
  subscribeMeter,
} from './meter.js';
import { getPxPerWhole, subscribeTimeScale, zoomBy } from './time-scale.js';
import { getResolution, getSnapBeats, quantizeTime, snapStart, subscribeGrid } from './grid.js';
import { createFadeLane } from './fade-lane.js';
import { createRollSpectrum } from './roll-spectrum.js';
import { createRollViewport } from './roll-viewport.js';
import { getSetting } from './settings.js';
import { hueForPc } from './views/common.js';
import { auditionNote } from './engine.js';
import { getInstrument, instrumentSlides } from './instruments.js';
import { referenceEndBeat, subscribeReference } from './reference.js';

const ROW_H = 13;
const ROWS = MIDI_HIGH - MIDI_LOW + 1;
const GUTTER_W = 62;
const RULER_H = 30;
// Taller than the rack's copy of the same box, because the roll's is very wide: a one-bar fade drawn
// 480px across and 22 high is a nearly horizontal line, and the slope is what says how fast it arrives.
const LANE_H = 34;
const LANE_BOX_H = 28;
const RESIZE_GRIP = 7; // px at a note's trailing edge that resize rather than move
// And at the leading edge, where a slide is pulled out of a note. Live only on a note that is
// already selected, which is what keeps it from taking the left edge away from dragging a chord:
// the grip is drawn before it is armed, so the pixels only change meaning once you can see that
// they have. A short note gets none of it - below this width the two grips would meet in the
// middle and there would be nowhere left to grab the note itself.
const SLIDE_GRIP = 7;
const SLIDE_MIN_NOTE_PX = 24;
// How far you drag to cross the whole velocity range. Roughly nine note rows, which is far enough
// that the gesture is a deliberate one and short enough to do without moving your wrist.
const VELOCITY_DRAG_PX = 120;
const DRAG_THRESHOLD = 3;
const MIN_NOTE_PX = 4;
const TRAILING_BARS = 4; // empty room kept past the end of the song, so it can grow
const MIN_BARS = 8;
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const AUDITION_SECONDS = 0.32;

// How much wheel travel one zoom notch costs, and how to measure travel at all.
//
// It used to be a notch per wheel *event*, which is right for a mouse and badly wrong for anything
// else. A mouse reports about a hundred pixels per click, so one click was one notch. A trackpad
// pinch reports a few pixels at a time and fires dozens of events for one gesture - and the whole
// zoom range is only about sixteen notches - so a single flick went from one end of it to the
// other. Charging for distance rather than for events makes the mouse behave exactly as it did and
// gives a pinch a couple of notches instead of thirty.
//
// The two multipliers are there because a wheel delta is not always in pixels: `deltaMode` says
// whether it is counting pixels, lines or pages, and a line counted as a pixel is a gesture that
// appears to do nothing at all.
const ZOOM_WHEEL_PX = 100;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;

function wheelPixels(event) {
  if (event.deltaMode === 1) return event.deltaY * WHEEL_LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * WHEEL_PAGE_PX;
  return event.deltaY;
}

const yForMidi = (midi) => (MIDI_HIGH - midi) * ROW_H;
const midiForY = (y) => MIDI_HIGH - Math.floor(y / ROW_H);

export function createPianoRoll({ song, getBpm }) {
  const element = document.createElement('div');
  element.className = 'roll';
  element.innerHTML = `
    <div class="roll__corner"><span class="roll__corner-label"></span></div>
    <div class="roll__ruler-view"><div class="roll__ruler"></div></div>
    <div class="roll__lane-corner"><span class="roll__lane-label"></span></div>
    <div class="roll__lane-view"><div class="roll__lane"></div></div>
    <div class="roll__keys-view"><div class="roll__keys"></div></div>
    <div class="roll__scroller">
      <div class="roll__canvas">
        <div class="roll__rows"></div>
        <canvas class="roll__spectrum"></canvas>
        <div class="roll__grid"></div>
        <div class="roll__pitch-band"></div>
        <div class="roll__repeats"></div>
        <div class="roll__notes"></div>
        <div class="roll__stretch" hidden><span class="roll__stretch-grip"></span></div>
        <div class="roll__marquee" hidden></div>
        <div class="roll__cursor"><span class="roll__cursor-cap"></span></div>
        <div class="roll__playhead" hidden></div>
      </div>
    </div>
  `;

  const rulerView = element.querySelector('.roll__ruler-view');
  const ruler = element.querySelector('.roll__ruler');
  const lane = element.querySelector('.roll__lane');
  const laneLabel = element.querySelector('.roll__lane-label');
  const keys = element.querySelector('.roll__keys');
  const scroller = element.querySelector('.roll__scroller');
  const canvas = element.querySelector('.roll__canvas');
  const rows = element.querySelector('.roll__rows');
  const grid = element.querySelector('.roll__grid');
  const spectrum = element.querySelector('.roll__spectrum');
  const pitchBand = element.querySelector('.roll__pitch-band');
  const notesLayer = element.querySelector('.roll__notes');
  const repeatsLayer = element.querySelector('.roll__repeats');
  const stretchEl = element.querySelector('.roll__stretch');
  const marquee = element.querySelector('.roll__marquee');
  const cursorEl = element.querySelector('.roll__cursor');
  const playheadEl = element.querySelector('.roll__playhead');
  const cornerLabel = element.querySelector('.roll__corner-label');

  element.style.setProperty('--gutter-w', `${GUTTER_W}px`);
  element.style.setProperty('--ruler-h', `${RULER_H}px`);
  element.style.setProperty('--lane-h', `${LANE_H}px`);
  element.style.setProperty('--row-h', `${ROW_H}px`);

  // --- static furniture -----------------------------------------------------------------------

  // Rows are real elements rather than a repeating gradient. There are only 84 of them, and
  // having each one addressable is what makes the octave separators, the key-gutter highlight
  // and the scale shading fall out for free instead of needing background-position arithmetic.
  const rowEls = [];
  for (let midi = MIDI_HIGH; midi >= MIDI_LOW; midi--) {
    const pc = pcFromMidi(midi);
    const row = document.createElement('div');
    row.className = 'roll__row';
    row.classList.toggle('roll__row--black', BLACK_PCS.has(pc));
    row.classList.toggle('roll__row--octave', pc === 0);
    row.style.setProperty('--hue', String(hueForPc(pc)));
    rows.appendChild(row);

    const key = document.createElement('div');
    key.className = 'roll__key';
    key.classList.toggle('roll__key--black', BLACK_PCS.has(pc));
    key.style.setProperty('--hue', String(hueForPc(pc)));
    key.dataset.midi = String(midi);
    keys.appendChild(key);
    rowEls[midi] = { row, key };
  }

  // --- how the gutter is drawn ------------------------------------------------------------

  // Two readings of the vertical axis.
  //
  // A piano keyboard is the one every DAW draws, and its whole job is done by shape: the black
  // keys make an irregular 2-3 pattern that you read position from without counting. That is
  // genuinely good, and it is also the reason the roll and the spiral don't speak the same
  // language - the spiral says pitch class in colour and the gutter says it in a physical
  // object, so nothing about one drawing tells you anything about the other.
  //
  // The rainbow drops the instrument. Every semitone gets its own hue, the same hue the note
  // has in the roll and the slot has on the spiral, so a pitch class is one colour everywhere
  // on screen and a row can be recognised without reference to where the black keys fall. What
  // it costs is the landmark: twelve evenly-spaced stripes have no shape to them, so the octave
  // lines and the C labels stop being a convenience and become the only way to know where you
  // are. What it buys is that the key can be drawn *into* the axis - in-scale rows keep their
  // colour, the rest fall back, and the tonic is marked - which is the spiral's three tiers
  // applied to the roll, and turns the gutter into a legend for the key you are in.
  let keyStyleSignature = null;

  function applyKeyboardStyle(force = false) {
    const rainbow = getSetting('keyboardStyle') === 'rainbow';
    const context = song.keyAt(song.getCursor());
    // An instrument can name its own notes, and one does. For a kit a pitch is not a pitch - 38 is
    // the snare, not a D2 that sounds like one - so a keyboard drawn as a keyboard is the wrong
    // legend entirely, and counting semitones up from C2 to find the closed hat is not a thing
    // anybody should have to do. Instruments that decline get exactly what they had.
    const definition = getInstrument(song.activeTrack()?.instrument?.type);
    const label = definition?.noteLabel ?? null;
    const signature = `${rainbow}:${context.explicit}:${context.tonicPc}:${context.scaleId}:${definition?.id ?? ''}`;
    if (!force && signature === keyStyleSignature) return;
    keyStyleSignature = signature;

    element.classList.toggle('roll--named', Boolean(label));

    element.classList.toggle('roll--rainbow', rainbow);
    const scale = scaleById(context.scaleId);

    for (let midi = MIDI_LOW; midi <= MIDI_HIGH; midi++) {
      const { row, key } = rowEls[midi];
      const pc = pcFromMidi(midi);
      const degree = context.explicit ? scaleDegree(scale, pc - context.tonicPc) : null;
      const offKey = context.explicit && degree === null;
      const tonic = degree === 1;

      const named = label ? label(midi) : null;
      // Key colouring is about where a pitch sits in a scale, which means nothing to a drum. A
      // named row is neither off-key nor the tonic; it is the snare.
      row.classList.toggle('roll__row--off-key', offKey && !label);
      row.classList.toggle('roll__row--tonic', tonic && !label);
      row.classList.toggle('roll__row--named', Boolean(named));
      key.classList.toggle('roll__key--off-key', offKey && !label);
      key.classList.toggle('roll__key--tonic', tonic && !label);
      key.classList.toggle('roll__key--named', Boolean(named));
      // C is the landmark; the tonic is the other thing worth being able to find by eye, and
      // naming it is cheaper than expecting anyone to count up from C.
      if (label) key.textContent = named ?? '';
      else key.textContent = pc === 0 || tonic ? noteName(octaveFromMidi(midi), pc) : '';
    }
  }

  keys.addEventListener('pointerdown', (event) => {
    const key = event.target.closest('.roll__key');
    if (!key) return;
    const midi = Number(key.dataset.midi);
    song.setPitchCursor(midi);
    auditionNote(song.activeTrack(), midi, AUDITION_SECONDS);
  });

  // --- geometry -------------------------------------------------------------------------------

  function pxPerWhole() {
    return getPxPerWhole();
  }

  // How much roll there is. An imported recording counts towards it for the same reason the
  // transport counts it: the point of one is to write notes against the part of it you have not
  // written yet, and a surface that stopped four bars past the last note would leave that part
  // unscrollable. The trailing bars are still there past whichever of the two ends later, because
  // the song has to be able to grow off the end of the record too.
  function contentBeats() {
    const end = Math.max(song.songEndBeat(), referenceEndBeat()) + TRAILING_BARS * barBeats();
    return Math.max(end, MIN_BARS * barBeats());
  }

  function contentWidth() {
    return Math.ceil(contentBeats() * pxPerWhole());
  }

  const xForBeat = (beat) => beat * pxPerWhole();
  const beatForX = (x) => x / pxPerWhole();

  /** Pointer position in canvas coordinates, scroll included. */
  function pointIn(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const snap = (beat) => snapStart(beat);

  // --- layout ---------------------------------------------------------------------------------

  let laidOutBeats = null;

  function layoutCanvas() {
    laidOutBeats = contentBeats();
    const width = contentWidth();
    canvas.style.width = `${width}px`;
    canvas.style.height = `${ROWS * ROW_H}px`;
    ruler.style.width = `${width}px`;
    renderGrid();
  }

  // Bar and group lines are elements rather than a repeating gradient, which is a deliberate
  // downgrade in cleverness: a gradient repeats one period forever, and bars stop being one
  // period the moment an irregular meter turns up - let alone a meter change mid-song. Drawing
  // them one at a time costs a few hundred divs on a long song and makes 7/8 nothing special.
  //
  // The snap subdivision stays a gradient, because it is the one layer that genuinely is uniform
  // - a 1/16 is a 1/16 wherever it falls - and it is far and away the densest.
  let gridSignature = null;

  function renderGrid() {
    const beats = contentBeats();
    const px = pxPerWhole();
    const signature = `${beats}:${px}:${getSnapBeats()}:${getMeterId()}`;
    if (signature === gridSignature) return;
    gridSignature = signature;

    // The subdivision drops out once it would be denser than it is readable - below about seven
    // pixels it stops being a grid and becomes a texture - and again once it is no finer than
    // the pulse, where it would only be redrawing lines that are already there.
    const sub = getSnapBeats() * px;
    const pulsePx = pulseBeats() * px;
    grid.style.backgroundImage =
      sub >= 7 && sub < pulsePx - 0.5
        ? `repeating-linear-gradient(to right, var(--grid-sub) 0 1px, transparent 1px ${sub}px)`
        : 'none';

    grid.replaceChildren();
    const barPx = barBeats() * px;
    if (barPx < 3) return;
    for (const { beat } of barLinesBetween(0, beats)) {
      grid.appendChild(gridLine(beat, 'roll__line--bar'));
    }
    // Group lines need room to read as divisions of something rather than as more bars.
    if (barPx < 24) return;
    for (const beat of groupLinesBetween(0, beats)) {
      grid.appendChild(gridLine(beat, 'roll__line--group'));
    }
  }

  function gridLine(beat, modifier) {
    const line = document.createElement('div');
    line.className = `roll__line ${modifier}`;
    line.style.left = `${xForBeat(beat)}px`;
    return line;
  }

  function renderRuler() {
    ruler.replaceChildren();
    const barPx = barBeats() * pxPerWhole();
    // One number per bar while they fit, then every second, fourth, eighth... so the ruler
    // thins out under zoom instead of turning into a smear of digits.
    const every = Math.max(1, Math.pow(2, Math.ceil(Math.log2(46 / Math.max(barPx, 1)))));
    for (const { bar, beat } of barLinesBetween(0, contentBeats(), every)) {
      const tick = document.createElement('div');
      tick.className = 'roll__tick';
      tick.style.left = `${xForBeat(beat)}px`;
      tick.textContent = String(bar + 1);
      ruler.appendChild(tick);
    }
    for (const marker of song.getKeyMarkers()) {
      const flag = document.createElement('button');
      flag.type = 'button';
      flag.className = 'roll__key-flag';
      flag.style.left = `${xForBeat(marker.beat)}px`;
      flag.dataset.markerId = marker.id;
      flag.textContent = `${PITCH_CLASSES[marker.tonicPc]} ${scaleById(marker.scaleId).short}`;
      flag.title = 'Key change — click to edit';
      ruler.appendChild(flag);
    }
  }

  // --- notes ----------------------------------------------------------------------------------

  const noteEls = new Map(); // note id -> element, so a re-render moves rects instead of rebuilding
  const slideEls = new Map(); // and the ramp drawn into the front of a sliding note, the same way

  function styleNote(el, note, { ghost, selected, offset = 0, outside = false, canSlide = false }) {
    el.style.left = `${xForBeat(note.start + offset)}px`;
    el.style.width = `${Math.max(MIN_NOTE_PX, xForBeat(note.length) - 1)}px`;
    el.style.top = `${yForMidi(note.midi)}px`;
    el.style.setProperty('--hue', String(hueForPc(pcFromMidi(note.midi))));
    el.classList.toggle('roll-note--ghost', ghost);
    el.classList.toggle('roll-note--selected', selected);
    // Material that falls past where the part stops. Still drawn, and still editable, because
    // making it vanish would mean notes silently disappearing when a region was shortened - and
    // they are still in the part, so the honest thing is to show them and say they are not heard.
    el.classList.toggle('roll-note--outside', outside);
    // How hard it is struck, as how solid it looks. Not opacity, which would make a quiet note look
    // like a note belonging to another part; a filled bar with an unfilled remainder, so a run of
    // hats reads as a pattern of weights at a glance rather than as a row of identical rectangles.
    const velocity = note.velocity ?? 1;
    el.style.setProperty('--velocity', velocity.toFixed(3));
    el.classList.toggle('roll-note--soft', velocity < 0.995);
    // Whether there is a slide to be pulled out of the front of this one. Only ever set on the
    // active part's notes, and only drawn once the note is selected - see SLIDE_GRIP.
    el.classList.toggle('roll-note--can-slide', canSlide);
    const label = getInstrument(song.activeTrack()?.instrument?.type)?.noteLabel?.(note.midi);
    const name = label ?? noteName(octaveFromMidi(note.midi), pcFromMidi(note.midi));
    // The position in *song* time, which is where the rectangle actually is. A part's notes are
    // stored in its own time, so a part entering at bar 3 used to have every one of its notes claim
    // to be two bars earlier than the ruler above it said - and now that the note panel in the
    // sidebar says the same thing about the same note, the two would have disagreed out loud.
    el.title = `${name} · ${labelForBeats(note.length)} · at ${positionLabel(note.start + offset)}`
      + (velocity < 0.995 ? ` · ${Math.round(velocity * 100)}%` : '')
      + (note.slide > 0 ? ` · slide ${slideLabel(note)}` : '');
    // The name only goes in when the rect is wide enough to hold it; below that the colour and
    // the row are already saying which pitch it is.
    el.textContent = xForBeat(note.length) > 34 ? name : '';
  }

  /** How long a slide takes, said in the unit it means something in. */
  function slideLabel(note) {
    return `${Math.round(secondsForBeats(Math.min(note.slide, note.length), getBpm()) * 1000)}ms`;
  }

  /**
   * The slide, drawn as what it is: a line from the pitch the note leaves to the pitch it arrives
   * at, laid across the time it takes to get there.
   *
   * One rotated element rather than a diagonal painted into a box, because the angle here is
   * whatever a semitone-per-however-long happens to be - a gradient's idea of a diagonal is a
   * function of the box's aspect ratio, so the same slide would come out a different thickness at
   * every interval and every zoom. A line that is rotated is a line.
   *
   * It is also the handle. The ramp *is* the duration - dragging its far end is the only control
   * for one, and pulling it back to the note's own start is how a slide is taken off with the
   * mouse - so there is nothing to find beyond the thing you can already see.
   */
  function styleSlide(el, note, source, { ghost = false, offset = 0 }) {
    const beats = Math.min(note.slide, note.length);
    const dx = Math.max(1, xForBeat(beats));
    const dy = yForMidi(note.midi) - yForMidi(source.midi);
    el.style.left = `${xForBeat(note.start + offset)}px`;
    // The centre of the row it comes from; the element's own margin lifts the band onto it.
    el.style.top = `${yForMidi(source.midi) + ROW_H / 2}px`;
    el.style.width = `${Math.hypot(dx, dy)}px`;
    el.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    el.style.setProperty('--hue', String(hueForPc(pcFromMidi(note.midi))));
    el.classList.toggle('roll-slide--ghost', ghost);
    el.title = `slides from ${noteName(octaveFromMidi(source.midi), pcFromMidi(source.midi))} · ${slideLabel(note)}`;
  }

  function renderNotes() {
    const active = song.activeTrack();
    const seen = new Set();
    for (const track of song.getTracks()) {
      const ghost = !active || track.id !== active.id;
      // The material is drawn where the part begins, not at the origin. Before regions those were
      // the same beat for every part, which is why this used to be able to draw `note.start`
      // directly.
      const offset = song.trackBegin(track);
      const end = song.trackEnd(track);
      // Which note each of these would slide out of. The active part is asked whether or not
      // anything in it slides, because the answer is also what says which notes may be *offered* a
      // slide; the parts you are not editing are asked only when they have one to draw.
      const slides = instrumentSlides(track.instrument?.type);
      const sources =
        slides && (!ghost || track.notes.some((n) => n.slide > 0)) ? slideSources(track.notes) : null;
      for (const note of track.notes) {
        seen.add(note.id);
        let el = noteEls.get(note.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'roll-note';
          notesLayer.appendChild(el);
          noteEls.set(note.id, el);
        }
        el.dataset.noteId = note.id;
        el.dataset.trackId = track.id;
        styleNote(el, note, {
          ghost,
          selected: !ghost && song.isSelected(note.id),
          offset,
          outside: note.start + offset >= end - BEAT_EPSILON,
          canSlide: !ghost && Boolean(sources?.has(note.id)),
        });

        const source = note.slide > 0 ? sources?.get(note.id) : null;
        let ramp = slideEls.get(note.id);
        if (source && !ramp) {
          ramp = document.createElement('div');
          ramp.className = 'roll-slide';
          notesLayer.appendChild(ramp);
          slideEls.set(note.id, ramp);
        }
        if (source) {
          ramp.dataset.noteId = note.id;
          ramp.dataset.trackId = track.id;
          styleSlide(ramp, note, source, { ghost, offset });
        } else if (ramp) {
          // A slide dragged back to nothing, or a note that lost the one in front of it. The note
          // itself is still here, so this cannot wait for the sweep below.
          ramp.remove();
          slideEls.delete(note.id);
        }
      }
    }
    for (const [id, el] of noteEls) {
      if (seen.has(id)) continue;
      el.remove();
      noteEls.delete(id);
    }
    for (const [id, el] of slideEls) {
      if (seen.has(id)) continue;
      el.remove();
      slideEls.delete(id);
    }
    renderRepeats();
    renderStretchHandle();
  }

  // Every pass after the first, drawn rather than duplicated. They are output, not content:
  // faint, inert, and regenerated from the material every render, so there is no second copy of
  // anything to fall out of step with the first. The boundary rules are what make the structure
  // readable - without them a repeated part is just a wall of notes with no visible period.
  function renderRepeats() {
    repeatsLayer.replaceChildren();
    const active = song.activeTrack();
    for (const track of song.getTracks()) {
      const offsets = song.repeatOffsets(track);
      if (offsets.length < 2) continue;
      const isActive = active && track.id === active.id;

      const regionEnd = song.trackEnd(track);
      // Slides are regenerated per pass like everything else here. A pass that played the same
      // notes without their slides would sound like the first one and look like something else.
      const sources =
        instrumentSlides(track.instrument?.type) && track.notes.some((n) => n.slide > 0)
          ? slideSources(track.notes)
          : null;
      for (const offset of offsets.slice(1)) {
        for (const note of track.notes) {
          const el = document.createElement('div');
          el.className = 'roll-note roll-note--repeat';
          el.classList.toggle('roll-note--repeat-active', Boolean(isActive));
          // A pass can be cut short by the region's end, so the last one is often partial - which
          // is the point of a span rather than a count of whole passes.
          if (note.start + offset >= regionEnd - BEAT_EPSILON) continue;
          const length = Math.min(note.length, regionEnd - note.start - offset);
          el.style.left = `${xForBeat(note.start + offset)}px`;
          el.style.width = `${Math.max(MIN_NOTE_PX, xForBeat(length) - 1)}px`;
          el.style.top = `${yForMidi(note.midi)}px`;
          el.style.setProperty('--hue', String(hueForPc(pcFromMidi(note.midi))));
          repeatsLayer.appendChild(el);

          const source = note.slide > 0 ? sources?.get(note.id) : null;
          if (!source) continue;
          const ramp = document.createElement('div');
          ramp.className = 'roll-slide roll-slide--repeat';
          ramp.classList.toggle('roll-slide--repeat-active', Boolean(isActive));
          // The clipped length rather than the note's own, so a slide on a note the region cuts
          // short stops where the note does - which is what it will actually sound like.
          styleSlide(ramp, { ...note, length }, source, { offset });
          repeatsLayer.appendChild(ramp);
        }
        if (!isActive) continue;
        const rule = document.createElement('div');
        rule.className = 'roll__repeat-rule';
        rule.style.left = `${xForBeat(offset)}px`;
        rule.dataset.pass = `×${offsets.indexOf(offset) + 1}`;
        repeatsLayer.appendChild(rule);
      }
    }
  }

  // --- the fade lane --------------------------------------------------------------------------

  // The active part's region, drawn at the roll's scale, with its two fades as the corners.
  //
  // The same widget the rack row uses - see fade-lane.js - given the part's real width instead of 112
  // pixels. That is the whole point of it being one widget: the rack's copy is a summary you can read
  // four of at a glance, and this one is where a fade can be put on a beat, and neither can drift from
  // the other because there is only one of them.
  //
  // Its grid is the roll's own **Snap** menu rather than bars, because at this scale the roll's grid is
  // the grid you can see, and a control that ignored it would be the only thing on the surface that
  // does. ⇧ drops to the resolution, which is the finest the roll goes - the same fallback Snap Off
  // uses, for the same reason: there is no useful reading of a fade that ends between two of them.
  const fades = createFadeLane({
    height: LANE_BOX_H,
    snapFor: (event) => (event?.shiftKey ? getResolution() : getSnapBeats() || getResolution()),
    onGesture: () => song.pushUndo(),
    onFade: (key, value) => {
      const track = song.activeTrack();
      if (track) song.setTrackFades(track.id, { [key]: value });
    },
  });
  fades.element.classList.add('roll__fades');
  lane.appendChild(fades.element);

  function renderLane() {
    lane.style.width = `${contentWidth()}px`;
    const track = song.activeTrack();
    const span = track ? song.trackSpan(track) : 0;
    laneLabel.textContent = track?.name ?? '';
    laneLabel.title = track
      ? `${track.name} — its fade in and fade out, at the same scale as the grid`
      : '';
    // A part with no length yet has nothing to draw and nothing to drag; the box would be a sliver at
    // the origin, which reads as a bug rather than as an absence.
    fades.element.hidden = !(span > 0);
    if (!(span > 0)) return;
    fades.element.style.left = `${xForBeat(song.trackBegin(track))}px`;
    fades.show({
      span,
      fadeIn: song.trackFade(track, 'fadeIn'),
      fadeOut: song.trackFade(track, 'fadeOut'),
      width: xForBeat(span),
    });
  }

  // A handle at the trailing edge of the selection, and only when there is more than one note
  // in it - with a single note the ordinary resize grip is already there and means something
  // different, so showing both would be offering two readings of the same pixel.
  function renderStretchHandle() {
    const span = selectionSpan(song);
    if (!span || span.count < 2 || span.to <= span.from) {
      stretchEl.hidden = true;
      return;
    }
    stretchEl.hidden = false;
    stretchEl.style.left = `${xForBeat(span.to + song.trackBegin(song.activeTrack()))}px`;
    stretchEl.style.top = `${yForMidi(span.highMidi)}px`;
    stretchEl.style.height = `${(span.highMidi - span.lowMidi + 1) * ROW_H}px`;
    stretchEl.title = `Drag to stretch ${span.count} notes in time`;
  }

  function renderCursor() {
    // The key in force is read at the cursor, so moving it can re-shade the whole gutter - but
    // only when the cursor actually crosses a marker, which the signature check catches.
    applyKeyboardStyle();
    cursorEl.style.left = `${xForBeat(song.getCursor())}px`;
    pitchBand.style.top = `${yForMidi(song.getPitchCursor())}px`;
    for (const entry of rowEls) entry?.key.classList.remove('roll__key--cursor');
    rowEls[song.getPitchCursor()]?.key.classList.add('roll__key--cursor');
    cornerLabel.textContent = positionLabel(song.getCursor());
  }

  // --- the reference spectrum -------------------------------------------------------------------

  const spectrumLayer = createRollSpectrum({
    canvas: spectrum,
    scroller,
    // Read live rather than captured: zoom changes what xForBeat answers.
    metrics: {
      rows: ROWS,
      rowHeight: ROW_H,
      midiLow: MIDI_LOW,
      midiHigh: MIDI_HIGH,
      xForBeat,
      beatForX,
      yForMidi,
    },
  });
  const scheduleSpectrum = spectrumLayer.schedule;

  /**
   * What a change to the recording means here.
   *
   * Mostly it means one blit: a new floor, a different colour, a nudged alignment. But loading one,
   * dropping one, or changing the tempo under one can change how far the song runs - see
   * `contentBeats` - and that moves every bar line and renumbers the ruler. So the width is checked
   * against the width actually laid out, and the expensive half happens only when it really moved.
   */
  function syncReference() {
    if (contentBeats() !== laidOutBeats) {
      layoutCanvas();
      renderRuler();
    }
    scheduleSpectrum();
  }

  subscribeReference(syncReference);

  function renderAll() {
    applyKeyboardStyle(true);
    layoutCanvas();
    renderRuler();
    renderLane();
    renderNotes();
    renderCursor();
    scheduleSpectrum();
  }

  // --- scrolling ------------------------------------------------------------------------------

  scroller.addEventListener('scroll', () => {
    ruler.style.transform = `translateX(${-scroller.scrollLeft}px)`;
    lane.style.transform = `translateX(${-scroller.scrollLeft}px)`;
    keys.style.transform = `translateY(${-scroller.scrollTop}px)`;
    scheduleSpectrum();
  });

  // Zoom around the pointer rather than the scroll origin, so the bar you are looking at is
  // still under the cursor afterwards - otherwise zooming in at bar 40 throws you back to bar 1.
  //
  // Wheel travel is banked rather than acted on, and a notch is spent when enough has accumulated -
  // see ZOOM_WHEEL_PX for why. What is left over is kept, so a slow pinch still arrives; it just
  // takes the distance it should rather than the number of events the hardware happened to send.
  let zoomTravel = 0;

  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = wheelPixels(event);
      // Turning round is immediate. Travel banked one way should not have to be paid off before the
      // other way starts moving, or a pinch that went too far feels stuck when you try to correct it.
      if (delta * zoomTravel < 0) zoomTravel = 0;
      zoomTravel += delta;

      const notches = Math.trunc(zoomTravel / ZOOM_WHEEL_PX);
      if (!notches) return;
      zoomTravel -= notches * ZOOM_WHEEL_PX;

      const anchorBeat = beatForX(event.clientX - canvas.getBoundingClientRect().left);
      const offset = event.clientX - scroller.getBoundingClientRect().left;
      // Down the page is out, as it was. Several notches at once only happens on a device that
      // reports one big delta rather than a stream of small ones.
      const direction = notches > 0 ? -1 : 1;
      for (let i = Math.abs(notches); i > 0; i--) zoomBy(direction);
      scroller.scrollLeft = Math.max(0, xForBeat(anchorBeat) - offset);
    },
    { passive: false }
  );

  const viewport = createRollViewport({
    scroller,
    song,
    metrics: { rowHeight: ROW_H, xForBeat, yForMidi },
  });
  const { centerMidi, followInstrumentRange, revealBeat, revealMidi } = viewport;

  // --- gestures --------------------------------------------------------------------------------

  // One gesture object for every kind of drag, because they all share the same lifecycle:
  // arm on pointerdown, decide on the first real movement, commit continuously, tidy up on
  // release. Nothing is written to the song until the pointer has actually moved, so a click
  // that happens to wobble does not push an undo entry.
  let gesture = null;

  function noteRecords(ids) {
    const track = song.activeTrack();
    if (!track) return [];
    const wanted = new Set(ids);
    return track.notes.filter((n) => wanted.has(n.id)).map((n) => ({ ...n }));
  }

  function onCanvasPointerDown(event) {
    if (event.button !== 0) return;
    const point = pointIn(event);

    // Checked before notes, because the handle deliberately overlaps the last note's edge -
    // that is where the selection ends, and it is the place you would reach for.
    if (event.target.closest('.roll__stretch')) {
      const span = selectionSpan(song);
      if (span) {
        gesture = { kind: 'stretch', origin: point, span, before: noteRecords([...song.getSelection()]), started: false };
        canvas.setPointerCapture(event.pointerId);
      }
      return;
    }

    const active = song.activeTrack();

    // The ramp before the notes, because it deliberately lies over the front of the one it belongs
    // to - the whole point of it is that the slide is grabbed where it is drawn.
    const rampEl = event.target.closest('.roll-slide:not(.roll-slide--ghost)');
    if (rampEl && active && rampEl.dataset.trackId === active.id) {
      const note = active.notes.find((n) => n.id === rampEl.dataset.noteId);
      if (!note) return;
      if (!song.isSelected(note.id)) song.setSelection([note.id]);
      gesture = {
        kind: 'slide',
        origin: point,
        anchor: note.id,
        before: noteRecords([...song.getSelection()]),
        started: false,
      };
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    const noteEl = event.target.closest('.roll-note:not(.roll-note--repeat)');

    if (noteEl && active && noteEl.dataset.trackId === active.id) {
      const id = noteEl.dataset.noteId;
      const note = active.notes.find((n) => n.id === id);
      if (!note) return;

      // Whether it was selected *before* this press, which is what decides whether the leading edge
      // is a slide grip. The grip is only drawn on a selected note, and a pixel that does something
      // other than what it looks like it does is worse than no grip at all - so the click that
      // selects a note is always an ordinary click on it, and the one after it can slide.
      const wasSelected = song.isSelected(id);

      // Shift extends the selection; clicking an unselected note replaces it. Clicking one
      // that is already selected leaves the set alone, so a drag can move a whole chord.
      if (event.shiftKey) song.toggleSelected(id);
      else if (!wasSelected) song.setSelection([id]);

      // In song time, both of them. A part can begin anywhere now, and its notes are stored in its
      // own time and drawn shifted by where it starts - so an edge worked out from `note.start`
      // alone is the edge the note would have had if the part began at the top of the song, which
      // for a part that enters at bar 5 is several hundred pixels to the left of the rectangle you
      // are pointing at. Everything the pointer is compared against has to be where the pointer is.
      const offset = song.trackBegin(active);
      const leftEdge = xForBeat(note.start + offset);
      const rightEdge = xForBeat(note.start + offset + note.length);
      let mode = 'move';
      if (event.altKey) mode = 'velocity';
      else if (point.x >= rightEdge - RESIZE_GRIP) mode = 'resize';
      else if (
        wasSelected
        && noteEl.classList.contains('roll-note--can-slide')
        && rightEdge - leftEdge >= SLIDE_MIN_NOTE_PX
        && point.x <= leftEdge + SLIDE_GRIP
      ) mode = 'slide';
      const ids = song.isSelected(id) ? [...song.getSelection()] : [id];
      gesture = {
        kind: mode,
        origin: point,
        anchor: note.id,
        before: noteRecords(ids),
        started: false,
      };
      song.setPitchCursor(note.midi);
      song.setCursor(note.start + offset);
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    // Empty space: put the cursor here and start a marquee. Both at once is safe because the
    // marquee only becomes a marquee once the pointer moves, and a cursor move is what a plain
    // click meant anyway.
    song.setCursor(snap(beatForX(point.x)));
    song.setPitchCursor(midiForY(point.y));
    const kept = event.shiftKey ? [...song.getSelection()] : [];
    if (!event.shiftKey) song.clearSelection();
    gesture = { kind: 'marquee', origin: point, additive: event.shiftKey, kept, started: false };
    canvas.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerMove(event) {
    if (!gesture) return;
    const point = pointIn(event);
    if (!gesture.started) {
      if (Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) < DRAG_THRESHOLD) return;
      gesture.started = true;
      if (gesture.kind !== 'marquee') song.pushUndo();
    }

    if (gesture.kind === 'marquee') return dragMarquee(point);
    if (gesture.kind === 'move') return dragMove(point);
    if (gesture.kind === 'stretch') return dragStretch(point);
    if (gesture.kind === 'slide') return dragSlide(point);
    if (gesture.kind === 'velocity') return dragVelocity(point);
    return dragResize(point);
  }

  // The factor is simply where the pointer is, measured against where the selection starts, so
  // dragging the handle to twice its distance from the first note takes the passage to
  // half-time. Lengths and gaps scale together - see stretchSelection, which is the same
  // arithmetic for the keyboard.
  //
  // The scaled starts go through quantizeTime for the same reason the keyboard's do: scaling is
  // the one edit that lands a start on a position no snap grid would have chosen, and a passage
  // sitting on numbers that agree with nothing is exactly what the resolution exists to prevent.
  // updateNote already puts the lengths there.
  function dragStretch(point) {
    const { span } = gesture;
    const offset = song.trackBegin(song.activeTrack());
    const wanted = beatForX(point.x) - offset - span.from;
    const factor = Math.max(0.05, wanted / (span.to - span.from));
    const track = song.activeTrack();
    if (!track) return;
    for (const before of gesture.before) {
      song.updateNote(track.id, before.id, {
        start: quantizeTime(span.from + (before.start - span.from) * factor),
        length: before.length * factor,
      });
    }
  }

  // Everything selected moves by the same delta, computed from the note actually under the
  // pointer: snapping each note to the grid on its own would collapse a chord's internal
  // offsets the moment one of them was off-grid.
  function dragMove(point) {
    const track = song.activeTrack();
    if (!track) return;
    const anchor = gesture.before.find((n) => n.id === gesture.anchor);
    const rawStart = anchor.start + beatForX(point.x - gesture.origin.x);
    let deltaBeats = snap(rawStart) - anchor.start;
    let deltaMidi = -Math.round((point.y - gesture.origin.y) / ROW_H);

    // Clamp the delta, not the notes: a chord dragged into the floor should stop as one shape
    // rather than pile up on the bottom row.
    for (const before of gesture.before) {
      deltaBeats = Math.max(deltaBeats, -before.start);
      deltaMidi = Math.max(deltaMidi, MIDI_LOW - before.midi);
      deltaMidi = Math.min(deltaMidi, MIDI_HIGH - before.midi);
    }

    let auditioned = false;
    for (const before of gesture.before) {
      const midi = before.midi + deltaMidi;
      song.updateNote(track.id, before.id, { start: before.start + deltaBeats, midi });
      if (before.id === gesture.anchor && midi !== gesture.lastMidi) {
        gesture.lastMidi = midi;
        auditioned = true;
      }
    }
    if (auditioned) auditionNote(track, gesture.lastMidi, AUDITION_SECONDS);
    song.setCursor(anchor.start + deltaBeats);
    song.setPitchCursor(anchor.midi + deltaMidi);
  }

  // Resizing snaps to the durations the notation has names for rather than to the grid, so a
  // note can never end up a length there is no way to write down. updateNote does the snapping;
  // this only has to hand it the length the pointer is asking for.
  function dragResize(point) {
    const track = song.activeTrack();
    if (!track) return;
    const offset = song.trackBegin(track);
    const anchor = gesture.before.find((n) => n.id === gesture.anchor);
    const wanted = Math.max(BEAT_EPSILON, beatForX(point.x) - offset - anchor.start);
    const scale = wanted / anchor.length;
    for (const before of gesture.before) {
      song.updateNote(track.id, before.id, { length: before.length * scale });
    }
  }

  /**
   * How long the slide takes: wherever the pointer is, measured from the note's own start.
   *
   * Absolute rather than scaled, which is the opposite of what a resize does to a selection, and it
   * is the right way round for this: lengths are a rhythm and have to keep their proportions, while
   * a slide is a transition time and a chord's worth of them should be one number. Dragged back to
   * the note's start it reaches zero, and a zero slide is no slide - so the gesture that makes one
   * is also the one that takes it away.
   *
   * Nothing here goes on the resolution grid. See DEFAULT_SLIDE in song.js: a slide lines up with
   * nothing and nothing lines up with it.
   */
  function dragSlide(point) {
    const track = song.activeTrack();
    if (!track) return;
    const offset = song.trackBegin(track);
    const anchor = gesture.before.find((n) => n.id === gesture.anchor);
    const wanted = Math.max(0, beatForX(point.x) - offset - anchor.start);
    // Re-read rather than captured, because a note whose predecessor is not in the selection can
    // still be dragged - and one with no predecessor at all has nothing to slide out of, however
    // much of the selection it is in.
    const sources = slideSources(track.notes);
    for (const before of gesture.before) {
      if (!sources.has(before.id)) continue;
      song.updateNote(track.id, before.id, { slide: Math.min(wanted, before.length) });
    }
  }

  /**
   * How hard the selection is struck, dragged rather than typed.
   *
   * Relative, for the reason `nudgeVelocity` is: a selection that is already shaped stays shaped,
   * and one drag over a bar of hats moves the whole contour instead of flattening it to whatever
   * the pointer happens to be level with. Vertical only - the notes do not move, which is why this
   * is a modifier on the same press rather than a mode you have to leave.
   */
  function dragVelocity(point) {
    const track = song.activeTrack();
    if (!track) return;
    const delta = (gesture.origin.y - point.y) / VELOCITY_DRAG_PX;
    for (const before of gesture.before) {
      song.updateNote(track.id, before.id, { velocity: (before.velocity ?? 1) + delta });
    }
  }

  function dragMarquee(point) {
    const left = Math.min(point.x, gesture.origin.x);
    const top = Math.min(point.y, gesture.origin.y);
    const width = Math.abs(point.x - gesture.origin.x);
    const height = Math.abs(point.y - gesture.origin.y);
    marquee.hidden = false;
    marquee.style.left = `${left}px`;
    marquee.style.top = `${top}px`;
    marquee.style.width = `${width}px`;
    marquee.style.height = `${height}px`;

    const track = song.activeTrack();
    if (!track) return;
    // Into the part's own time before comparing. The marquee is drawn in song pixels and the notes
    // are stored at material positions, and those stopped being the same thing when parts got a
    // begin - a lasso over a part that enters at bar 5 was selecting whatever sat five bars earlier
    // in its material.
    const offset = song.trackBegin(track);
    const fromBeat = beatForX(left) - offset;
    const toBeat = beatForX(left + width) - offset;
    const highMidi = midiForY(top);
    const lowMidi = midiForY(top + height);
    const hit = track.notes
      .filter(
        (n) =>
          n.start < toBeat &&
          n.start + n.length > fromBeat &&
          n.midi <= highMidi &&
          n.midi >= lowMidi
      )
      .map((n) => n.id);
    song.setSelection(gesture.additive ? [...gesture.kept, ...hit] : hit);
  }

  function onCanvasPointerUp(event) {
    if (!gesture) return;
    marquee.hidden = true;
    // The handle moved with the notes while they scaled; put it back where the selection now
    // ends rather than where the pointer left it.
    if (gesture.kind === 'stretch') renderStretchHandle();
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    gesture = null;
  }

  function onCanvasDoubleClick(event) {
    const noteEl = event.target.closest('.roll-note');
    const active = song.activeTrack();
    if (!active) return;
    song.pushUndo();
    if (noteEl && noteEl.dataset.trackId === active.id) {
      song.removeNotes(active.id, [noteEl.dataset.noteId]);
      return;
    }
    const point = pointIn(event);
    const midi = midiForY(point.y);
    // The cursor moved here on the first click of the double, so newNoteLength is already
    // reading the right moment - which is the whole reason the rule is worth having.
    const note = song.addNote(active.id, {
      midi,
      start: song.sourceBeat(active.id, snap(beatForX(point.x))),
      length: song.newNoteLength(),
    });
    song.setSelection([note.id]);
    auditionNote(active, midi, AUDITION_SECONDS);
  }

  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerup', onCanvasPointerUp);
  canvas.addEventListener('pointercancel', onCanvasPointerUp);
  canvas.addEventListener('dblclick', onCanvasDoubleClick);

  // --- ruler ------------------------------------------------------------------------------------

  let scrubbing = false;

  rulerView.addEventListener('pointerdown', (event) => {
    const flag = event.target.closest('.roll__key-flag');
    if (flag) return; // the flag's own click handler deals with it
    scrubbing = true;
    rulerView.setPointerCapture(event.pointerId);
    scrubTo(event);
  });

  rulerView.addEventListener('pointermove', (event) => {
    if (scrubbing) scrubTo(event);
  });

  rulerView.addEventListener('pointerup', (event) => {
    scrubbing = false;
    if (rulerView.hasPointerCapture?.(event.pointerId)) rulerView.releasePointerCapture(event.pointerId);
  });

  function scrubTo(event) {
    const rect = rulerView.getBoundingClientRect();
    song.setCursor(snap(beatForX(event.clientX - rect.left + scroller.scrollLeft)));
  }

  let onKeyFlagClick = null;
  ruler.addEventListener('click', (event) => {
    const flag = event.target.closest('.roll__key-flag');
    if (flag) onKeyFlagClick?.(flag.dataset.markerId, flag);
  });

  // --- wiring ------------------------------------------------------------------------------------

  song.subscribe((kind) => {
    if (kind === CHANGE.TRACKS) followInstrumentRange();
    if (kind === CHANGE.CURSOR) renderCursor();
    else if (kind === CHANGE.KEYS) {
      renderRuler();
      renderCursor();
    } else {
      layoutCanvas();
      renderRuler();
      renderLane();
      renderNotes();
      renderCursor();
    }
  });

  subscribeTimeScale(() => renderAll());
  // Snap sets the subdivision lines, so changing it redraws the grid.
  subscribeGrid(() => layoutCanvas());
  // The meter moves every line and renumbers every bar, and the corner readout with them.
  subscribeMeter(() => renderAll());
  renderAll();

  return {
    element,
    refresh: renderAll,
    // The tempo is half of where the recording sits against the bars - and, through the length a
    // recording covers in bars, half of how wide the roll is. Nothing else here depends on it, so a
    // tempo change goes through the reference's own path rather than redrawing the whole surface.
    refreshReference: syncReference,
    revealBeat,
    revealMidi,
    centerMidi,
    /** Where the playhead is drawn, in beats; null hides it. */
    setPlayhead(beat) {
      if (beat === null) {
        playheadEl.hidden = true;
        return;
      }
      playheadEl.hidden = false;
      playheadEl.style.left = `${xForBeat(beat)}px`;
    },
    onKeyFlag(fn) {
      onKeyFlagClick = fn;
    },
    /** Pixel position of a beat within the scroller, for anchoring popovers to the ruler. */
    screenXForBeat(beat) {
      return xForBeat(beat) - scroller.scrollLeft + GUTTER_W;
    },
  };
}
