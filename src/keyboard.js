// The keyboard, which is the point of the whole layout.
//
// Aiming at a 13-pixel row with a mouse was never the good part, and on the old spiral it was
// most of the work. So the arrows are split the way the screen is: **horizontal is time,
// vertical is pitch**, and the two cursors that follow from that - a moment and a pitch - are
// the only state a keyboard edit needs. Enter toggles whatever they intersect.
//
// Modifiers stay on one rule rather than being learned per key: plain arrows move *you*, Alt
// arrows move the *notes you have selected*. Shift makes either one bigger - a bar instead of a
// grid step, an octave instead of a semitone.

import { barBeats, nextBarLine } from './meter.js';
import { NOTES_PER_OCTAVE } from './spiral-geometry.js';
import { getSetting, setSetting } from './settings.js';
import { getSnapBeats } from './grid.js';
import { zoomBy } from './time-scale.js';
import { referenceEndBeat } from './reference.js';
import {
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  resizeSelection,
  selectAdjacentNote,
  selectAll,
  stretchSelection,
  toggleNoteAt,
  toggleSlide,
  transposeSelection,
  nudgeVelocity,
} from './edits.js';

function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    return ['text', 'search', 'email', 'number', 'password', 'url'].includes(el.type);
  }
  return false;
}

// What a range input does with a key, rather than what the song does with it.
const SLIDER_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Whether this key belongs to whatever has been focused rather than to the song.
 *
 * A text field keeps everything, which is what `isTextEntry` above is for. A slider and a button
 * keep almost nothing - neither is a field - but they each keep the few keys that *are* them, and
 * until now they kept none: this handler runs on `window` and calls `preventDefault`, so a
 * tabbed-to slider sat still while the arrows moved the song cursor behind it, and a tabbed-to
 * button could not be pressed at all, because Enter had already been spent making a note somewhere
 * else. Both were invisible for as long as every control was only ever reached with a mouse.
 *
 * Deliberately narrow. Space stays the transport wherever you are - which is exactly why Enter is
 * the button's key here and Space is not: the play button would otherwise answer the space bar with
 * "play" while the transport answered the same press with "stop".
 */
function focusedControlWants(el, key) {
  if (!el) return false;
  if (el.tagName === 'INPUT' && el.type === 'range') return SLIDER_KEYS.has(key);
  if (el.tagName === 'BUTTON') return key === 'Enter';
  return false;
}

export function installKeyboard({ song, transport, roll, getBpm, onToggleLoop, onSave, onTap }) {
  // How far a Shift-less step goes. Snap Off falls back to a 1/16, which is fine enough to place
  // anything and coarse enough that crossing a bar does not take sixty-four presses.
  function cursorStep() {
    return getSnapBeats() || 1 / 16;
  }

  // Shift moves the cursor *to* the next bar line rather than by one bar's worth. With a mixed
  // meter those are different journeys, and landing on the line is the one anybody wants - it
  // also means a cursor left off the grid gets pulled back onto it by the first press.
  function moveCursor(direction, event) {
    const next = event.shiftKey
      ? nextBarLine(song.getCursor(), direction)
      : song.getCursor() + direction * cursorStep();
    song.setCursor(Math.max(0, next));
    roll.revealBeat(song.getCursor());
  }

  function movePitch(delta) {
    song.setPitchCursor(song.getPitchCursor() + delta);
    roll.revealMidi(song.getPitchCursor());
  }

  function handle(event) {
    const mod = event.metaKey || event.ctrlKey;

    if (mod) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) song.redo();
        else song.undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        song.redo();
        return;
      }
      if (key === 'a') {
        event.preventDefault();
        selectAll(song);
        return;
      }
      if (key === 's') {
        // Taken rather than left alone, because the browser's "save this page" is never what
        // anyone means by it here, and reflex will keep sending it either way.
        event.preventDefault();
        onSave?.();
        return;
      }
      return; // leave every other browser shortcut alone
    }

    switch (event.key) {
      case ' ':
        event.preventDefault();
        transport.toggle();
        return;

      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        // Moving notes stays a *distance* even under Shift: a passage shifted to the next bar
        // line would land on it in a heap, where shifting it by a bar keeps its shape.
        if (event.altKey) nudgeSelection(song, direction * (event.shiftKey ? barBeats() : cursorStep()));
        else moveCursor(direction, event);
        return;
      }

      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        const step = event.shiftKey ? NOTES_PER_OCTAVE : 1;
        if (event.altKey) transposeSelection(song, direction * step);
        else movePitch(direction * step);
        return;
      }

      case 'Home':
        event.preventDefault();
        song.setCursor(0);
        roll.revealBeat(0);
        return;

      // The far end of what the roll is showing, which is the end of an imported recording when
      // there is one longer than the notes - the same reading the transport and the roll's width
      // take. Landing on bar 8 of a two-hundred-bar record would be the notes' end, not the end.
      case 'End': {
        event.preventDefault();
        const end = Math.max(song.songEndBeat(), referenceEndBeat());
        song.setCursor(end);
        roll.revealBeat(end);
        return;
      }

      case 'Enter':
        event.preventDefault();
        toggleNoteAt(song, {
          midi: song.getPitchCursor(),
          beat: song.getCursor(),
          bpm: getBpm(),
        });
        return;

      case 'Tab':
        event.preventDefault();
        selectAdjacentNote(song, event.shiftKey ? -1 : 1);
        roll.revealBeat(song.getCursor());
        roll.revealMidi(song.getPitchCursor());
        return;

      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        deleteSelection(song);
        return;

      case 'Escape':
        song.clearSelection();
        return;

      default:
        break;
    }

    switch (event.key) {
      case ',':
      case '.':
        // Velocity, on the selection. Next to the bracket pair that resizes, because they are the
        // same kind of gesture - take what is selected and make it more or less of what it is.
        if (!song.selectedNotes().length) break;
        event.preventDefault();
        nudgeVelocity(song, event.key === '.' ? 0.1 : -0.1);
        break;

      case '[':
      case ']':
        event.preventDefault();
        // Alt is "act on the selection as a whole" here exactly as it is on the arrows: plain
        // brackets change how long each note is, Alt brackets change how long the passage is.
        if (event.altKey) stretchSelection(song, event.key === ']' ? 2 : 0.5);
        else resizeSelection(song, event.key === ']' ? 1 : -1);
        return;

      case '=':
      case '+':
        event.preventDefault();
        zoomBy(1);
        return;

      case '-':
      case '_':
        event.preventDefault();
        zoomBy(-1);
        return;

      default:
        break;
    }

    const key = event.key.toLowerCase();

    // Tracks by number, in rack order. Nine is more lanes than this prototype will ever want.
    if (key >= '1' && key <= '9') {
      const track = song.getTracks()[Number(key) - 1];
      if (track) song.setActiveTrack(track.id);
      return;
    }

    if (key === 'd') {
      event.preventDefault();
      duplicateSelection(song);
      roll.revealBeat(song.getCursor());
      return;
    }
    // Slide, on the selection. The one note-shaping edit that has no natural pair of keys, because
    // it is a thing a note either does or does not do - how long it takes is then a drag on the ramp
    // the roll draws, which is where a duration belongs anyway.
    if (key === 's') {
      event.preventDefault();
      toggleSlide(song);
      return;
    }
    if (key === 'm') {
      const track = song.activeTrack();
      if (track) song.toggleMute(track.id);
      return;
    }
    if (key === 'l') {
      onToggleLoop?.();
      return;
    }
    if (key === 'f') {
      setSetting('followPlayhead', getSetting('followPlayhead') === 'on' ? 'off' : 'on');
      return;
    }
    if (key === 't') {
      // A held key is not a tap. Autorepeat would deliver thirty of them at the keyboard's own
      // rate and report that rate as the tempo.
      if (!event.repeat) onTap?.();
      return;
    }
  }

  window.addEventListener('keydown', (event) => {
    if (event.repeat && event.key === ' ') return;
    // Escape is the one key a focused field doesn't get to keep - it is how you get out of one.
    if (isTextEntry(document.activeElement)) {
      if (event.key !== 'Escape') return;
      document.activeElement.blur();
      return;
    }
    // And the few keys that belong to whatever has been tabbed to, rather than to the song.
    if (focusedControlWants(document.activeElement, event.key)) return;
    handle(event);
  });
}
