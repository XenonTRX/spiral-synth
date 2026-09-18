// The edits themselves, factored out of the surfaces that trigger them.
//
// Three things drive editing - the roll, the spiral and the keyboard - and several operations
// are reachable from more than one of them. Toggling a note is the clearest case: Enter and a
// click on a spiral slot have to mean exactly the same thing, including which length the new
// note gets and whether it ends up selected, or the two would quietly diverge. So the operation
// lives here and the surfaces only decide when to call it.

import { nudgeLength, quantizeTime } from './grid.js';
import { secondsForBeats } from './music-theory.js';
import { auditionNote } from './engine.js';
import { instrumentSlides } from './instruments.js';
import { DEFAULT_SLIDE, slideSources } from './song.js';
import { getStrumSpread, strumShifts } from './strum.js';

/**
 * Preview a pitch in a part's own voice.
 *
 * The part is an argument rather than looked up, because most callers already have the one they
 * mean and the one that didn't was quietly wrong: a click on a spiral slot used to audition
 * through the default voice while the identical click on the roll used the part's, so the same
 * note sounded like two different instruments depending on which half of the app you clicked.
 *
 * `delaySeconds` is for the one caller whose preview is not a single moment - see `strumSelection`.
 */
export function audition(track, midi, seconds, delaySeconds) {
  auditionNote(track, midi, seconds, delaySeconds);
}

/**
 * Create a note at a moment and a pitch, or remove the one already sounding there.
 *
 * The length of a new note is `newNoteLength` - the shortest thing already sounding at the
 * cursor - so writing at the same density as what is already there needs no control at all.
 */
export function toggleNoteAt(song, { midi, beat, bpm }) {
  const track = song.activeTrack();
  if (!track) return null;
  const existing = song.noteAtPitch(beat, midi, track.id);
  song.pushUndo();
  if (existing) {
    song.removeNotes(track.id, [existing.id]);
    return 'removed';
  }
  // Folded into the part's own material, so writing inside a repeated pass puts the note where
  // the repeat came from - and it then shows up in the pass you were looking at anyway.
  const start = song.sourceBeat(track.id, beat);
  const note = song.addNote(track.id, { midi, start, length: song.newNoteLength() });
  song.setSelection([note.id]);
  audition(track, midi, secondsForBeats(note.length, bpm));
  return 'added';
}

/**
 * Where a chord built right now would be rooted.
 *
 * One selected note means "build this chord on that note", which is the case where you have
 * placed a root by ear and want the rest of it; the note's own start and length carry over so
 * the chord comes out as one block rather than a root plus three notes of some other length.
 * Otherwise the two cursors say it, exactly as Enter does.
 */
export function chordRoot(song) {
  const selected = song.selectedNotes();
  if (selected.length === 1) {
    const track = song.activeTrack();
    return {
      midi: selected[0].midi,
      // In song time, because the other branch is, and because `buildChord` puts this through
      // `sourceBeat` and then onto the cursor - both of which expect a moment in the song. A note's
      // own `start` is measured from the part, so on a part beginning at bar 5 the two branches of
      // this function disagreed by four bars and the chord was built in the wrong place.
      start: track ? song.songBeat(track.id, selected[0].start, song.getCursor()) : selected[0].start,
      length: selected[0].length,
    };
  }
  return { midi: song.getPitchCursor(), start: song.getCursor(), length: song.newNoteLength() };
}

/**
 * Build a chord from a list of semitone offsets. The offsets are the whole definition - because
 * the spiral has a fixed 30 degrees per semitone, the same list draws the same figure at every
 * root, which is the congruence the chord palette exists to demonstrate.
 */
export function buildChord(song, intervals, bpm) {
  const track = song.activeTrack();
  if (!track) return;
  const root = chordRoot(song);
  // Two clocks, and both are needed. `root.start` is a moment in the song, which is what the lookup
  // below takes; `start` is that folded into the part's own material, which is where a note is
  // written. Asking the lookup in material time is the mistake this used to make: on a part
  // beginning at bar 5 it asked whether anything was sounding at bar 1, where the part is not
  // playing at all, so the answer was always no and building a chord on a note you had already
  // placed left a second copy of it underneath.
  const start = song.sourceBeat(track.id, root.start);
  song.pushUndo();
  const ids = [];
  for (const interval of intervals) {
    const midi = root.midi + interval;
    // A root you already placed is part of the chord, not a duplicate of it.
    const existing = song.noteAtPitch(root.start, midi, track.id);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const note = song.addNote(track.id, { midi, start, length: root.length });
    ids.push(note.id);
  }
  song.setSelection(ids);
  song.setCursor(root.start);
  song.setPitchCursor(root.midi);
  for (const interval of intervals) {
    audition(track, root.midi + interval, secondsForBeats(root.length, bpm));
  }
}

export function deleteSelection(song) {
  const track = song.activeTrack();
  const ids = [...song.getSelection()];
  if (!track || !ids.length) return;
  song.pushUndo();
  song.removeNotes(track.id, ids);
}

// The copy lands one full selection-width later, so duplicating a bar of material gives you the
// next bar rather than a pile on top of what you had.
export function duplicateSelection(song) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length) return;
  const from = Math.min(...notes.map((n) => n.start));
  const to = Math.max(...notes.map((n) => n.start + n.length));
  const offset = to - from;
  song.pushUndo();
  // Everything the note is, not just where it is. A copy of a shaped phrase that came back at full
  // velocity with its slides gone would be a copy of the pitches and the rhythm only - which is
  // exactly the part of it you did not need help with.
  const copies = notes.map((n) =>
    song.addNote(track.id, {
      midi: n.midi,
      start: n.start + offset,
      length: n.length,
      velocity: n.velocity,
      slide: n.slide,
    })
  );
  song.setSelection(copies.map((n) => n.id));
  // In song time. `from` and `offset` are both measured in the part's own material, and the cursor
  // is a moment in the *song* - the same number only when the part begins at bar 1. On a part that
  // begins anywhere else this sent the cursor back by the part's own offset, and since the keyboard
  // reveals the cursor after duplicating, the roll's viewport went with it.
  song.setCursor(song.songBeat(track.id, from + offset, song.getCursor()));
}

export function nudgeSelection(song, deltaBeats) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length) return;
  // Clamp the move as one shape rather than per note, so a chord shoved against the start of
  // the song keeps its internal offsets.
  const room = Math.min(...notes.map((n) => n.start));
  const delta = Math.max(deltaBeats, -room);
  if (!delta) return;
  song.pushUndo();
  for (const note of notes) song.updateNote(track.id, note.id, { start: note.start + delta });
  song.setCursor(Math.max(0, song.getCursor() + delta));
}

// Past a dozen notes the tail of a preview is no longer telling you anything about the gesture you
// just made, and a selection can be a whole passage.
const STRUM_PREVIEW_NOTES = 12;

/**
 * Roll the selection in pitch order, so a chord is played across rather than struck at once.
 *
 * `direction` is +1 for a stroke that finishes at the top and -1 for one that finishes at the
 * bottom - a guitarist's down- and up-stroke. How far apart the notes end up is one number owned by
 * strum.js, so the key and the control under the palette are the same gesture; the arithmetic, and
 * the reasons it is relative rather than absolute, are there too.
 *
 * Two notes at least, because a strum of one note is a nudge, and this would be a confusing way to
 * get one. Nothing is refused beyond that: the selection is taken as the chord, whatever is in it.
 *
 * Heard as it was written, which is the only way to judge a strum - the preview is spaced by the
 * offsets the notes just got, so a 40ms spread sounds like a 40ms spread instead of like the block
 * chord this exists to stop it being.
 */
export function strumSelection(song, direction, bpm) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || notes.length < 2) return;
  const shifts = strumShifts(notes, { direction, spread: getStrumSpread() });
  song.pushUndo();
  for (const { id, start } of shifts) song.updateNote(track.id, id, { start });
  const pitchOf = new Map(notes.map((note) => [note.id, note.midi]));
  const earliest = Math.min(...shifts.map((shift) => shift.start));
  for (const { id, start } of shifts.slice(0, STRUM_PREVIEW_NOTES)) {
    audition(track, pitchOf.get(id), undefined, secondsForBeats(start - earliest, bpm));
  }
}

export function transposeSelection(song, semitones) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length) return;
  song.pushUndo();
  for (const note of notes) song.updateNote(track.id, note.id, { midi: note.midi + semitones });
  const anchor = song.selectedNotes()[0];
  if (anchor) {
    song.setPitchCursor(anchor.midi);
    audition(track, anchor.midi);
  }
}

/**
 * Raise or lower how hard the selected notes are struck.
 *
 * A tenth at a time, which is coarse enough that a keypress is audible and fine enough that a hat
 * pattern can be shaped in a few of them. Relative rather than absolute, so a selection that is
 * already uneven stays uneven - flattening a phrase to one value is what you get by accident from
 * an absolute set, and it is the opposite of what dynamics are for.
 *
 * The clamp lives in the model, so this does not need to know that velocity stops at 1.
 */
export function nudgeVelocity(song, delta) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length) return;
  song.pushUndo();
  for (const note of notes) song.updateNote(track.id, note.id, { velocity: (note.velocity ?? 1) + delta });
  const anchor = song.selectedNotes()[0];
  if (anchor) audition(track, anchor.midi);
}

/**
 * Put a slide on the selected notes, or take it off them.
 *
 * One key for both directions, and which one it does is decided by the selection: if anything in it
 * is not sliding, they all start; only when every one of them already slides does it turn them off.
 * A toggle that flipped each note independently would turn a half-sliding passage inside out, which
 * is never the edit anyone means by pressing one key over a phrase.
 *
 * A note with nothing before it is skipped rather than refused, because a selection is usually a
 * passage and the first note of a part is a normal thing to have in one - there is simply no pitch
 * for it to arrive from. A part whose instrument does not do pitch at all declines outright.
 */
export function toggleSlide(song) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length || !instrumentSlides(track.instrument?.type)) return;
  const sources = slideSources(track.notes);
  const sliding = notes.filter((note) => sources.has(note.id));
  if (!sliding.length) return;
  const slide = sliding.some((note) => !(note.slide > 0)) ? DEFAULT_SLIDE : 0;
  song.pushUndo();
  for (const note of sliding) song.updateNote(track.id, note.id, { slide });
}

/**
 * Scale the selection in time about its own start: lengths multiply, and so do the gaps between
 * notes, so a phrase comes out at half or double speed with its rhythm intact. This is the one
 * edit that has to move notes and resize them together - doing either alone turns a phrase into
 * a different phrase - which is why it is an operation rather than something you assemble out of
 * a nudge and a resize.
 *
 * It anchors on the earliest selected note rather than on the cursor, so the passage stays where
 * it starts and grows to the right, which is what you want when stretching a bar you have just
 * written into two.
 */
export function stretchSelection(song, factor) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || notes.length === 0 || !(factor > 0)) return;
  const anchor = Math.min(...notes.map((n) => n.start));
  song.pushUndo();
  for (const note of notes) {
    song.updateNote(track.id, note.id, {
      // Scaling is the one edit that lands starts on positions no snap grid would have chosen,
      // so it puts them on the resolution itself. Otherwise a stretched passage would be a set
      // of numbers that agree with nothing, including each other.
      start: quantizeTime(anchor + (note.start - anchor) * factor),
      length: note.length * factor,
    });
  }
}

/**
 * Pull every note in the song onto the current resolution.
 *
 * The resolution governs edits from the moment it is set, which leaves anything placed before it
 * where it was - reasonable as a rule, useless when what you actually want is for a passage you
 * have already made a mess of to line up. This is that button. It is one undo entry, so it is
 * safe to try at a resolution and take back.
 */
export function alignSong(song) {
  song.pushUndo();
  for (const track of song.getTracks()) {
    for (const note of [...track.notes]) {
      song.updateNote(track.id, note.id, {
        start: quantizeTime(note.start),
        length: note.length,
      });
    }
  }
}

/** The span a stretch handle would grab: where the selection starts and where it stops. */
export function selectionSpan(song) {
  const notes = song.selectedNotes();
  if (notes.length === 0) return null;
  return {
    from: Math.min(...notes.map((n) => n.start)),
    to: Math.max(...notes.map((n) => n.start + n.length)),
    lowMidi: Math.min(...notes.map((n) => n.midi)),
    highMidi: Math.max(...notes.map((n) => n.midi)),
    count: notes.length,
  };
}

/**
 * Walk every length the notation can express. With nothing selected this sets the length the
 * *next* note will get, which is how you start a passage at a density the song hasn't got yet -
 * the shortest-at-the-cursor rule only has something to say once something is sounding.
 */
export function resizeSelection(song, direction) {
  const track = song.activeTrack();
  const notes = song.selectedNotes();
  if (!track || !notes.length) {
    song.setLastLength(nudgeLength(song.newNoteLength(), direction));
    return;
  }
  song.pushUndo();
  for (const note of notes) {
    song.updateNote(track.id, note.id, { length: nudgeLength(note.length, direction) });
  }
}

/**
 * Step through the active track's notes in playing order, taking the cursor along. This is the
 * way round the song that needs no aiming at all: Tab, Tab, Tab walks the part, and the spiral
 * re-reads at every stop.
 */
export function selectAdjacentNote(song, direction) {
  const track = song.activeTrack();
  if (!track || !track.notes.length) return;
  const notes = track.notes; // already sorted by start, then pitch
  const current = [...song.getSelection()];
  let index;
  if (current.length) {
    const at = notes.findIndex((n) => n.id === current[current.length - 1]);
    index = at === -1 ? 0 : at + direction;
  } else {
    // Nothing selected: come in from wherever the cursor is, rather than from the ends. The
    // bound is inclusive, so a first Tab picks up whatever starts *on* the cursor rather than
    // stepping over it.
    //
    // Folded into the part's own time first, because that is what a note's `start` is measured in.
    // Comparing the two directly worked only on a part beginning at bar 1; anywhere else the cursor
    // read as a position in the material it was not at, so the first Tab landed on the wrong note.
    const at = song.sourceBeat(track.id, song.getCursor());
    index = direction > 0 ? notes.findIndex((n) => n.start >= at) : -1;
    if (index === -1) {
      index = direction > 0 ? 0 : notes.findLastIndex((n) => n.start < at);
      if (index === -1) index = notes.length - 1;
    }
  }
  const note = notes[Math.max(0, Math.min(notes.length - 1, index))];
  song.setSelection([note.id]);
  // And back out into song time, in the pass the cursor was already in - so Tab walks the part you
  // are looking at rather than jumping to the first pass of it.
  song.setCursor(song.songBeat(track.id, note.start, song.getCursor()));
  song.setPitchCursor(note.midi);
  audition(track, note.midi);
}

export function selectAll(song) {
  const track = song.activeTrack();
  if (!track) return;
  song.setSelection(track.notes.map((n) => n.id));
}
