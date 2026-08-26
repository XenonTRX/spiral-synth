// The voice panel, built from whatever the instrument says it has.
//
// There used to be a slider in index.html, an entry in a table in main.js and a clamp in audio.js
// for every parameter, and adding one meant editing three files that had to agree. They already
// didn't: the cutoff slider stopped at 12kHz while the clamp allowed 20k. Now the instrument
// declares its parameters once and this builds controls for them, so a new knob - or a whole new
// instrument - needs no edit here at all.
//
// Rows are built once per instrument and then patched, for the same reason the rack patches its
// rows: replacing a live element destroys it, and an element replaced mid-drag ends the drag. A
// slider that rebuilt itself on every input event would move once and then stop.

import { CHANGE } from './song.js';
import { cssVar } from './theme.js';
import { getInstrument, instrumentList, paramToUnit, unitToParam } from './instruments.js';
// The rows themselves are built by param-controls.js, which the effects panel uses too - the two were
// the same forty lines, including the same three things that are easy to get subtly wrong.
import { UNIT_STEPS, buildParamRow, showParamValue } from './param-controls.js';
import { MAX_ROUTINGS, MOD_SOURCES, depthParam, modSource, modTargetParams } from './modulation.js';


// What a new routing starts at. Not zero, which would be the tidy answer and the wrong one: pressing
// Add would appear to do nothing, and a depth of zero is dropped when the song is read back, so it
// would also silently fail to survive a reload. A quarter of the range is audible and keeps.
const NEW_ROUTING_FRACTION = 0.25;

export function createSynthPanel({ song, onChange }) {
  const element = document.createElement('div');
  element.className = 'synth-panel';

  const heading = document.createElement('h3');
  element.appendChild(heading);

  const picker = document.createElement('div');
  picker.className = 'synth-row';
  const pickerLabel = document.createElement('label');
  pickerLabel.textContent = 'Instrument';
  const pickerSelect = document.createElement('select');
  picker.append(pickerLabel, pickerSelect);
  pickerSelect.addEventListener('change', () => {
    const track = song.activeTrack();
    if (track) song.setInstrument(track.id, pickerSelect.value);
  });

  const presets = document.createElement('div');
  presets.className = 'synth-presets';

  // Somewhere for an instrument to draw itself, if it has anything to draw. Created unconditionally
  // and hidden when unused, because building it lazily would mean the one instrument that wants it
  // gets a canvas with no layout on its first frame.
  const displayHost = document.createElement('figure');
  displayHost.className = 'synth-display';
  const displayCanvas = document.createElement('canvas');
  const displayCaption = document.createElement('figcaption');
  displayHost.append(displayCanvas, displayCaption);

  const rowHost = document.createElement('div');
  rowHost.className = 'synth-rows';

  // The matrix, and then the knobs belonging to whichever sources it is using. In that order because
  // a routing is what brings a source into existence - showing eleven idle source knobs above the
  // thing that gives them a purpose would bury the instrument's own controls under machinery.
  const modHost = document.createElement('div');
  modHost.className = 'mod-matrix';
  const modHeading = document.createElement('div');
  modHeading.className = 'mod-matrix__heading';
  const modTitle = document.createElement('span');
  modTitle.textContent = 'Modulation';
  const addRouting = document.createElement('button');
  addRouting.type = 'button';
  addRouting.className = 'btn btn--ghost btn--small';
  addRouting.textContent = '+ Route';
  modHeading.append(modTitle, addRouting);
  const modRows = document.createElement('div');
  modRows.className = 'mod-rows';
  const modEmpty = document.createElement('p');
  modEmpty.className = 'mod-empty';
  modEmpty.textContent = 'Nothing routed. Add one to make a parameter move.';
  modHost.append(modHeading, modRows, modEmpty);

  const sourceHost = document.createElement('div');
  sourceHost.className = 'synth-rows';

  const note = document.createElement('p');
  note.className = 'dropdown-panel__note';
  note.textContent = 'Every part has its own voice — switch parts in the rack and this panel follows.';

  element.append(picker, presets, displayHost, rowHost, modHost, sourceHost, note);

  // Which instrument the rows currently describe, so they are only thrown away when that changes.
  let builtFor = null;
  const controls = new Map();
  const depthControls = [];
  // What shape the matrix had when its rows were built. Depth changes deliberately do not appear
  // here: a depth is a slider, rebuilding a range input mid-drag ends the drag, and the drag is the
  // whole point of the control. Only adding, removing or re-pointing a routing rebuilds.
  let builtMatrix = null;

  function writeParam(key, value) {
    const track = song.activeTrack();
    if (!track) return;
    track.instrument.state[key] = value;
    // Only the picture, not the rows. render() would rebuild controls underneath the pointer and
    // end the drag, and the drag is exactly when watching the waveform is worth anything.
    drawDisplay();
    onChange?.(key);
  }

  /**
   * Redraw the instrument's own picture, if it has one.
   *
   * Sized here rather than in CSS because a canvas has two sizes - the box it occupies and the
   * pixels it contains - and only the second one is what gets drawn on. Measured every time because
   * the panel's width changes with the viewport, and a canvas that kept its first measurement would
   * be blurry at every other width.
   */
  function drawDisplay() {
    const track = song.activeTrack();
    if (!track || displayHost.hidden) return;
    const definition = getInstrument(track.instrument.type);
    const display = definition?.display;
    if (!display) return;

    const width = displayCanvas.clientWidth;
    if (!width) return;
    const height = display.height ?? 108;
    const dpr = window.devicePixelRatio || 1;
    if (displayCanvas.width !== Math.round(width * dpr) || displayCanvas.height !== Math.round(height * dpr)) {
      displayCanvas.width = Math.round(width * dpr);
      displayCanvas.height = Math.round(height * dpr);
      displayCanvas.style.height = `${height}px`;
    }
    const ctx2d = displayCanvas.getContext('2d');
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    display.draw(ctx2d, track.instrument.state, {
      width,
      height,
      colors: {
        accent: cssVar('--accent', '#7dd3fc'),
        dim: cssVar('--text-dim', '#9aa0b0'),
        grid: cssVar('--grid-beat', 'rgba(255,255,255,0.08)'),
        ghost: 'rgba(255,255,255,0.18)',
      },
    });

    const caption = display.caption?.(track.instrument.state) ?? '';
    if (displayCaption.textContent !== caption) displayCaption.textContent = caption;
  }

  function buildRows(definition) {
    rowHost.replaceChildren();
    sourceHost.replaceChildren();
    controls.clear();

    for (const param of definition.params) {
      const control = buildParamRow(param, { onChange: (value) => writeParam(param.key, value) });
      controls.set(param.key, control);
      (param.modSource ? sourceHost : rowHost).appendChild(control.row);
    }
  }

  /** Read the live matrix, always as an array, so callers never have to check. */
  function matrixOf(track) {
    const mod = track?.instrument?.state?.mod;
    return Array.isArray(mod) ? mod : null;
  }

  const matrixSignature = (matrix) => matrix.map((r) => `${r.source}>${r.target}`).join('|');

  function writeMatrix(track, mutate) {
    const matrix = matrixOf(track);
    if (!matrix) return;
    mutate(matrix);
    onChange?.('mod');
    render();
  }

  /**
   * One routing: a source, a destination, a depth, and a way to be rid of it.
   *
   * The depth slider is rebuilt from the destination's unit every time the destination changes, since
   * ±5 octaves and ±24 semitones are not the same control - which is also why changing a destination
   * resets the depth rather than carrying a number across into a scale where it means something else.
   */
  function buildRoutingRow(definition, routing, index) {
    const targets = modTargetParams(definition);
    const row = document.createElement('div');
    row.className = 'mod-row';

    const sourceSelect = document.createElement('select');
    for (const source of MOD_SOURCES) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label;
      if (source.help) option.title = source.help;
      sourceSelect.appendChild(option);
    }
    sourceSelect.value = routing.source;
    sourceSelect.title = modSource(routing.source)?.help ?? '';
    sourceSelect.addEventListener('change', () => {
      writeMatrix(song.activeTrack(), (matrix) => {
        matrix[index].source = sourceSelect.value;
      });
    });

    const arrow = document.createElement('span');
    arrow.className = 'mod-row__arrow';
    arrow.textContent = '→';

    const targetSelect = document.createElement('select');
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.key;
      option.textContent = target.label;
      targetSelect.appendChild(option);
    }
    targetSelect.value = routing.target;
    targetSelect.addEventListener('change', () => {
      writeMatrix(song.activeTrack(), (matrix) => {
        const next = targets.find((param) => param.key === targetSelect.value);
        matrix[index].target = targetSelect.value;
        matrix[index].depth = depthParam(next).max * NEW_ROUTING_FRACTION;
      });
    });

    const targetParam = targets.find((param) => param.key === routing.target) ?? targets[0];
    const depth = depthParam(targetParam);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(UNIT_STEPS);
    slider.step = '1';
    const readout = document.createElement('span');
    readout.className = 'mod-row__value';
    slider.addEventListener('input', () => {
      let value = unitToParam(depth, Number(slider.value) / UNIT_STEPS);
      if (depth.step) value = Math.round(value / depth.step) * depth.step;
      value = Math.max(depth.min, Math.min(depth.max, value));
      readout.textContent = depth.format(value);
      // Written straight into the live matrix rather than through writeMatrix, because a re-render
      // mid-drag would replace this very slider and the drag would stop at the first pixel.
      const matrix = matrixOf(song.activeTrack());
      if (matrix?.[index]) matrix[index].depth = value;
      onChange?.('mod');
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mod-row__remove';
    remove.textContent = '×';
    remove.title = 'Remove this routing';
    remove.addEventListener('click', () => {
      writeMatrix(song.activeTrack(), (matrix) => {
        matrix.splice(index, 1);
      });
    });

    row.append(sourceSelect, arrow, targetSelect, slider, readout, remove);
    return { row, depth, slider, readout };
  }

  function buildMatrix(definition, matrix) {
    modRows.replaceChildren();
    depthControls.length = 0;
    for (let index = 0; index < matrix.length; index++) {
      const built = buildRoutingRow(definition, matrix[index], index);
      depthControls.push(built);
      modRows.appendChild(built.row);
    }
    modEmpty.hidden = matrix.length > 0;
    addRouting.disabled = matrix.length >= MAX_ROUTINGS;
    addRouting.title =
      matrix.length >= MAX_ROUTINGS ? `${MAX_ROUTINGS} routings is the limit` : 'Route a source to a parameter';
  }

  addRouting.addEventListener('click', () => {
    const track = song.activeTrack();
    const definition = getInstrument(track?.instrument?.type);
    if (!definition) return;
    const targets = modTargetParams(definition);
    if (!targets.length) return;
    writeMatrix(track, (matrix) => {
      if (matrix.length >= MAX_ROUTINGS) return;
      // The first destination that nothing is already pointing at, so pressing Add twice gives two
      // different routings rather than two of the same one.
      const target = targets.find((param) => !matrix.some((r) => r.target === param.key)) ?? targets[0];
      matrix.push({
        source: MOD_SOURCES[0].id,
        target: target.key,
        depth: depthParam(target).max * NEW_ROUTING_FRACTION,
      });
    });
  });

  function buildPresets(definition) {
    presets.replaceChildren();
    for (const preset of definition.presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--ghost';
      button.textContent = preset.name;
      button.addEventListener('click', () => {
        const track = song.activeTrack();
        if (track) song.setInstrument(track.id, definition.id, preset.state);
      });
      presets.appendChild(button);
    }
  }

  function render() {
    const track = song.activeTrack();
    if (!track) return;
    const definition = getInstrument(track.instrument.type);
    if (!definition) return;

    heading.textContent = `Voice for ${track.name}`;

    const all = instrumentList();
    // A picker with one entry is a label pretending to be a control.
    picker.hidden = all.length < 2;
    if (!picker.hidden && pickerSelect.children.length !== all.length) {
      pickerSelect.replaceChildren();
      for (const instrument of all) {
        const option = document.createElement('option');
        option.value = instrument.id;
        option.textContent = instrument.name;
        pickerSelect.appendChild(option);
      }
    }
    pickerSelect.value = definition.id;

    if (builtFor !== definition.id) {
      buildRows(definition);
      buildPresets(definition);
      builtFor = definition.id;
      builtMatrix = null;
    }

    displayHost.hidden = !definition.display;
    drawDisplay();

    const matrix = matrixOf(track);
    // An instrument with nothing to modulate has no matrix and is not shown one.
    modHost.hidden = !matrix || !definition.modTargets?.length;
    if (matrix && !modHost.hidden) {
      const signature = matrixSignature(matrix);
      if (signature !== builtMatrix) {
        buildMatrix(definition, matrix);
        builtMatrix = signature;
      }
      for (let index = 0; index < depthControls.length; index++) {
        const control = depthControls[index];
        const value = matrix[index]?.depth ?? 0;
        const unit = String(Math.round(paramToUnit(control.depth, value) * UNIT_STEPS));
        if (control.slider.value !== unit) control.slider.value = unit;
        control.readout.textContent = control.depth.format(value);
      }
    }

    // A source's own knobs appear once something is using it. Eleven of them on display at all times
    // would be most of the panel, and idle.
    const inUse = new Set(matrix?.map((routing) => routing.source));
    for (const [key, control] of controls) {
      if (control.param.modSource) control.row.hidden = !inUse.has(control.param.modSource);
      showParamValue(control, track.instrument.state[key], track.instrument.state);
    }
  }

  song.subscribe((kind) => {
    if (kind === CHANGE.TRACKS) render();
  });
  render();

  return { element, refresh: render };
}
