// The two readouts: what a voice looks like, and whether the audio thread is keeping up.
//
// Both are here because they answer the same question from opposite ends. The spectrum says
// whether the sound is what was asked for; the load says whether there is room to ask for more.
// A synth is finished when both are true at once, and neither is audible on its own until it is
// too late - aliasing sounds like brightness, and a thread at 95% sounds like nothing at all
// right up to the moment it drops out.
//
// Canvas rather than SVG, which the rest of the app prefers: a spectrum is four thousand points
// that change wholesale every time you press Measure, and four thousand DOM nodes to throw away
// is a different kind of program.

import { analyseSweep, analyseVoice } from './analysis.js';
import { getInstrument } from './instruments.js';
import { createLoadMeter } from './perf.js';
import { HEAT_FLOOR_DB, createScopeView, formatHz } from './views/scope-view.js';


// What the fallback bar calls "full", for want of a real budget. Sixty-four oscillators is a
// plausible ceiling for a node-graph engine of this shape rather than a measured limit, and the
// tooltip says as much - a bar with an invented maximum is only honest if it admits it.
const OSC_REFERENCE = 64;

// How long after the last change to measure again. Long enough that a slider drag is one
// measurement rather than forty, short enough to feel like the display is following your hand.
const AUTO_MEASURE_MS = 140;

// The notes worth measuring, high first. Aliasing is a function of how much of the harmonic
// series is being asked to live above Nyquist, so it is a high-note problem: a sawtooth at C7
// wants partials past 22kHz and something has to happen to them. The same oscillator at C3
// can be badly broken and look perfect.
const TEST_NOTES = [
  { midi: 96, label: 'C7 — 2093 Hz' },
  { midi: 84, label: 'C6 — 1047 Hz' },
  { midi: 72, label: 'C5 — 523 Hz' },
  { midi: 60, label: 'C4 — 262 Hz' },
];

/**
 * The spectrum panel. `getVoice` is asked at measure time rather than handed a voice up front,
 * so the button always measures whatever part is active now.
 */
export function createAnalysisPanel({ getVoice, getLabel, getChainNote }) {
  const element = document.createElement('div');
  element.className = 'analysis';

  const heading = document.createElement('h3');
  element.appendChild(heading);

  /**
   * What is being measured, and - if it is no longer everything - what is missing.
   *
   * This measures the *voice*, which used to be the same thing as measuring the part. It stopped being
   * the same thing the moment a part could have effects: a low pass on the chain would remove
   * harmonics the oscillator really did make, and the headline number would improve for a reason that
   * has nothing to do with the oscillator. So the scope keeps measuring the voice - that is the
   * question it exists to answer - and says so when there is a chain it is not looking through.
   */
  function headingFor(which) {
    const note = getChainNote?.();
    return `${VIEW_TITLES[which]} of ${getLabel() ?? 'this voice'}${note ? ` — ${note}` : ''}`;
  }

  const controls = document.createElement('div');
  controls.className = 'analysis__controls';

  const noteSelect = document.createElement('select');
  // Which notes are worth rendering is the instrument's business now. For a synth it is the high
  // ones, because aliasing is a high-note problem. For a kit it is the drums, because a kit does
  // not answer to C7 at all - pointing the old picker at one rendered silence and reported it as a
  // flawlessly clean instrument, which is the exact failure mode this panel exists to prevent.
  let builtNotes = null;
  function syncNotes(definition) {
    const notes = definition?.measurement?.notes ?? TEST_NOTES;
    const signature = notes.map((n) => n.midi).join(',');
    if (signature === builtNotes) return;
    const previous = noteSelect.value;
    noteSelect.replaceChildren();
    for (const note of notes) {
      const option = document.createElement('option');
      option.value = String(note.midi);
      option.textContent = note.label;
      noteSelect.appendChild(option);
    }
    // Keep the note you were looking at if the new instrument also has it, so switching between two
    // synths does not silently move the measurement.
    noteSelect.value = notes.some((n) => String(n.midi) === previous) ? previous : String(notes[0].midi);
    builtNotes = signature;
  }
  syncNotes(null);
  noteSelect.title = 'Which note to render. High notes are where aliasing shows.';

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'btn btn--primary';
  run.textContent = 'Measure';

  // It re-measures on its own now that it sits beside the knobs, and a display that updates without
  // being asked has to say so - otherwise the honest reading of a Measure button is "nothing here is
  // current until you press this".
  const live = document.createElement('span');
  live.className = 'analysis__live';
  live.textContent = 'live';
  live.title = 'Re-measured a moment after you stop moving a control. Press Measure to replay the sweep.';

  controls.append(noteSelect, live, run);
  element.appendChild(controls);

  // Two views of one note, because neither can be the other. Spectrum flattens time away to see
  // faint detail; Sweep gives time an axis and gives up that detail to see movement.
  const views = document.createElement('div');
  views.className = 'analysis__views';
  const viewButtons = new Map();
  for (const [mode, label, title] of [
    ['spectrum', 'Spectrum', 'Where the energy sits, with everything held still'],
    ['sweep', 'Sweep', 'An ordinary spectrum, played through the note — power is height, as usual'],
    ['map', 'Map', 'The whole note at once: time across, pitch up, brightness for level'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--toggle';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => setView(mode));
    viewButtons.set(mode, button);
    views.appendChild(button);
  }
  element.appendChild(views);

  const scope = createScopeView();
  element.appendChild(scope.canvas);

  // Colour is the value in the sweep view, so it needs an axis like any other. Shown only for
  // that view, since the spectrum view spends no colour on magnitude at all.
  const scale = document.createElement('div');
  scale.className = 'analysis__scale';
  const scaleLow = document.createElement('span');
  scaleLow.textContent = `${HEAT_FLOOR_DB} dB`;
  const scaleRamp = document.createElement('i');
  const scaleHigh = document.createElement('span');
  scaleHigh.textContent = '0';
  scale.append(scaleLow, scaleRamp, scaleHigh);
  element.appendChild(scale);

  const stats = document.createElement('div');
  stats.className = 'analysis__stats';
  element.appendChild(stats);

  const note = document.createElement('p');
  note.className = 'dropdown-panel__note';
  const NOTES = {
    sweep:
      'An ordinary spectrum — frequency across, power up — played through the note at the speed ' +
      'it really happens, with nothing held still. The dim trace behind is the loudest each ' +
      'frequency ever got, so the shape of the whole gesture stays on screen while the live one ' +
      'moves. The dashed violet line is where the instrument says it has put the cutoff, which ' +
      'on these axes slides right as the filter opens. Press Measure again to replay.',
    map:
      'Time across, pitch up, brighter for louder. Nothing is held still here — this is the patch ' +
      'as it actually plays, which is why the sweep is visible at all. The dashed violet line is ' +
      'where the instrument says it sent the cutoff; it is the intention drawn over the result, ' +
      'and the only question worth asking of it is whether the two agree. Short frames buy that ' +
      'movement by giving up fine detail, so quiet things the Spectrum view can see are not here.',
    spectrum:
      'The note is held flat for the measurement — its envelope and its filter sweep are parked, ' +
    'because anything moving smears every partial and would hide what this is looking for, so ' +
    'this is the voice with the sweep off rather than the sweep itself. Ticks ' +
    'along the top are the partials the patch asked for, and anything tall between two ticks is ' +
    'not supposed to be there. Where they crowd too close to separate, the ticks give way to a ' +
    'bar — inside it everything is expected and the plot can no longer show you which is which. ' +
    'The reading above covers the whole range regardless. Below about −90 dB you are looking at ' +
    'the measurement rather than the synth.',
  };
  note.textContent = NOTES.spectrum;
  element.appendChild(note);

  let result = null;
  let sweep = null;
  let view = 'spectrum';
  // Frame-accurate playback of the measured note, driven off the wall clock rather than a frame
  // counter, so it runs at the speed the note actually was regardless of the display's rate.
  let playingFrom = 0;
  let animation = null;

  /**
   * The frequency axis and the dB grid, which both 2D views draw on.
   *
   * Returned as the two mappings the caller needs, because everything downstream is a position
   * question - where does 1kHz sit, where does -40dB sit - and having two copies of that answer
   * is how a plot and its own axis labels end up disagreeing.
   */
  function draw() {
    if (view === 'map') scope.drawSweep();
    else if (view === 'sweep') scope.drawSweepFrame(currentFrame());
    else scope.drawSpectrum();
  }

  function currentFrame() {
    if (!sweep) return 0;
    const elapsed = (performance.now() - playingFrom) / 1000;
    return Math.floor((elapsed % sweep.duration) / sweep.frameSeconds);
  }

  function stopAnimation() {
    if (animation === null) return;
    cancelAnimationFrame(animation);
    animation = null;
  }

  function runAnimation() {
    stopAnimation();
    if (view !== 'sweep' || !sweep) return;
    playingFrom = performance.now();
    scope.resetSmoothing();
    const step = () => {
      // The panel is a dropdown, and a dropdown that is shut should not be animating a canvas
      // nobody can see. offsetParent is null for anything with a hidden ancestor.
      if (view !== 'sweep' || !element.offsetParent) {
        animation = null;
        return;
      }
      scope.drawSweepFrame(currentFrame());
      animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  }

  const VIEW_TITLES = { spectrum: 'Spectrum', sweep: 'Sweep', map: 'Map' };

  function setView(next) {
    view = next;
    for (const [mode, button] of viewButtons) button.classList.toggle('is-on', mode === next);
    note.textContent = NOTES[next];
    // Colour only means a number in the map, so the scale only belongs there.
    scale.hidden = next !== 'map';
    heading.textContent = headingFor(next);
    stopAnimation();
    draw();
    showStats();
    runAnimation();
    // Each view is fed by its own render - the spectrum holds the patch still and the other two do
    // not - so arriving at one is a request to measure it. Without this, switching to Sweep landed on
    // "Press Measure" even though the panel had just measured, because what it had measured was the
    // other view; and switching *back* would have shown a spectrum from before the last few knobs.
    scheduleMeasure();
  }

  function showStats() {
    stats.replaceChildren();
    if (view === 'sweep' || view === 'map') {
      if (!sweep) return;
      const points = sweep.trajectory?.points ?? [];
      const travelled = points.length
        ? `${Math.min(...points.map((p) => p[1])).toFixed(0)}–${Math.max(...points.map((p) => p[1])).toFixed(0)} Hz`
        : 'this instrument declares none';
      appendStats([
        [`Asked-for ${sweep.trajectory?.label ?? 'trajectory'}`, travelled],
        ['Time resolution', `${(sweep.frameSeconds * 1000).toFixed(1)} ms/frame, ${sweep.binHz.toFixed(0)} Hz/bin`],
      ]);
      return;
    }
    if (!result) return;
    const alias = result.alias;
    // An instrument can say the headline does not apply to it. A kit is mostly noise on purpose, so
    // "how much of this is not a multiple of the note" has nothing to measure against and reports a
    // catastrophic-looking number for a drum that is working perfectly. Saying so is better than
    // printing a figure that is precise and meaningless.
    const tonal = getInstrument(getVoice()?.type)?.measurement?.tonal !== false;
    const rows = [
      tonal
        ? [
          'Worst unasked-for partial',
          Number.isFinite(alias.db) ? `${alias.db.toFixed(1)} dBc @ ${formatHz(alias.freq)}Hz` : 'none found',
        ]
        : ['Worst unasked-for partial', 'not meaningful here'],
      [
        'Voice peak, pre-master',
        `${(20 * Math.log10(Math.max(result.peak, 1e-12))).toFixed(1)} dBFS${result.aboveUnity ? ' — over unity' : ''}`,
      ],
      [
        'Cost, rendered offline',
        result.cost ? `${result.cost.realtime.toFixed(0)}× realtime for one voice` : 'not measured',
      ],
      ['Resolution', `${result.binHz.toFixed(1)} Hz/bin at ${(result.sampleRate / 1000).toFixed(1)}kHz`],
    ];
    appendStats(rows);
    if (result.aboveUnity) stats.children[1]?.classList.add('is-warn');
  }

  function appendStats(rows) {
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'analysis__stat';
      const name = document.createElement('span');
      name.textContent = label;
      const readout = document.createElement('strong');
      readout.textContent = value;
      row.append(name, readout);
      stats.appendChild(row);
    }
  }

  // Renders overlap: a drag can start a second measurement while the first is still going, and an
  // OfflineAudioContext gives no promise about which finishes first. Each one carries a ticket and
  // only the newest is allowed to draw, so a slow render of an old patch cannot land on top of a
  // fast render of the current one and leave the display a version behind.
  let ticket = 0;
  let measuring = false;
  let scheduled = null;

  async function measure({ quiet = false } = {}) {
    const voice = getVoice();
    if (!voice) return;
    const mine = ++ticket;
    measuring = true;
    // A quiet measurement leaves the button alone. During a drag it would otherwise flicker between
    // "Measure" and "Measuring…" several times a second, which reads as a fault.
    if (!quiet) {
      run.disabled = true;
      run.textContent = 'Measuring…';
    }
    element.classList.add('is-measuring');
    try {
      const midi = Number(noteSelect.value);
      const measured = view === 'sweep' || view === 'map'
        ? { sweep: await analyseSweep({ voice, midi }) }
        : { result: await analyseVoice({ voice, midi }) };
      if (mine !== ticket) return;
      if (measured.sweep) sweep = measured.sweep;
      else result = measured.result;
      scope.setData(measured.sweep ? { sweep } : { result });
      draw();
      showStats();
      runAnimation();
    } finally {
      if (mine === ticket) {
        measuring = false;
        element.classList.remove('is-measuring');
      }
      if (!quiet) {
        run.disabled = false;
        run.textContent = 'Measure';
      }
    }
  }

  /**
   * Measure again shortly, because something about the voice changed.
   *
   * Debounced rather than immediate: a slider fires an input event per pixel of travel, and a render
   * costs a few milliseconds, so measuring on each one would be both wasteful and useless - you would
   * be watching a queue rather than the patch. Waiting for the gesture to stop means one measurement
   * per thing you actually did.
   *
   * Skipped entirely while the panel is shut. `offsetParent` is null for anything with a hidden
   * ancestor, and rendering audio nobody can look at is pure cost.
   */
  function scheduleMeasure() {
    if (scheduled !== null) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!element.offsetParent) return;
      if (measuring) {
        // Still busy with the last one; come back rather than pile up.
        scheduleMeasure();
        return;
      }
      measure({ quiet: true });
    }, AUTO_MEASURE_MS);
  }

  run.addEventListener('click', () => measure());
  noteSelect.addEventListener('change', () => measure());

  function refresh() {
    syncNotes(getInstrument(getVoice()?.type));
    heading.textContent = headingFor(view);
    draw();
    // Opening the panel is what makes the animation worth running again, and offsetParent only
    // becomes non-null once it is actually on screen - so this is where a paused loop restarts.
    runAnimation();
    // And measure, because the panel opening beside the controls is the whole point: arriving at
    // "Press Measure" when the answer takes five milliseconds is a step that did not need to exist.
    // Through the scheduler rather than directly, so that refreshing while shut costs nothing and
    // an open-plus-change in the same moment is one render instead of two.
    scheduleMeasure();
  }

  setView('spectrum');
  refresh();

  return { element, refresh, measure, scheduleMeasure };
}

/**
 * The always-on header readout.
 *
 * Deliberately terse. It is on screen the whole time, so it has to survive being ignored, and the
 * only thing worth a glance is the percentage. Everything else is in the tooltip.
 */
export function createLoadReadout() {
  const element = document.createElement('div');
  element.className = 'load-meter';

  const bar = document.createElement('div');
  bar.className = 'load-meter__bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  const text = document.createElement('span');
  text.className = 'load-meter__text';
  text.textContent = '—';

  element.append(bar, text);

  createLoadMeter({
    onUpdate: (state) => {
      const { voices } = state;
      if (state.idle) {
        fill.style.width = '0%';
        element.classList.remove('is-warn', 'is-hot');
        text.textContent = 'idle';
        element.title = 'No audio context yet — it is created on the first note you play.';
        return;
      }

      const parts = [
        `${voices.sounding} voice${voices.sounding === 1 ? '' : 's'} sounding, ${voices.oscillators} oscillators`,
        `${voices.pending} scheduled ahead`,
        `${(state.sampleRate / 1000).toFixed(1)}kHz — a ${state.quantumMs.toFixed(2)}ms deadline every ${state.quantumMs.toFixed(2)}ms`,
      ];

      // Preferred over everything else when it exists, because it is the only one of the three
      // that is a measurement of the thing the question is about. It appears the moment a worklet
      // instrument starts playing and vanishes again when none is.
      if (state.dsp) {
        // The bar follows oscillators rather than voices, because oscillators are the work. They
        // are the same number for every instrument that does not have unison, and seven times
        // apart for one that does.
        const share = state.dsp.oscillators / OSC_REFERENCE;
        fill.style.width = `${Math.min(100, share * 100)}%`;
        const plural = state.dsp.voices === 1 ? '' : 's';
        text.textContent = state.dsp.oscillators === state.dsp.voices
          ? `${state.dsp.voices} voice${plural}`
          : `${state.dsp.voices} voice${plural} · ${state.dsp.oscillators} osc`;
        element.classList.toggle('is-warn', share >= 0.75);
        element.classList.remove('is-hot');
        element.title = [
          `${state.dsp.voices} voice${plural} sounding in ${state.dsp.reporting} worklet instrument${state.dsp.reporting === 1 ? '' : 's'} — counted, not inferred`,
          `${state.dsp.oscillators} oscillator${state.dsp.oscillators === 1 ? '' : 's'} between them — unison makes these differ`,
          `plus ${voices.oscillators} oscillators in node-graph parts`,
          `${(state.sampleRate / 1000).toFixed(1)}kHz — ${state.quantumMs.toFixed(2)}ms of work due every ${state.quantumMs.toFixed(2)}ms`,
          '',
          'Not a CPU figure. There is no clock on the audio thread: renderCapacity is absent from',
          'this browser and AudioWorkletGlobalScope has no performance.now(), so nothing can time',
          'it. For whether a patch is affordable, the Scope measures render cost against realtime.',
        ].join('\n');
        return;
      }

      if (state.load) {
        const pct = state.load.average * 100;
        fill.style.width = `${Math.min(100, pct)}%`;
        text.textContent = `${pct.toFixed(0)}%`;
        element.classList.toggle('is-warn', pct >= 50 && pct < 80);
        element.classList.toggle('is-hot', pct >= 80 || state.load.underrunRatio > 0);
        parts.unshift(
          `Audio thread: ${pct.toFixed(0)}% average, ${(state.load.peak * 100).toFixed(0)}% peak`,
          state.load.underrunRatio > 0
            ? `${(state.load.underrunRatio * 100).toFixed(1)}% of windows missed their deadline — that is audible`
            : 'no missed deadlines',
        );
      } else {
        // Nothing outside the audio thread can time the audio thread, so rather than invent a
        // figure the readout changes what it is reporting and says so. The bar is scaled against
        // a stated ceiling instead of a real budget, which is the honest version of not knowing.
        const share = voices.oscillators / OSC_REFERENCE;
        fill.style.width = `${Math.min(100, share * 100)}%`;
        text.textContent = `${voices.oscillators} osc`;
        element.classList.toggle('is-warn', share >= 0.75);
        element.classList.remove('is-hot');
        parts.unshift(
          'This browser does not expose audio-thread load, and nothing outside that thread can',
          `time it — so this is ${voices.oscillators} oscillators against a nominal ${OSC_REFERENCE},`,
          'not a measured load. The real figure arrives with the first worklet instrument, which',
          'can time its own process() against the deadline below.',
        );
      }

      element.title = parts.join('\n');
    },
  });

  return { element };
}
