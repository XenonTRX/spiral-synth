// The rack: one row per part, sitting above the roll.
//
// All parts share one grid, so the rack is what says which of them you are editing. The active
// track's notes are the solid, clickable ones; everything else is drawn behind them as ghosts,
// visible for reference and inert to the pointer. That is the trade a shared grid makes - you
// see how the parts fit together all the time, and you commit to one of them to edit.
//
// Rows are built once per part and then *patched*, rather than rebuilt from scratch on every
// change. That is not an optimisation, it is a correctness requirement: this rack contains the
// only text field in the app, renaming a part emits a change, and a rebuild would destroy the
// very input the keystroke came from - so the name box lost focus after every single letter.
// Nothing you can do to a live element survives replacing it, which is also why the rebuild threw
// away hover and selection state on every pointermove of a note drag.

import { CHANGE } from './song.js';
import { createFadeLane } from './fade-lane.js';
import { getInstrument } from './instruments.js';
import { barBeats, subscribeMeter } from './meter.js';
import { UNIT_STEPS, unitForValue, valueForUnit } from './param-controls.js';
import { MAX_TRACK_OFFSET_MS } from './track-time.js';

// How much one click of the offset stepper is worth. Five milliseconds, because the whole useful
// range is about 30 either way - a stepper of one would need thirty clicks to cross it, and one of
// ten cannot find the settings in between that are the entire point of the control.
const OFFSET_STEP_MS = 5;

/**
 * The knob that means "how loud is this part", asked of the instrument rather than assumed.
 *
 * Every instrument here happens to call it `gain` and every one of them runs 0 to 1, and neither of
 * those is a promise this file is entitled to make on their behalf - so the descriptor supplies the
 * range, the step and the way of writing the value down, and an instrument with no level at all gets
 * no fader instead of a broken one.
 */
function levelParam(track) {
  const definition = getInstrument(track?.instrument?.type);
  return definition?.params?.find((param) => param.key === 'gain') ?? null;
}

export function createTrackRack({ song, onLevel }) {
  const element = document.createElement('div');
  element.className = 'rack';

  // Keyed by track id, because that is what survives an undo: `restore` swaps in freshly parsed
  // track objects with the same ids, so a row that captured the object itself would be pointing
  // at a track that no longer exists. Every handler below looks its track up by id at click time
  // for the same reason.
  const rows = new Map();

  // What an empty rack says, so that clearing the song reads as a cleared song rather than as a
  // panel that failed to draw. It lives at the end of the list and is moved back there on every
  // render, which keeps it out of the way of the index arithmetic that orders the rows.
  const empty = document.createElement('p');
  empty.className = 'rack__empty';
  empty.textContent = 'No parts. Add one with + Part.';

  function buildRow(id) {
    const row = document.createElement('div');
    row.className = 'rack__track';
    row.dataset.trackId = id;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'rack__pick';
    pick.addEventListener('click', () => song.setActiveTrack(id));

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'rack__name';
    name.addEventListener('input', () => song.setTrackName(id, name.value));
    name.addEventListener('focus', () => song.setActiveTrack(id));

    const voice = document.createElement('span');
    voice.className = 'rack__voice';

    const count = document.createElement('span');
    count.className = 'rack__count';

    // Where the part sits in the song, in bars, and how many passes that comes to.
    //
    // It belongs beside the part rather than in a dialog because it *is* the shape of the
    // arrangement - which parts are playing in which section is the thing you set once and then
    // read constantly. This used to be a single repeat count, which could only say how long a part
    // was and never where it started, so every part began at bar 1 and a song could be a loop but
    // not an arrangement.
    //
    // The pass count is now a readout rather than an input. It is a consequence of the span: eight
    // bars of a two-bar part is x4, and if the span is not a whole number of passes the last one is
    // partial, which is what a fill is.
    const region = document.createElement('div');
    region.className = 'rack__region';

    const stepper = (label, title, read, write) => {
      const wrap = document.createElement('div');
      wrap.className = 'rack__span';
      wrap.title = title;
      const less = document.createElement('button');
      less.type = 'button';
      less.textContent = '−';
      const value = document.createElement('span');
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = '+';
      for (const [button, delta] of [[less, -1], [more, 1]]) {
        button.addEventListener('click', () => {
          const track = song.trackById(id);
          if (!track) return;
          song.pushUndo();
          write(track, delta);
        });
      }
      wrap.append(less, value, more);
      return { wrap, value, less, read };
    };

    // Both steppers move in whole bars. Bars are the unit an arrangement is written in, and a part
    // that entered three sixteenths into bar five would be a mistake rather than a feature.
    const from = stepper('from', 'Which bar this part comes in on', null, (track, delta) => {
      const bar = barBeats() || 1;
      const nextBegin = Math.max(0, song.trackBegin(track) + delta * bar);
      // The span is held, not the end: nudging a part along the song should move it, not stretch it.
      const span = song.trackSpan(track);
      song.setTrackRegion(id, {
        begin: nextBegin,
        end: track.end === null || track.end === undefined ? undefined : nextBegin + span,
      });
    });

    const bars = stepper('bars', 'How many bars this part plays for', null, (track, delta) => {
      const bar = barBeats() || 1;
      const current = song.trackSpan(track);
      const wanted = Math.max(bar, Math.round(current / bar + delta) * bar);
      song.setTrackRegion(id, { begin: undefined, end: song.trackBegin(track) + wanted });
    });

    const passes = document.createElement('span');
    passes.className = 'rack__passes';

    // And a third stepper, in milliseconds rather than in bars, because it is a different kind of
    // quantity: the other two say where the part sits in the arrangement, and this says how far off
    // the grid it actually sounds. It is next to them anyway - all three are "where is this part in
    // time" - and it is the one that can go negative, which is what it is for. A part cannot be
    // written before the first beat; it can be played ahead of it.
    const nudge = stepper('nudge', 'How far ahead of or behind the grid this part sounds, in milliseconds — for feel, not for arrangement. Negative is early. It moves no notes and nothing on screen changes.', null, (track, delta) => {
      song.setTrackOffsetMs(id, song.trackOffsetMs(track) + delta * OFFSET_STEP_MS);
    });
    nudge.wrap.classList.add('rack__nudge');

    region.append(from.wrap, bars.wrap, passes, nudge.wrap);

    // How long the part takes to arrive and to leave - drawn as the part rather than counted, which is
    // fade-lane.js's whole argument. It sits next to the region and not in the synth panel because a
    // fade is a fact about *where the part is in the song* rather than about what it sounds like, the
    // same reason the level fader was lifted out here.
    //
    // This is the *summary* copy: 112px whatever the part's length, so a column of them says which
    // parts arrive and which leave, and a corner drags to the nearest bar. The roll draws the same
    // widget again at the song's own scale, which is where a fade is actually placed - see the lane in
    // piano-roll.js.
    //
    // One undo entry per gesture rather than per write: the steppers this replaced pushed one per
    // click, and a drag pushing one per pointermove would bury the stack under a single movement.
    const fades = createFadeLane({
      onGesture: () => song.pushUndo(),
      onFade: (key, value) => song.setTrackFades(id, { [key]: value }),
    });

    // A part's level, next to the part.
    //
    // It was already editable - it is one of the instrument's own knobs and the synth panel has
    // always drawn it - and that is exactly the problem it solves. Balancing three parts against each
    // other meant opening the panel, picking a part, moving one slider, picking the next part, moving
    // the next slider, all the while listening to a mix you could only change one part of at a time.
    // Meanwhile the arrangement work made balance the *first* thing you need after writing a part,
    // and the limiter's reduction meter made too-loud a thing you can now see happening. So the one
    // knob out of a dozen that belongs to the mix rather than to the sound is lifted out to where the
    // parts are. It is the same value; there is no second copy of it.
    const level = document.createElement('input');
    level.type = 'range';
    level.className = 'rack__level';
    // In slider positions rather than in the value, exactly like every other knob in the app. It used
    // to be wired straight to the amplitude - min 0, max 1.5, step 0.005 - and that was the same
    // mistake the master fader had been fixed for one commit earlier: linear in amplitude, so every
    // setting a part in a four-part mix actually wants crowds into the bottom sixth of the travel.
    // Measured on a real song: three of its four faders sat below 18%, one at 7%.
    level.min = '0';
    level.max = String(UNIT_STEPS);
    level.step = '1';
    level.addEventListener('input', () => {
      const track = song.trackById(id);
      const param = levelParam(track);
      if (!param) return;
      // Written straight into the instrument's state, like the synth panel does, and deliberately
      // without an undo entry - for the same reason. A fader is dragged, so pushing undo on input
      // would fill the stack with a hundred steps of one gesture, and pushing it on release would
      // leave a stack whose entries depend on how you happened to move the mouse.
      track.instrument.state[param.key] = valueForUnit(param, Number(level.value) / UNIT_STEPS);
      showLevel({ level, levelValue }, track);
      onLevel?.(track);
    });

    // The number, beside the fader. It was in the fader's `title` and nowhere else, which is to say
    // it was available if you knew to hover and hold still - so balancing by numbers, or repeating a
    // level you liked on another part, meant hovering over each one in turn. A mix is the one place
    // in this app where the *same* figure on two controls is the whole point of reading it.
    const levelValue = document.createElement('span');
    levelValue.className = 'rack__level-value';

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'rack__mute';
    mute.textContent = 'M';
    mute.title = 'Mute this part';
    mute.addEventListener('click', () => song.toggleMute(id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rack__remove';
    remove.textContent = '×';
    remove.title = 'Remove this part';
    // Undoable, which it was not before. It could get away with that while one part always had to
    // survive; now that the last one can go, a misplaced click can empty the desk, and that is
    // exactly the kind of thing undo is for.
    remove.addEventListener('click', () => {
      song.pushUndo();
      song.removeTrack(id);
    });

    row.append(pick, name, voice, count, region, fades.element, level, levelValue, mute, remove);
    return { row, pick, name, voice, count, region, from, bars, passes, nudge, fades, level, levelValue, mute, remove };
  }

  function showLevel(refs, track) {
    const param = levelParam(track);
    refs.level.hidden = !param;
    refs.levelValue.hidden = !param;
    if (!param) return;
    const value = Number(track.instrument.state[param.key] ?? param.def);
    const unit = String(unitForValue(param, value));
    // Never onto the control being dragged: assigning to a range input mid-gesture snaps the thumb
    // to the assigned value, which fights the pointer. Same rule as the name box two lines up.
    if (document.activeElement !== refs.level && refs.level.value !== unit) {
      refs.level.value = unit;
    }
    const spelled = param.format ? param.format(value) : value.toFixed(2);
    refs.level.title = `${param.label} — ${spelled}`;
    // Written on every pass, including mid-drag: it is a readout rather than a control, so there is
    // no pointer for it to fight, and watching the number while dragging is most of the point of it.
    refs.levelValue.textContent = spelled;
  }

  function updateRow(refs, track, index, active) {
    refs.row.classList.toggle('rack__track--active', active?.id === track.id);

    refs.pick.textContent = String(index + 1);
    refs.pick.title = `Edit this part (${index + 1})`;

    // Only when it actually differs: assigning to a focused input's value moves the caret to the
    // end, which would make renaming anything but the last character impossible.
    if (refs.name.value !== track.name) refs.name.value = track.name;

    // Asked of the instrument rather than read off the track: a waveform is a thing this
    // particular synth happens to have, and the rack should not need to know which instruments do.
    const definition = getInstrument(track.instrument.type);
    refs.voice.textContent = definition?.badge?.(track.instrument.state) ?? definition?.name?.slice(0, 3) ?? '?';
    refs.voice.title = `${definition?.name ?? 'Unknown instrument'} — open Synth ⚙ to change it.`;

    refs.count.textContent = `${track.notes.length}`;
    refs.count.title = `${track.notes.length} notes`;

    const bar = barBeats() || 1;
    const beginBar = Math.round(song.trackBegin(track) / bar) + 1;
    const spanBars = song.trackSpan(track) / bar;
    const passCount = song.trackPasses(track);
    const period = song.trackPeriod(track);

    refs.from.value.textContent = String(beginBar);
    refs.from.less.disabled = song.trackBegin(track) <= 0;
    // A fraction of a bar is worth showing rather than rounding away - it is how you can tell a
    // part is set to stop mid-phrase, which is a thing you may well have meant.
    refs.bars.value.textContent = Number.isInteger(spanBars) ? String(spanBars) : spanBars.toFixed(2);
    refs.bars.less.disabled = spanBars <= 1;
    // In milliseconds, signed, because the sign is the information - "20" and "−20" are opposite
    // instructions and a bare number would read as neither.
    const offset = song.trackOffsetMs(track);
    refs.nudge.value.textContent = offset === 0 ? '0' : `${offset > 0 ? '+' : '−'}${Math.abs(offset)}`;
    refs.nudge.wrap.classList.toggle('is-set', offset !== 0);
    refs.nudge.less.disabled = offset <= -MAX_TRACK_OFFSET_MS;

    refs.passes.textContent = passCount > 1 ? `×${passCount}` : '';
    refs.passes.title = passCount > 1
      ? `${passCount} passes of ${period} bar${period === 1 ? '' : 's'} of material`
      : '';
    refs.region.title = `Bars ${beginBar} to ${beginBar + Math.ceil(spanBars) - 1}`
      + (track.end === null || track.end === undefined ? ' — as long as its notes' : '');

    // The two lengths the audio is using rather than the two stored on the track - `trackFade` clamps
    // each to the span, and it is what the scheduler reads. Anything left over between them is the
    // lane's business: it draws the pair as they actually play.
    refs.fades.show({
      span: song.trackSpan(track),
      fadeIn: song.trackFade(track, 'fadeIn'),
      fadeOut: song.trackFade(track, 'fadeOut'),
    });

    // The region's own highlight stays about *position*. The fades light themselves, for the same
    // reason as before: rolling them together made setting a fade appear to move the part.
    refs.region.classList.toggle('is-on', song.trackBegin(track) > 0 || passCount > 1);

    showLevel(refs, track);

    refs.mute.classList.toggle('is-on', track.muted);
  }

  function render() {
    const tracks = song.getTracks();
    const active = song.activeTrack();

    for (const [id, refs] of rows) {
      if (tracks.some((track) => track.id === id)) continue;
      refs.row.remove();
      rows.delete(id);
    }

    tracks.forEach((track, index) => {
      let refs = rows.get(track.id);
      if (!refs) {
        refs = buildRow(track.id);
        rows.set(track.id, refs);
      }
      updateRow(refs, track, index, active);
      // Moving a node re-inserts it, and re-inserting the node the caret is in blurs it - so the
      // order is only ever touched when it is genuinely wrong, which for a rename is never.
      if (element.children[index] !== refs.row) {
        element.insertBefore(refs.row, element.children[index] ?? null);
      }
    });

    empty.hidden = tracks.length > 0;
    element.appendChild(empty);
  }

  song.subscribe((kind) => {
    // Note counts live in the rack, so a note added anywhere redraws it too.
    if (kind === CHANGE.TRACKS || kind === CHANGE.NOTES) render();
  });
  // Bars are the unit the region is shown in, so a meter change re-labels every part.
  subscribeMeter(() => render());
  render();

  return { element, refresh: render };
}
