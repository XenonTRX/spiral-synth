// Where a song lives between sessions.
//
// Two different things get called saving. One is "I closed the tab": no decision, no naming,
// nothing to remember to do - whatever was on screen should simply still be there when you come
// back. That is the autosave, written a moment after every change and read once at startup. The
// other is "keep this one": a named copy that survives the next hour of work, so trying something
// drastic costs nothing. Both go to localStorage, because this prototype is a folder of static
// files and there is nowhere else to put anything.
//
// Reading is deliberately paranoid rather than strict. The song format changes whenever the model
// does and nothing here migrates anything, so any save is potentially from a shape the code no
// longer has. The rule is that a save is a *suggestion*: it is parsed inside a try, every field is
// checked against what today's code expects (see `song.load`), and anything unreadable is dropped
// in favour of a default. The worst a save from three formats ago can do is come back missing
// something. It cannot throw, and it cannot leave half a song on screen.

import { RESOLUTION_CHOICES, getResolutionId, getSnapId, setResolutionId, setSnapId } from './grid.js';
import { METER_CHOICES, getMeterId, setMeterId } from './meter.js';
import { SNAP_CHOICES } from './music-theory.js';
import { getInstrument } from './instruments.js';

const AUTOSAVE_KEY = 'spiral-synth:autosave';
const SAVE_PREFIX = 'spiral-synth:song:';

// Stamped into every document, and now branched on exactly once.
//
// The point of the number was to be visible when a save behaved oddly rather than to drive a
// migration, and for two versions there genuinely wasn't one - every field that moved was read in
// both shapes instead (see `loadInstrument` and `legacyRepeat` in song.js), which is the better
// answer whenever it is available because it needs no version at all.
//
// It is not available for a change of *units*. Calibrating the instruments' output levels means a
// saved `gain: 0.8` describes a different loudness before and after, and nothing in the value says
// which it is - the only thing that can say is the document's version. Hence 2, and hence the
// conversion below.
export const FORMAT = 2;

// The version at which instrument levels became comparable. See `calibrateLevels`.
const CALIBRATED_FORMAT = 2;

export const MAX_NAME = 40;

// localStorage throws on *access*, not just on use, when storage is blocked - a page in a
// private window or with third-party storage disabled. Every path through this module treats
// having no storage at all as an ordinary outcome rather than an error worth reporting.
function store() {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson(key) {
  try {
    const text = store()?.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    store()?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Out of quota, or nowhere to write. Either way the caller wants a false, not an exception
    // thrown out of a change handler halfway through an edit.
    return false;
  }
}

// --- preferences -------------------------------------------------------------------------------

const PREF_PREFIX = 'spiral-synth:pref:';

/**
 * Something that is a preference rather than part of a song.
 *
 * The monitor volume is the first of these and shows what the category is for: it is not in the
 * document, because how loudly you are listening is not a property of the music and a song passed to
 * someone else should not set their volume. But it should still be where you left it when the page
 * comes back, so it needs somewhere to live that is not the song. Preferences live under their own
 * key prefix and go through the same guarded storage as everything else here, so a browser with
 * storage switched off simply gets the defaults.
 */
export function readPref(name) {
  return readJson(PREF_PREFIX + name);
}

export function writePref(name, value) {
  return writeJson(PREF_PREFIX + name, value);
}

// --- the document ------------------------------------------------------------------------------

/**
 * Everything worth keeping, in one plain object.
 *
 * The grid travels with the song rather than being a session preference, and that is not
 * decoration: lengths are quantised to the resolution on the way in, so a song written at a 1/96
 * and loaded at a 1/16 would be silently rounded off. Saving the grid means a round trip gives
 * back exactly what went in. The meter travels for a different reason - it moves no notes at all,
 * but a waltz reopened in 4/4 has its bar lines through the middle of every phrase, and nothing
 * in the notes themselves could tell you which was meant.
 */
export function captureDoc({ song, bpm }) {
  return {
    format: FORMAT,
    savedAt: Date.now(),
    bpm,
    meter: getMeterId(),
    grid: { snap: getSnapId(), resolution: getResolutionId() },
    song: song.toDoc(),
  };
}

/**
 * A song written before the instruments' levels were calibrated, in the levels they have now.
 *
 * Each instrument's output was multiplied by a measured trim so that Level 100% means one note at
 * full scale on all of them (see `OUTPUT_TRIM` in any instrument, and `levelParam` in params.js).
 * That makes every saved `gain` describe a different loudness than it used to, by up to 24dB, so
 * loading one unchanged would re-mix it - the wavetable parts leaping, the subtractive ones sinking.
 * Dividing by the same trim cancels it exactly: the song sounds as it always did, and its faders now
 * read in the same units as everything else.
 *
 * The division always fits inside the knob's range, and that is not luck - it is why the range goes
 * to 150%. The loudest instrument's trim is below 1, so its songs convert *upward*, and a part saved
 * at 100% lands at 147%.
 *
 * `Number(doc.format)` is NaN for a document with no format at all, and `NaN < 2` is false, so the
 * `|| 0` is doing real work: without it the oldest saves - the ones most in need of this - would be
 * the only ones to skip it.
 */
function calibrateLevels(doc) {
  if ((Number(doc.format) || 0) >= CALIBRATED_FORMAT) return doc;
  const tracks = Array.isArray(doc.song?.tracks) ? doc.song.tracks : null;
  if (!tracks) return doc;
  return {
    ...doc,
    song: {
      ...doc.song,
      tracks: tracks.map((track) => {
        const trim = getInstrument(track?.instrument?.type)?.outputTrim;
        const gain = Number(track?.instrument?.state?.gain);
        if (!(trim > 0) || !Number.isFinite(gain)) return track;
        return {
          ...track,
          instrument: { ...track.instrument, state: { ...track.instrument.state, gain: gain / trim } },
        };
      }),
    },
  };
}

/**
 * The inverse, applied in the one order that works: grid first, because the song's lengths are
 * quantised against it as they load, then the song, then tempo. Returns false if there was no
 * song in there worth loading, in which case nothing has changed.
 */
export function applyDoc(doc, { song, setBpm }) {
  if (!doc || typeof doc !== 'object') return false;
  doc = calibrateLevels(doc);

  const grid = doc.grid && typeof doc.grid === 'object' ? doc.grid : {};
  const snapBefore = getSnapId();
  const resolutionBefore = getResolutionId();
  const meterBefore = getMeterId();
  if (SNAP_CHOICES.some((s) => s.id === grid.snap)) setSnapId(grid.snap);
  if (RESOLUTION_CHOICES.some((r) => r.id === grid.resolution)) setResolutionId(grid.resolution);
  if (METER_CHOICES.some((m) => m.id === doc.meter)) setMeterId(doc.meter);

  // Put all three back if the song turns out to be unreadable. The grid has to go on first - the
  // lengths are quantised against it as they load - which would otherwise leave a failed load
  // having changed the one thing it did manage to apply.
  if (!song.load(doc.song)) {
    setSnapId(snapBefore);
    setResolutionId(resolutionBefore);
    setMeterId(meterBefore);
    return false;
  }

  const bpm = Number(doc.bpm);
  if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 300) setBpm(bpm);
  return true;
}

// --- the autosave ---------------------------------------------------------------------------

export function readAutosave() {
  return readJson(AUTOSAVE_KEY);
}

export function writeAutosave(doc) {
  return writeJson(AUTOSAVE_KEY, doc);
}

/**
 * The autosave's timing, kept in one place so nothing else has to think about it.
 *
 * Debounced because the interesting changes arrive in bursts - a drag emits one per pointer move -
 * and a stringify per frame is a real cost for a save nobody is waiting on. Flushed on the way out
 * of the page, because the whole promise of an autosave is that the last thing you did is in it.
 */
export function createAutosaver(capture, delayMs = 700) {
  let timer = null;

  function write() {
    timer = null;
    writeAutosave(capture());
  }

  return {
    mark() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, delayMs);
    },
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      write();
    },
  };
}

// --- named saves ------------------------------------------------------------------------------

/** Trimmed, length-capped, and empty if there is nothing usable left. */
export function cleanName(name) {
  return String(name ?? '').trim().slice(0, MAX_NAME);
}

/**
 * Every named save, newest first, with just enough about each one to tell them apart without
 * loading anything. A save that no longer parses is listed rather than hidden - it is still
 * something you saved, and something you may well want the delete button for.
 */
export function listSaves() {
  const storage = store();
  if (!storage) return [];
  const out = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(SAVE_PREFIX)) continue;
    const doc = readJson(key);
    const tracks = Array.isArray(doc?.song?.tracks) ? doc.song.tracks : [];
    out.push({
      name: key.slice(SAVE_PREFIX.length),
      savedAt: Number(doc?.savedAt) || 0,
      tracks: tracks.length,
      notes: tracks.reduce((sum, t) => sum + (Array.isArray(t?.notes) ? t.notes.length : 0), 0),
      readable: tracks.length > 0,
    });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function readSave(name) {
  return readJson(SAVE_PREFIX + cleanName(name));
}

export function writeSave(name, doc) {
  const key = cleanName(name);
  if (!key) return false;
  return writeJson(SAVE_PREFIX + key, doc);
}

export function deleteSave(name) {
  try {
    store()?.removeItem(SAVE_PREFIX + cleanName(name));
  } catch {
    // Nothing to do about it and nothing to tell the user; the list will show the truth.
  }
}
