// The controls for the recording you are transcribing.
//
// Three columns, and the split is by how often you touch them rather than by what they do inside.
// **Layer** is set once and left. **Transform** is what you reach for when the picture is not
// showing you what you need - a bass part wants a long window, a hi-hat pattern wants a short one,
// and no single setting is right for both. **Isolate** is the one you live in: a range of notes,
// whether the monitor is limited to it, and how loud the record is against what you have written.
//
// Rows are built by param-controls.js from the declarations in reference.js, exactly as the synth
// and effects panels are built from theirs. That is not tidiness for its own sake - it is what makes
// a logarithmic control logarithmic, a stepped one stepped, and a readout formatted, without three
// more copies of the same forty lines.

import { buildParamRow, showParamValue } from './param-controls.js';
import {
  REFERENCE_PARAMS,
  applyTempoCandidate,
  clearReference,
  detectTempo,
  getTempoDetection,
  getAnchorSeconds,
  getReferenceState,
  getReferenceStatus,
  hasReference,
  loadReferenceFile,
  referenceAnalysis,
  referenceBuffer,
  referenceName,
  setAnchorSeconds,
  setReferenceParam,
  subscribeReference,
} from './reference.js';
import { secondsForBeats } from './music-theory.js';
import { getBpm } from './tempo.js';
import { barBeats } from './meter.js';

const GROUPS = [
  ['layer', 'Layer', 'How the picture is drawn over the roll.'],
  ['analysis', 'Transform', 'What the recording is put through to become a picture. Every one of these costs a re-analysis.'],
  ['isolate', 'Isolate', 'The slice of the record you are working on, on screen and in your ears.'],
];

// How far one press of a nudge button moves the alignment. Ten milliseconds is about the finest
// flam anyone hears; one is finer than that and is there for the last pass.
const NUDGES = [-0.01, -0.001, 0.001, 0.01];

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function createReferencePanel({ song, setBpm }) {
  const element = document.createElement('div');
  element.className = 'reference';

  // --- the file ---------------------------------------------------------------------------------

  const picker = document.createElement('input');
  picker.type = 'file';
  // Whatever the browser's own decoder reads. Naming extensions here would be a second, wronger
  // list than the one the decoder actually has - see loadReferenceFile.
  picker.accept = 'audio/*';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) loadReferenceFile(file);
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn btn--primary';
  importBtn.textContent = 'Import audio…';
  importBtn.title = 'A wav, an mp3, or anything else this browser can decode. Drop one on the roll instead if you prefer.';
  importBtn.addEventListener('click', () => picker.click());

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn--ghost';
  clearBtn.textContent = 'Remove';
  clearBtn.addEventListener('click', () => clearReference());

  const fileMeta = document.createElement('span');
  fileMeta.className = 'reference__meta';

  const fileRow = document.createElement('div');
  fileRow.className = 'reference__file';
  fileRow.append(importBtn, fileMeta, clearBtn, picker);
  element.appendChild(fileRow);

  const status = document.createElement('div');
  status.className = 'reference__status';
  const bar = document.createElement('div');
  bar.className = 'reference__bar';
  const barFill = document.createElement('div');
  barFill.className = 'reference__bar-fill';
  bar.appendChild(barFill);
  const statusText = document.createElement('span');
  status.append(bar, statusText);
  element.appendChild(status);

  // --- alignment --------------------------------------------------------------------------------
  //
  // The one number that is not a declared parameter, because a slider cannot hold it. Lining a
  // recording up with a bar line is a millisecond-scale job over a range of minutes, and no taper
  // gives you both ends of that under one thumb. So it is a number box and four nudges, which is
  // what every DAW ends up with for the same reason.

  const alignRow = document.createElement('div');
  alignRow.className = 'reference__align';
  const alignLabel = document.createElement('label');
  alignLabel.textContent = 'Align';
  alignLabel.title =
    'Where in the recording bar 1 falls, in seconds. Positive skips into the file; negative leaves room before it starts.';
  const alignInput = document.createElement('input');
  alignInput.type = 'number';
  alignInput.step = '0.001';
  alignInput.addEventListener('input', () => setAnchorSeconds(Number(alignInput.value)));

  const nudges = document.createElement('div');
  nudges.className = 'reference__nudges';
  for (const step of NUDGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--tiny';
    button.textContent = `${step > 0 ? '+' : '−'}${Math.abs(step) * 1000}`;
    button.title = `Move the recording ${Math.abs(step) * 1000}ms ${step > 0 ? 'later' : 'earlier'} against the bars`;
    button.addEventListener('click', () => setAnchorSeconds(getAnchorSeconds() + step));
    nudges.appendChild(button);
  }

  // A beat-sized nudge, which is the one you want straight after detecting a tempo: the detector
  // finds the pulse but not which pulse is beat one of a bar, and telling those apart is a much
  // harder problem than finding the pulse at all. Moving by exactly one beat is how you say it
  // yourself, and it takes one or two presses.
  for (const step of [-1, 1]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--tiny';
    button.textContent = `${step > 0 ? '+' : '−'}1\u2669`;
    button.title = `Move the recording one beat ${step > 0 ? 'later' : 'earlier'} — for finding the downbeat once the pulse is right`;
    button.addEventListener('click', () => setAnchorSeconds(getAnchorSeconds() + step * secondsForBeats(0.25, getBpm())));
    nudges.appendChild(button);
  }

  const atCursor = document.createElement('button');
  atCursor.type = 'button';
  atCursor.className = 'btn btn--ghost btn--tiny';
  atCursor.textContent = 'At cursor';
  atCursor.title = 'Put the start of the recording where the cursor is. The usual first move: park the cursor on the bar the music should start on and press this.';
  atCursor.addEventListener('click', () => setAnchorSeconds(-secondsForBeats(song.getCursor(), getBpm())));
  nudges.appendChild(atCursor);

  alignRow.append(alignLabel, alignInput, nudges);
  element.appendChild(alignRow);

  // --- what tempo is it -----------------------------------------------------------------------

  const detect = document.createElement('div');
  detect.className = 'reference__detect';

  const detectBtn = document.createElement('button');
  detectBtn.type = 'button';
  detectBtn.className = 'btn btn--ghost';
  detectBtn.textContent = 'Detect tempo';
  detectBtn.title =
    'Find the pulse of the recording and offer the tempos that fit it. Always measured on the full mix, whatever Channel is set to — Side cancels the kick and the snare, which is the beat.';
  detectBtn.addEventListener('click', () => detectTempo());

  const detectStatus = document.createElement('span');
  detectStatus.className = 'reference__meta';

  const candidates = document.createElement('div');
  candidates.className = 'reference__candidates';

  detect.append(detectBtn, candidates, detectStatus);
  element.appendChild(detect);

  /**
   * The offered tempos, as buttons.
   *
   * A list rather than an answer, because the ambiguity is real: a track with a hi-hat on every
   * eighth fits 174 exactly as well as it fits 87, and the two are usually both in this list. The
   * match figure is the plain correlation with the prior taken back out, so it says how well the
   * recording fits that tempo rather than how much the detector wanted it.
   */
  let shownCandidates = null;

  function showCandidates(found) {
    // Rebuilt only when the list really changed. `refresh` runs on every reference change, opacity
    // drags included, and replacing a button under the pointer cancels the click you were making.
    const signature = found.map((c) => c.bpm.toFixed(4)).join(',');
    if (signature === shownCandidates) return;
    shownCandidates = signature;
    candidates.replaceChildren();
    for (const candidate of found) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'btn btn--tiny reference__candidate';
      chip.textContent = `${candidate.bpm.toFixed(2)} BPM`;
      const match = document.createElement('em');
      match.textContent = `${Math.round(Math.max(0, candidate.match) * 100)}%`;
      chip.appendChild(match);
      chip.title = `Set the tempo to ${candidate.bpm.toFixed(2)} and put its first beat on bar 1. Then ±1\u2669 to find the downbeat.`;
      chip.addEventListener('click', () => applyTempoCandidate(candidate, setBpm));
      candidates.appendChild(chip);
    }
  }

  // --- the declared controls ---------------------------------------------------------------------

  const columns = document.createElement('div');
  columns.className = 'reference__columns';
  const controls = [];
  for (const [group, title, help] of GROUPS) {
    const column = document.createElement('div');
    column.className = 'reference__column';
    const heading = document.createElement('h4');
    heading.textContent = title;
    heading.title = help;
    column.appendChild(heading);
    const rows = document.createElement('div');
    rows.className = 'synth-rows';
    for (const param of REFERENCE_PARAMS[group]) {
      const control = buildParamRow(param, { onChange: (value) => setReferenceParam(param.key, value) });
      rows.appendChild(control.row);
      controls.push(control);
    }
    column.appendChild(rows);
    columns.appendChild(column);
  }
  element.appendChild(columns);

  const note = document.createElement('p');
  note.className = 'reference__note';
  note.innerHTML =
    'The recording is <strong>not saved with the song</strong> — a decoded four-minute file is tens of ' +
    'megabytes, and a song document is a few kilobytes of notes. Import it again next session. ' +
    'Set the <strong>BPM</strong> to the record’s own tempo first: nothing here stretches audio, so ' +
    'a tempo that is close but not right will drift a bar at a time, which the picture makes very ' +
    'obvious against the bar lines.';
  element.appendChild(note);

  // --- keeping it current -------------------------------------------------------------------------

  function refresh() {
    const state = getReferenceState();
    for (const control of controls) showParamValue(control, state[control.param.key], state);

    const loaded = hasReference();
    clearBtn.hidden = !loaded;
    alignInput.disabled = !loaded;
    if (document.activeElement !== alignInput) alignInput.value = getAnchorSeconds().toFixed(3);

    const buffer = referenceBuffer();
    const analysis = referenceAnalysis();
    if (buffer) {
      const bars = buffer.duration / secondsForBeats(barBeats(), getBpm());
      const channels = buffer.numberOfChannels === 1 ? 'mono' : `${buffer.numberOfChannels}ch`;
      fileMeta.textContent = `${referenceName()} — ${clock(buffer.duration)} · ${Math.round(buffer.sampleRate / 100) / 10}kHz · ${channels} · ${bars.toFixed(1)} bars at ${getBpm()} BPM`;
    } else {
      fileMeta.textContent = 'Nothing imported. A wav or an mp3 — whatever this browser decodes.';
    }

    const detection = getTempoDetection();
    detectBtn.disabled = !loaded || detection.state === 'running';
    detectBtn.textContent = detection.state === 'running' ? `Listening… ${Math.round(detection.progress * 100)}%` : 'Detect tempo';
    detectStatus.textContent = detection.text;
    showCandidates(detection.candidates);

    const current = getReferenceStatus();
    const busy = current.state === 'decoding' || current.state === 'analysing';
    status.classList.toggle('reference__status--busy', busy);
    status.classList.toggle('reference__status--error', current.state === 'error');
    barFill.style.width = `${Math.round(current.progress * 100)}%`;
    if (busy || current.state === 'error') {
      statusText.textContent = current.text;
    } else if (analysis) {
      // What the transform actually gave you, which is not always what was asked for: a long file at
      // a fine overlap runs past what one canvas can hold, and the hop is widened to fit. Saying so
      // is the difference between a readout and a lie.
      const ms = (analysis.dt * 1000).toFixed(1);
      const hz = analysis.binHz.toFixed(1);
      statusText.textContent = `${analysis.frames.toLocaleString()} frames · ${ms} ms · ${hz} Hz a bin${
        analysis.truncated ? ' · hop widened to fit the picture' : ''
      }`;
    } else {
      statusText.textContent = '';
    }
  }

  subscribeReference(refresh);
  refresh();

  return { element, refresh };
}

/**
 * Let a file be dropped anywhere on `target`.
 *
 * On the workspace rather than on the panel, because the panel is a dropdown: reaching a drop zone
 * would mean opening the menu that the drop is meant to replace. Dropping a file on the roll is the
 * gesture people already have.
 */
export function installReferenceDrop(target, { onDropped } = {}) {
  const hasFile = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  target.addEventListener('dragover', (event) => {
    if (!hasFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('is-drop-target');
  });
  // `relatedTarget` rather than `target`: a drag over the roll crosses dozens of child elements and
  // fires a dragleave on each of them, so testing which element was left says nothing. What matters
  // is where the pointer went - if that is still inside, the drag has not left at all.
  target.addEventListener('dragleave', (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('is-drop-target');
  });
  target.addEventListener('drop', (event) => {
    if (!hasFile(event)) return;
    event.preventDefault();
    target.classList.remove('is-drop-target');
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    loadReferenceFile(file);
    onDropped?.();
  });
}
