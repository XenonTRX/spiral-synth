// The song, and everything the editing session knows about where you are in it.
//
// This replaces the step model, and the difference is the whole point of the rewrite. A step
// owned one duration and a set of lit slots, so every note in it started and stopped together
// and the timeline was a list of steps laid end to end. A note here owns its own start and its
// own length, nothing is grouped, and notes overlap freely - which is what a piano roll is and
// what a step sequencer structurally cannot do. Time is absolute: a note knows the beat it
// begins on rather than which cell it sits in, so inserting one changes nothing about any
// other, and two tracks line up because they are measured against the same axis rather than
// because they happen to have the same number of cells.
//
// The unit of time throughout is the **whole note** - `start: 0.25` is one quarter in, a
// `length` of 0.125 is an eighth. It is the same unit `durationBeats` returns, so a duration's
// label and its number agree (a quarter really is 0.25), and `secondsForBeats` converts.
//
// Session state - cursor, pitch cursor, selection, which track is active - lives here too
// rather than in a view, because three surfaces read it (the roll, the spiral, the keyboard)
// and any of them can move it. A cursor owned by the roll would be a cursor the spiral had to
// ask permission to move.

import { NOTES_PER_OCTAVE, TOTAL_NOTES } from './spiral-geometry.js';
import {
  DEFAULT_BASE_INDEX,
  DEFAULT_KEY_CONTEXT,
  SCALES,
  durationBeats,
  midiFromOctavePc,
} from './music-theory.js';
import { LANE_STEP_CHOICES, quantizeLength, trackLaneStepId } from './grid.js';
import { MAX_TRACK_OFFSET_MS, clampOffsetMs, trackOffsetMs } from './track-time.js';
import {
  BEAT_EPSILON,
  fadeOf,
  repeatOffsets,
  songBeat,
  sourceBeat,
  trackBegin,
  trackCovers,
  trackEnd,
  trackExtent,
  trackIsPinned,
  trackOwnPeriod,
  trackPasses,
  trackPeriod,
  trackSpan,
} from './track-time.js';
import { defaultInstrumentId, defaultState, getInstrument, resolveInstrument, sanitizeState } from './instruments.js';
// For the side effect: a track cannot be built until the registry knows what an instrument is.
import './instruments/builtins.js';
import { MAX_EFFECTS, defaultEffectState, getEffect, sanitizeEffectSlot } from './effects.js';
// The same, for a saved chain: an effect nobody has imported is one this build has never heard of, and
// a saved slot naming it would be dropped.
import './effects/builtins.js';
import { createListeners } from './observable.js';

// The slot the tonic always occupies: middle turn, 12 o'clock - where C4 sits unkeyed. The
// spiral is laid out in semitones from the tonic rather than in absolute pitch, so this is
// the one fixed point tying the drawing to actual pitches.
export const REF_INDEX = NOTES_PER_OCTAVE;

// The pitch range the roll draws: C1 up to B7, seven octaves. Wider than anyone needs and
// still short enough to scroll through, and it contains every spiral window the octave
// control can reach.
export const MIDI_LOW = 24;
export const MIDI_HIGH = 107;

// BEAT_EPSILON is defined beside the arithmetic that needs it and re-exported here, because
// piano-roll.js has always read it from the song.
export { BEAT_EPSILON };

export const DEFAULT_LENGTH = durationBeats(DEFAULT_BASE_INDEX, 'plain');

export const CHANGE = {
  NOTES: 'notes', // a note was added, removed, moved or retimed
  TRACKS: 'tracks', // a track appeared, vanished, was renamed, muted or made active
  KEYS: 'keys', // a key marker moved or changed
  CURSOR: 'cursor', // the edit cursor or the pitch cursor moved
  SELECTION: 'selection',
};

let idSeq = 0;
const uid = (prefix) => `${prefix}-${(idSeq += 1)}`;

/**
 * How hard a note is struck, 0 to 1.
 *
 * It defaults to full rather than to something with room above it, which is the opposite of the
 * convention every hardware sequencer uses and is the right choice here for one reason: songs
 * written before this existed have no velocity in them, and they have to sound exactly as they did.
 * A default of 0.8 would have quietly turned every saved song down by two decibels. So full is
 * normal and accents are made by taking the other notes *down* - which is how ghost notes work
 * anyway, and leaves the part's own level knob doing the job of "all of this, louder".
 */
export const DEFAULT_VELOCITY = 1;
export const MIN_VELOCITY = 0.05;
const clampVelocity = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_VELOCITY;
  return Math.max(MIN_VELOCITY, Math.min(1, n));
};

/**
 * How long a note takes to arrive at its own pitch, in whole notes. Zero - which is nearly every
 * note - means it simply starts there.
 *
 * A note with a slide begins at the pitch of the note struck before it and travels to its own,
 * which is portamento, and is the thing a 303 does that a piano cannot. It is stored as a
 * *duration* rather than as a flag so it scales with the tempo like everything else here: a slide
 * written at 100bpm is the same gesture at 140, where a fixed sixty milliseconds would be a
 * different one.
 *
 * It is deliberately **not** put on the resolution grid, which every other length here is. A
 * length is a position - notes have to line up with each other and with the bar or a passage is
 * unreadable - and a slide is not: it lines up with nothing, nothing lines up with it, and at a
 * 1/16 resolution the grid could not express a short one at all. So it is a free number, and the
 * roll reads it out in milliseconds, which is what it actually means.
 */
export const DEFAULT_SLIDE = 1 / 32;
// A whole note of glide at 100bpm is nearly two and a half seconds, which is well past musical and
// into effect - and that is the point of a ceiling: it is high enough not to be a judgement about
// what you are allowed to write, and low enough that a fat-fingered drag cannot produce a note that
// spends the next eight bars arriving.
export const MAX_SLIDE = 1;
const clampSlide = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SLIDE, n);
};

/**
 * Which note each note would slide out of, for a whole part at once.
 *
 * The source is the note last *struck* before this one - the previous distinct start in the part -
 * and within that start, the one nearest in pitch. Nearest rather than lowest because the case that
 * decides it is sliding out of a chord: the ear hears the voice closest to where you are going, so
 * a bass note leaving a triad should leave from the bottom of it and a top line from the top.
 *
 * Notes that share a start are not sources for each other. A chord is one attack, and a note
 * sliding out of the note beside it would be a glissando nobody wrote.
 *
 * Every note with a predecessor is in the map, not only the ones that slide, because the roll needs
 * the same answer to know whether a slide can be offered at all. Playback filters it by `slide`.
 *
 * `notes` must be in the order the song keeps them - start, then pitch - which is what makes this
 * one pass rather than a search per note.
 */
export function slideSources(notes) {
  const sources = new Map();
  let previous = []; // the notes on the last start before the one being read
  let current = [];
  for (const note of notes) {
    if (current.length && note.start - current[0].start > BEAT_EPSILON) {
      previous = current;
      current = [];
    }
    current.push(note);
    if (!previous.length) continue;
    let best = previous[0];
    for (const candidate of previous) {
      if (Math.abs(candidate.midi - note.midi) < Math.abs(best.midi - note.midi)) best = candidate;
    }
    sources.set(note.id, best);
  }
  return sources;
}

export function createSong() {
  let tracks = [];
  // The chain on the mix bus. A list like a part's, held here rather than in audio.js because it is
  // part of the song: it is saved, and undo puts it back.
  let masterEffects = [];
  let keyMarkers = [];
  let activeTrackId = null;

  // Where editing is pointing. The cursor is a beat - a moment, not a cell - which is what
  // lets it sit inside a held note rather than only between notes.
  let cursor = 0;
  let pitchCursor = midiFromOctavePc(4, 0); // C4
  let refOctave = 4; // the octave the spiral's middle turn shows
  let selection = new Set();

  // What a new note gets when nothing at the cursor can say. Seeded from the last length you
  // actually used, so a run of eighths keeps being eighths once you have placed one.
  let lastLength = DEFAULT_LENGTH;

  const { subscribe, emit } = createListeners();
  let undoStack = [];
  let redoStack = [];

  // --- tracks ------------------------------------------------------------------------------

  function trackById(id) {
    return tracks.find((t) => t.id === id) ?? null;
  }

  function activeTrack() {
    return trackById(activeTrackId) ?? tracks[0] ?? null;
  }

  function addTrack(name) {
    const type = defaultInstrumentId();
    const presets = getInstrument(type)?.presets ?? [];
    const preset = presets[tracks.length % Math.max(1, presets.length)];
    const track = {
      id: uid('track'),
      name: name ?? `Track ${tracks.length + 1}`,
      muted: false,
      // Where this part sits in the song. `begin` is the beat it enters on; `end` is the beat it
      // stops, and null means "as long as its material is" - which is what a new part gets, and is
      // why writing more notes into one makes it longer without anybody setting anything.
      //
      // Between the two, the material *loops*. That is what makes a part a region rather than a
      // clip: the passes are a projection of the notes below rather than copies of them, so editing
      // the part edits every pass at once, and a part that fills sixteen bars costs a loop rather
      // than sixteen copies of its notes.
      begin: 0,
      end: null,
      // How far ahead of or behind the grid this part actually sounds, in *milliseconds*. See
      // MAX_TRACK_OFFSET_MS for why this one duration is not in whole notes like the rest.
      offsetMs: 0,
      // Which scale this part's step lane is on - a drum machine's per-track scale. `'snap'` follows
      // the toolbar, which is what every part did before the setting belonged to a part.
      laneStep: 'snap',
      // How long one pass is, or null for "as long as the material" - a drum machine's last step.
      // Null is what a new part gets, because a pattern length nobody has set should follow what is
      // written into it; see trackPeriod.
      period: null,
      // How long the part takes to arrive and to leave, in whole notes, measured from the two edges of
      // the region above. Zero is no fade at all, which is what a new part gets - a part that faded in
      // by default would be a part nobody could hear the beginning of.
      fadeIn: 0,
      fadeOut: 0,
      // Which instrument, and what that instrument has been set to. Plain data on purpose: it is
      // what gets saved and what undo swaps back, while the live instrument that reads it is held
      // elsewhere, keyed by this track's id (see engine.js).
      instrument: { type, state: defaultState(type, preset?.state) },
      // Nothing in the chain. A new part is its instrument and nothing else, which is also why the
      // rack shows no effects badge until there is one.
      effects: [],
      notes: [],
    };
    tracks.push(track);
    if (activeTrackId === null) activeTrackId = track.id;
    emit(CHANGE.TRACKS);
    return track;
  }

  // The last part can go too. There used to be a floor of one, on the theory that a song with no
  // parts is not a song - but the thing people actually want at that moment is to clear the desk and
  // start again, and "remove everything except one, then reach for its instrument picker" is a worse
  // way to say that. Every surface that reads the active part already copes with there not being one,
  // because `activeTrack` has always been able to return null.
  function removeTrack(id) {
    const at = tracks.findIndex((t) => t.id === id);
    if (at === -1) return;
    tracks.splice(at, 1);
    if (activeTrackId === id) {
      activeTrackId = tracks[Math.min(at, tracks.length - 1)]?.id ?? null;
      selection = new Set();
    }
    emit(CHANGE.TRACKS);
  }

  function setActiveTrack(id) {
    if (id === activeTrackId || !trackById(id)) return;
    activeTrackId = id;
    // Selection is a set of ids in one track; carrying it across would leave the roll
    // outlining notes you can no longer edit.
    selection = new Set();
    emit(CHANGE.TRACKS);
    emit(CHANGE.SELECTION);
  }

  // --- notes -------------------------------------------------------------------------------

  // Sorted by start so the transport can walk a window of them, and so Tab has an order to
  // step through that matches the one on screen. Ties break on pitch, low first, which is the
  // order a chord reads in.
  function sortNotes(track) {
    track.notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  }

  function addNote(trackId, { midi, start, length, velocity, slide }) {
    const track = trackById(trackId);
    if (!track) return null;
    const note = {
      id: uid('note'),
      midi: clampMidi(midi),
      start: Math.max(0, start),
      length: clampLength(length),
      velocity: velocity === undefined ? DEFAULT_VELOCITY : clampVelocity(velocity),
      slide: clampSlide(slide),
    };
    track.notes.push(note);
    sortNotes(track);
    lastLength = note.length;
    emit(CHANGE.NOTES);
    return note;
  }

  function removeNotes(trackId, ids) {
    const track = trackById(trackId);
    if (!track) return;
    const drop = new Set(ids);
    const before = track.notes.length;
    track.notes = track.notes.filter((n) => !drop.has(n.id));
    if (track.notes.length === before) return;
    for (const id of drop) selection.delete(id);
    emit(CHANGE.NOTES);
    emit(CHANGE.SELECTION);
  }

  function updateNote(trackId, id, patch) {
    const track = trackById(trackId);
    const note = track?.notes.find((n) => n.id === id);
    if (!note) return null;
    if (patch.midi !== undefined) note.midi = clampMidi(patch.midi);
    if (patch.start !== undefined) note.start = Math.max(0, patch.start);
    if (patch.length !== undefined) {
      note.length = clampLength(patch.length);
      lastLength = note.length;
    }
    // Deliberately not remembered as `lastLength` is. A length is a habit - the next note you draw
    // almost certainly wants the length of the last one - and a velocity is not: an accent is a
    // thing you do to one note, and inheriting it would mean every note after a ghost note was
    // also a ghost note.
    if (patch.velocity !== undefined) note.velocity = clampVelocity(patch.velocity);
    // Not remembered either, and for the same reason twice over: a slide is a thing you do to one
    // note, and it is the *pair* that has one - inheriting it would put a glide on the next note
    // you drew, out of whatever happened to be before it.
    if (patch.slide !== undefined) note.slide = clampSlide(patch.slide);
    sortNotes(track);
    emit(CHANGE.NOTES);
    return note;
  }

  function clampMidi(midi) {
    return Math.max(MIDI_LOW, Math.min(MIDI_HIGH, Math.round(midi)));
  }

  // What counts as a legal length is the grid's business, not the song's - see grid.js. All
  // the song insists on is that every note goes through the same door, so a length can never
  // arrive by one route that another route would have refused.
  function clampLength(length) {
    if (!Number.isFinite(length) || length <= 0) return DEFAULT_LENGTH;
    return quantizeLength(length);
  }

  // --- repeats: see track-time.js, re-exposed on the song below ------------------------------

  // --- what is sounding where ---------------------------------------------------------------

  // Half-open on purpose: a note sounds at the beat it starts on and has already stopped at
  // the beat it ends on, so butting two notes up against each other reads as one after the
  // other rather than as an overlap of one beat's width.
  function sounds(note, beat) {
    return note.start <= beat + BEAT_EPSILON && beat < note.start + note.length - BEAT_EPSILON;
  }

  function notesAt(beat, trackId = null) {
    const out = [];
    for (const track of tracks) {
      if (trackId !== null && track.id !== trackId) continue;
      // A part that has not started, or has finished, is not sounding - which is the whole point of
      // a region, and is what makes the spiral go quiet during an intro the part is not in yet.
      if (!trackCovers(track, beat)) continue;
      // Folded, so the spiral tells the truth about what you are hearing in a repeated pass
      // rather than going blank the moment the material runs out.
      const local = sourceBeat(track, beat);
      for (const note of track.notes) if (sounds(note, local)) out.push({ track, note });
    }
    return out;
  }

  function noteAtPitch(beat, midi, trackId) {
    // Latest start wins, which is the note drawn on top and the one a click means.
    let best = null;
    for (const { note } of notesAt(beat, trackId)) {
      if (note.midi !== midi) continue;
      if (!best || note.start > best.start) best = note;
    }
    return best;
  }

  /**
   * How long a note created right now should be: the shortest thing already sounding at the
   * cursor.
   *
   * The reasoning is that whatever is under the cursor is the resolution you are currently
   * working at. If a 1/16 hi-hat is ringing there, you are writing sixteenths; if a whole-note
   * pad is, you are writing slowly. It beats a fixed default because it needs no setting and
   * no reaching for a control, and it beats "same as last time" because it survives moving
   * somewhere else in the song.
   *
   * The active track gets first say. Its own notes are the better predictor of what you are
   * about to write, and without that rule a bass part written over a fast melody would inherit
   * the melody's sixteenths for every note. Only if the active track is silent here does the
   * rest of the arrangement get a vote, and only if the whole song is silent does it fall back
   * to the last length you used.
   */
  function newNoteLength() {
    const track = activeTrack();
    const mine = track ? notesAt(cursor, track.id) : [];
    const pool = mine.length ? mine : notesAt(cursor);
    if (!pool.length) return lastLength;
    return pool.reduce((shortest, { note }) => Math.min(shortest, note.length), Infinity);
  }

  // --- key markers --------------------------------------------------------------------------

  function addKeyMarker(beat, tonicPc = 0, scaleId = 'major') {
    const marker = { id: uid('key'), beat: Math.max(0, beat), tonicPc, scaleId };
    keyMarkers.push(marker);
    keyMarkers.sort((a, b) => a.beat - b.beat);
    emit(CHANGE.KEYS);
    return marker;
  }

  function updateKeyMarker(id, patch) {
    const marker = keyMarkers.find((m) => m.id === id);
    if (!marker) return;
    Object.assign(marker, patch);
    if (patch.beat !== undefined) marker.beat = Math.max(0, patch.beat);
    keyMarkers.sort((a, b) => a.beat - b.beat);
    emit(CHANGE.KEYS);
  }

  function removeKeyMarker(id) {
    keyMarkers = keyMarkers.filter((m) => m.id !== id);
    emit(CHANGE.KEYS);
  }

  // Whichever marker the beat has passed, or the unkeyed default. `explicit` false is what
  // tells the spiral to draw no scale shading at all - shading is a signal that a key is in
  // force, not decoration.
  function keyAt(beat) {
    let context = DEFAULT_KEY_CONTEXT;
    for (const marker of keyMarkers) {
      if (marker.beat > beat + BEAT_EPSILON) break;
      context = { tonicPc: marker.tonicPc, scaleId: marker.scaleId, explicit: true };
    }
    return context;
  }

  // --- the spiral's window ------------------------------------------------------------------

  // The spiral shows 36 semitones, and which 36 depends on the key: the tonic is pinned to
  // REF_INDEX so that a mode always shades the same angles, which means the window slides when
  // the key does. Everything converting between a slot and a pitch goes through here.
  function spiralBaseMidi(beat = cursor) {
    return midiFromOctavePc(refOctave, keyAt(beat).tonicPc) - REF_INDEX;
  }

  function midiForSlot(n, beat = cursor) {
    return spiralBaseMidi(beat) + n;
  }

  function slotForMidi(midi, beat = cursor) {
    return midi - spiralBaseMidi(beat);
  }

  // Keep the pitch cursor reachable. Walking up the spiral with the arrow keys should not
  // stop dead at the rim, so the window follows once the cursor would leave it - by whole
  // octaves, so the drawing shifts by a turn rather than sliding continuously and leaving you
  // unsure which turn you are on.
  function ensureSlotVisible(midi) {
    let guard = 0;
    while (slotForMidi(midi) < 0 && refOctave > 1 && guard++ < 8) refOctave -= 1;
    while (slotForMidi(midi) >= TOTAL_NOTES && refOctave < 7 && guard++ < 8) refOctave += 1;
  }

  // --- cursors and selection ------------------------------------------------------------------

  function setCursor(beat) {
    const next = Math.max(0, beat);
    if (Math.abs(next - cursor) < BEAT_EPSILON) return;
    cursor = next;
    emit(CHANGE.CURSOR);
  }

  function setPitchCursor(midi) {
    const next = clampMidi(midi);
    if (next === pitchCursor) return;
    pitchCursor = next;
    ensureSlotVisible(pitchCursor);
    emit(CHANGE.CURSOR);
  }

  function setRefOctave(octave) {
    const next = Math.max(1, Math.min(7, octave));
    if (next === refOctave) return;
    refOctave = next;
    emit(CHANGE.CURSOR);
  }

  function setSelection(ids) {
    selection = new Set(ids);
    emit(CHANGE.SELECTION);
  }

  function toggleSelected(id) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    emit(CHANGE.SELECTION);
  }

  function selectedNotes() {
    const track = activeTrack();
    if (!track) return [];
    return track.notes.filter((n) => selection.has(n.id));
  }

  // --- extent -------------------------------------------------------------------------------

  function songEndBeat() {
    let end = 0;
    for (const track of tracks) end = Math.max(end, trackEnd(track));
    for (const marker of keyMarkers) end = Math.max(end, marker.beat);
    return end;
  }

  // --- undo ----------------------------------------------------------------------------------

  // Whole-song snapshots rather than a command log. The song is a few hundred small objects,
  // a snapshot is under a millisecond, and it makes undo total: a drag that moved eight notes
  // across two edits is one entry because the gesture pushed one snapshot when it started.
  function snapshot() {
    return JSON.stringify({
      tracks: tracks.map((t) => ({ ...t, notes: t.notes.map((n) => ({ ...n })) })),
      // Not copied field by field: it goes through JSON, so the shallow spread above is deep by the
      // time it lands, which is what lets a part's effects ride along without being named here.
      masterEffects,
      keyMarkers: keyMarkers.map((m) => ({ ...m })),
      activeTrackId,
    });
  }

  function restore(json) {
    const state = JSON.parse(json);
    tracks = state.tracks;
    // Older snapshots in a live undo stack have no master chain in them, and `?? []` is the right
    // reading: an undo taken before the field existed is an undo to a song that had no master effects.
    masterEffects = state.masterEffects ?? [];
    keyMarkers = state.keyMarkers;
    activeTrackId = state.activeTrackId;
    // Ids survive a round trip, so a selection made before the undo still points at real
    // notes - but any note the undo brought back or removed has to be dropped from it.
    const live = new Set(activeTrack()?.notes.map((n) => n.id) ?? []);
    selection = new Set([...selection].filter((id) => live.has(id)));
    emit(CHANGE.TRACKS);
    emit(CHANGE.NOTES);
    emit(CHANGE.KEYS);
    emit(CHANGE.SELECTION);
  }

  // --- saving and loading ---------------------------------------------------------------------

  /**
   * The song as plain data, for storage.js to write somewhere.
   *
   * Ids are left out on purpose. They are counters scoped to one session, so a saved `note-41`
   * names nothing the next time the page loads, and carrying them back in would only invite two
   * notes to claim the same id. The one piece of identity that has to survive the trip - which
   * part you were editing - travels as an index, because an index means the same thing in any
   * session.
   */
  function toDoc() {
    const active = activeTrack();
    return {
      tracks: tracks.map((track) => ({
        name: track.name,
        muted: track.muted,
        begin: trackBegin(track),
        // Resolved rather than copied, so a legacy pass count is written out as the position it
        // always meant and the old field is gone from the next save onward. An unset end stays
        // unset, because "as long as its material" is a real answer and pinning it would stop the
        // part growing when notes were added - but a legacy count is *not* unset, it is a length
        // expressed the old way, and writing null for it would have quietly thrown the arrangement
        // of every previously-saved song away on its first save.
        end: trackIsPinned(track) ? trackEnd(track) : null,
        // The raw setting rather than the resolved period, because unset is a real answer here in a
        // way it is not for `end`: a part whose pattern length follows its material has to go on
        // doing that after a round trip, and writing the derived number would pin it.
        laneStep: trackLaneStepId(track),
        offsetMs: trackOffsetMs(track),
        period: trackOwnPeriod(track),
        fadeIn: fadeOf(track, 'fadeIn'),
        fadeOut: fadeOf(track, 'fadeOut'),
        instrument: { type: track.instrument.type, state: { ...track.instrument.state } },
        // Written even when empty, because an empty array and a missing field mean the same thing
        // here and writing it makes a save legible to a human reading the JSON.
        effects: track.effects.map(copyEffect),
        notes: track.notes.map((n) => ({
          midi: n.midi,
          start: n.start,
          length: n.length,
          velocity: n.velocity,
          slide: n.slide,
        })),
      })),
      // The chain on the mix bus. It belongs to the song rather than to the session, unlike the
      // monitor volume: a reverb on everything is part of what the song sounds like, and a song handed
      // to someone else without it would be a different piece of music.
      master: { effects: masterEffects.map(copyEffect) },
      keyMarkers: keyMarkers.map((m) => ({ beat: m.beat, tonicPc: m.tonicPc, scaleId: m.scaleId })),
      activeIndex: Math.max(0, tracks.findIndex((t) => t.id === active?.id)),
      cursor,
      pitchCursor,
      refOctave,
      lastLength,
    };
  }

  /**
   * One slot, deeply enough copied that nothing shares it.
   *
   * The state has to be its own object: two parts each with a reverb must not be one reverb whose
   * settings move together, which is exactly what a shallow copy of the slot would give them - and it
   * is the same trap `defaultState` guards against for a preset's modulation matrix.
   */
  function copyEffect(slot) {
    return { type: slot.type, state: { ...slot.state }, bypass: slot.bypass === true };
  }

  /** Whichever chain an id names: a part's, or the master's when the id is null. */
  function chainFor(trackId) {
    if (trackId === null || trackId === undefined) return masterEffects;
    return trackById(trackId)?.effects ?? null;
  }

  function readNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Which instrument a saved part wanted, and what it wanted it set to.
   *
   * Two shapes are accepted. The current one names an instrument and carries its state; the older
   * one is a bare bag of synth parameters under `synth`, from before there was more than one
   * instrument to be. Reading the old shape is not a migration path - there still isn't one, and
   * the README still means it. It is the same rule as everywhere else applied to a field that
   * happens to have moved: a save is a suggestion, this one is legible, and refusing to read it
   * would silently strip the voices off every song saved before today for no benefit at all.
   *
   * The state itself is checked by the instrument rather than here, because this file does not
   * know what any particular instrument's fields mean and, once these are plugins, will not have
   * the option of finding out. The try is the backstop for the plugin that has not been written
   * yet and throws on its own save - which lands where every unreadable field lands, on defaults.
   */
  function loadInstrument(raw) {
    const type = resolveInstrument(raw?.instrument?.type ?? (raw?.synth ? defaultInstrumentId() : null));
    const savedState = raw?.instrument?.state ?? raw?.synth;
    try {
      return { type, state: sanitizeState(type, savedState) };
    } catch {
      return { type, state: defaultState(type) };
    }
  }

  /**
   * A saved chain, with anything this build cannot make sense of left out.
   *
   * Dropped rather than defaulted, which is the opposite of how a saved instrument is read, and the
   * difference is what the two are: a part must have an instrument, so an unknown one falls back to
   * something that makes a sound, while a part need not have any effects and there is no sensible
   * substitute for a reverb this build does not have. Inventing one would put a sound in the song
   * nobody asked for. See sanitizeEffectSlot.
   */
  function loadEffects(raw) {
    if (!Array.isArray(raw)) return [];
    const slots = [];
    for (const entry of raw) {
      const slot = sanitizeEffectSlot(entry);
      if (slot) slots.push(slot);
      if (slots.length >= MAX_EFFECTS) break;
    }
    return slots;
  }

  /** A saved region end, or null for "as long as its material" - see the note in loadTrack. */
  function readEnd(raw, begin) {
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= begin) return null;
    return value;
  }

  function loadTrack(raw, index) {
    const track = {
      id: uid('track'),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Track ${index + 1}`,
      muted: raw.muted === true,
      begin: Math.max(0, readNumber(raw.begin, 0)),
      // Explicitly against null and undefined before coercing. `Number(null)` is 0 and
      // `Number.isFinite(0)` is true, so the obvious one-liner reads an unset end as a *pinned* end
      // of zero - which loads every unarranged part as a part of no length and drops all its notes.
      // Same trap as in trackSpan, caught the same way, and it is worth the two lines twice.
      //
      // An end at or before the beginning is also refused, and that is not only belt-and-braces: a
      // region of no length is not a thing anyone can have meant, so the only way a file contains
      // one is that something wrote it by mistake. Reading it as "unset" repairs such a file on
      // load instead of playing silence and leaving the owner to work out why - which is exactly
      // the promise the rest of this loader makes about every other field.
      end: readEnd(raw.end, Math.max(0, readNumber(raw.begin, 0))),
      // Absent in every save written before pattern lengths existed, and absent is exactly what those
      // songs meant - the material's own length - so this needs no migration either. Anything not a
      // positive number reads as unset rather than as zero, since a pass of no length would not
      // terminate the loop that generates them.
      // Absent in every save written before the scale belonged to a part, and an id this build does
      // not know reads as `snap` - the same repair every other named choice here gets.
      laneStep: LANE_STEP_CHOICES.some((c) => c.id === raw.laneStep) ? raw.laneStep : 'snap',
      // Absent reads as zero, which is a part that sounds where it is written - what every song
      // written before this had. Clamped on the way in, so a hand-edited file cannot ask for an
      // offset bigger than the scheduler's lookahead.
      offsetMs: clampOffsetMs(readNumber(raw.offsetMs, 0)),
      period: readNumber(raw.period, 0) > 0 ? readNumber(raw.period, 0) : null,
      // Absent in every save written before fades existed, which `readNumber` reads as zero - and zero
      // is exactly right here, so this is one of the rare fields that needs no migration at all.
      fadeIn: Math.max(0, readNumber(raw.fadeIn, 0)),
      fadeOut: Math.max(0, readNumber(raw.fadeOut, 0)),
      // A save from before regions existed says how many times the part played, not where it
      // stopped. Kept verbatim and resolved by `trackSpan` on demand rather than converted here,
      // because converting needs the period, the period needs the meter, and load order is not a
      // thing this function should have to know about. It resolves to a plain `end` on the next
      // save and is never written back.
      legacyRepeat: Math.max(1, Math.min(64, Math.round(readNumber(raw.repeat, 1)))),
      instrument: loadInstrument(raw),
      effects: loadEffects(raw.effects),
      notes: [],
    };
    for (const rawNote of Array.isArray(raw.notes) ? raw.notes : []) {
      if (!rawNote || typeof rawNote !== 'object') continue;
      const midi = Number(rawNote.midi);
      const start = Number(rawNote.start);
      const length = Number(rawNote.length);
      // Missing any of the three and there is no note here to draw or play, and nothing sensible
      // to invent in its place - so this is the one thing that gets dropped outright rather than
      // defaulted. Everything that survives goes through the same clamps a fresh note would.
      if (!Number.isFinite(midi) || !Number.isFinite(start) || !Number.isFinite(length)) continue;
      track.notes.push({
        id: uid('note'),
        midi: clampMidi(midi),
        start: Math.max(0, start),
        length: clampLength(length),
        // Absent is not the same as unreadable here: a song saved before velocity existed is not
        // missing information, it is a song where every note is full. Unlike midi/start/length,
        // there is a right answer, so this defaults rather than dropping the note.
        velocity: rawNote.velocity === undefined ? DEFAULT_VELOCITY : clampVelocity(rawNote.velocity),
        // Absent reads as zero, which is a note that starts on its own pitch - so a song written
        // before slides existed comes back with none, which is what it had.
        slide: clampSlide(rawNote.slide),
      });
    }
    sortNotes(track);
    return track;
  }

  function loadKeyMarker(raw) {
    const beat = Number(raw.beat);
    const tonicPc = Number(raw.tonicPc);
    if (!Number.isFinite(beat) || !Number.isFinite(tonicPc)) return null;
    return {
      id: uid('key'),
      beat: Math.max(0, beat),
      tonicPc: ((Math.round(tonicPc) % NOTES_PER_OCTAVE) + NOTES_PER_OCTAVE) % NOTES_PER_OCTAVE,
      scaleId: SCALES.some((s) => s.id === raw.scaleId) ? raw.scaleId : 'major',
    };
  }

  /**
   * Take a document back.
   *
   * This is the only place in the app that reads data it did not just produce, and the format
   * changes whenever the model does, so nothing here trusts anything: every field is a candidate
   * that has to pass a check, and one that fails is replaced by the default a new song would have
   * been given. A save written by an older shape comes back thinner, never broken - and never
   * half-applied, because the whole song is rebuilt in local variables before a single field of
   * the live one is touched.
   *
   * Returns false if there was nothing loadable in it at all, which is the caller's cue to keep
   * whatever it already has.
   */
  function load(raw) {
    const doc = raw && typeof raw === 'object' ? raw : {};

    const nextTracks = [];
    for (const rawTrack of Array.isArray(doc.tracks) ? doc.tracks : []) {
      if (!rawTrack || typeof rawTrack !== 'object') continue;
      nextTracks.push(loadTrack(rawTrack, nextTracks.length));
    }
    // Where an unreadable save stops. Nothing above has touched any state, so refusing costs nothing
    // and leaves what is on screen exactly as it was.
    //
    // The test is whether there is a parts *list*, not whether it has anything in it. An empty list
    // is a real song now that the last part can be removed, and a session left cleared has to come
    // back cleared rather than as the demo. What is still unloadable is a document with no list at
    // all - which is the shape of a truncated file, a foreign one, and of the first ever visit.
    if (!Array.isArray(doc.tracks)) return false;

    const nextMarkers = [];
    for (const rawMarker of Array.isArray(doc.keyMarkers) ? doc.keyMarkers : []) {
      if (!rawMarker || typeof rawMarker !== 'object') continue;
      const marker = loadKeyMarker(rawMarker);
      if (marker) nextMarkers.push(marker);
    }
    nextMarkers.sort((a, b) => a.beat - b.beat);

    // Undoable, because loading over an afternoon of work is the most expensive thing a button in
    // this app can do and taking it back should cost one keystroke. Not on the session's first
    // load, though: an undo entry there would only offer to put an empty song back.
    if (tracks.length) pushUndo();

    tracks = nextTracks;
    masterEffects = loadEffects(doc.master?.effects);
    keyMarkers = nextMarkers;
    const activeIndex = Math.round(readNumber(doc.activeIndex, 0));
    activeTrackId = tracks[Math.max(0, Math.min(tracks.length - 1, activeIndex))]?.id ?? null;
    selection = new Set();
    cursor = Math.max(0, readNumber(doc.cursor, 0));
    pitchCursor = clampMidi(readNumber(doc.pitchCursor, midiFromOctavePc(4, 0)));
    refOctave = Math.max(1, Math.min(7, Math.round(readNumber(doc.refOctave, 4))));
    lastLength = clampLength(readNumber(doc.lastLength, DEFAULT_LENGTH));
    // The two were saved together and should still agree, but a clamped pitch cursor can land
    // outside the window the saved octave shows, and an unreachable cursor is worse than a
    // moved one.
    ensureSlotVisible(pitchCursor);

    emit(CHANGE.TRACKS);
    emit(CHANGE.NOTES);
    emit(CHANGE.KEYS);
    emit(CHANGE.CURSOR);
    emit(CHANGE.SELECTION);
    return true;
  }

  const UNDO_LIMIT = 100;

  /** Call once at the start of a gesture, before the first mutation it makes. */
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  return {
    subscribe,

    // tracks
    getTracks: () => tracks,
    trackById,
    activeTrack,
    addTrack,
    removeTrack,
    setActiveTrack,
    setTrackName(id, name) {
      const track = trackById(id);
      if (!track || track.name === name) return;
      track.name = name;
      emit(CHANGE.TRACKS);
    },
    /**
     * Point a part at an instrument, optionally starting from one of its presets.
     *
     * Undoable, because it throws away every setting the old voice had and there is no way back
     * to them otherwise. Individual knobs are not undoable and should not be - a slider push is
     * not an edit to the song, and filling the undo stack with a drag's worth of them would bury
     * the note you actually want back.
     */
    setInstrument(id, type, preset) {
      const track = trackById(id);
      const resolved = resolveInstrument(type);
      if (!track || !resolved) return;
      pushUndo();
      track.instrument = { type: resolved, state: defaultState(resolved, preset) };
      emit(CHANGE.TRACKS);
    },
    /**
     * A part's effect chain, or the master's when `trackId` is null. The live array, not a copy.
     *
     * Handed out live for the same reason the instrument's state is: the panel writes a knob straight
     * into it, sixty times a second during a drag, and routing that through a setter that copies and
     * emits would be a re-render per pixel. Structural changes - the five below - do go through
     * setters, because those are edits to the song and belong on the undo stack.
     */
    getEffects(trackId) {
      return chainFor(trackId) ?? [];
    },

    addEffect(trackId, type) {
      const chain = chainFor(trackId);
      const definition = getEffect(type);
      if (!chain || !definition || chain.length >= MAX_EFFECTS) return null;
      pushUndo();
      const slot = { type, state: defaultEffectState(type), bypass: false };
      chain.push(slot);
      emit(CHANGE.TRACKS);
      return slot;
    },

    removeEffect(trackId, index) {
      const chain = chainFor(trackId);
      if (!chain || !chain[index]) return;
      pushUndo();
      chain.splice(index, 1);
      emit(CHANGE.TRACKS);
    },

    /** Move one slot along the chain. The order is part of the sound, so this is a real edit. */
    moveEffect(trackId, index, delta) {
      const chain = chainFor(trackId);
      const to = index + delta;
      if (!chain || !chain[index] || to < 0 || to >= chain.length) return;
      pushUndo();
      const [slot] = chain.splice(index, 1);
      chain.splice(to, 0, slot);
      emit(CHANGE.TRACKS);
    },

    /**
     * On or off. Undoable, unlike a knob, because it is the difference between a sound and another
     * sound rather than a position within one - and because it is the control you press while
     * comparing, which is exactly when losing the last real edit would hurt.
     */
    toggleEffectBypass(trackId, index) {
      const chain = chainFor(trackId);
      if (!chain || !chain[index]) return;
      pushUndo();
      chain[index].bypass = !chain[index].bypass;
      emit(CHANGE.TRACKS);
    },

    /** A preset for one slot, read through the same clamps a saved state goes through. */
    setEffectPreset(trackId, index, presetState) {
      const chain = chainFor(trackId);
      if (!chain || !chain[index]) return;
      pushUndo();
      chain[index].state = defaultEffectState(chain[index].type, presetState);
      emit(CHANGE.TRACKS);
    },

    toggleMute(id) {
      const track = trackById(id);
      if (!track) return;
      track.muted = !track.muted;
      emit(CHANGE.TRACKS);
    },
    /**
     * Move a part in the song, or change how long it plays for.
     *
     * Both in one call because they are one gesture as far as the model is concerned, and because
     * moving a part must not silently change its length: `begin` alone would drag `end` along with
     * it if end were stored as a duration, and would leave it behind if stored as a position. It is
     * stored as a position, so moving asks for both and the caller says what it means.
     *
     * `end: null` hands the part back to its material, which is where a part starts life.
     */
    setTrackRegion(id, { begin, end } = {}) {
      const track = trackById(id);
      if (!track) return;
      const wasBegin = trackBegin(track);
      const wasEnd = track.end;
      if (begin !== undefined) {
        const next = Number(begin);
        track.begin = Number.isFinite(next) && next > 0 ? next : 0;
      }
      if (end !== undefined) {
        const next = Number(end);
        // Never shorter than nothing. A region with a negative span would draw inside out and its
        // pass loop would not terminate.
        track.end = end === null || !Number.isFinite(next) ? null : Math.max(trackBegin(track), next);
      }
      // A legacy pass count is now superseded by whatever was just set, and keeping it would make
      // the part snap back to it the moment `end` was cleared.
      if (track.legacyRepeat !== undefined) delete track.legacyRepeat;
      if (trackBegin(track) === wasBegin && track.end === wasEnd) return;
      // The region changes how long the song is and what the roll has to draw, so this is a
      // structural change rather than a track-strip one.
      emit(CHANGE.TRACKS);
      emit(CHANGE.NOTES);
    },

    /**
     * How far ahead of or behind the grid this part sounds, in milliseconds.
     *
     * Negative is early. Nothing moves on screen and no note is edited - see notesInWindow.
     */
    setTrackOffsetMs(id, ms) {
      const track = trackById(id);
      if (!track) return;
      const next = clampOffsetMs(Number(ms));
      if (next === trackOffsetMs(track)) return;
      track.offsetMs = next;
      // A track-strip change: it moves no note and changes no length, it only changes when the part
      // is handed to the clock.
      emit(CHANGE.TRACKS);
    },

    /** Which scale this part's step lane is on. See LANE_STEP_CHOICES. */
    setTrackLaneStep(id, stepId) {
      const track = trackById(id);
      if (!track || !LANE_STEP_CHOICES.some((c) => c.id === stepId)) return;
      if (track.laneStep === stepId) return;
      track.laneStep = stepId;
      // A track-strip change rather than a structural one: it moves no note and changes no length.
      // It does change what swing is defined against, which is why it emits at all.
      emit(CHANGE.TRACKS);
    },

    /**
     * How long one pass of a part is, in whole notes - its pattern length.
     *
     * `null` hands it back to the material, which is where every part starts. Separate from
     * `setTrackRegion` because it is a different question: that one is where the part sits in the
     * song and how long it plays for, this is how long it is before it comes round again, and a
     * gesture only ever means one of them.
     */
    setTrackPeriod(id, beats) {
      const track = trackById(id);
      if (!track) return;
      const was = track.period ?? null;
      const next = Number(beats);
      track.period = beats === null || !Number.isFinite(next) || next <= 0 ? null : next;
      if ((track.period ?? null) === was) return;
      // Structural: it changes how many passes there are, what the roll draws and what plays.
      emit(CHANGE.TRACKS);
      emit(CHANGE.NOTES);
    },

    /**
     * How long a part takes to arrive and to leave, in whole notes.
     *
     * Either may be omitted to leave it alone, the same convention `setTrackRegion` uses, because a
     * gesture only ever moves one of them - one corner of the rack's fade lane is dragged at a time -
     * and a caller that had to restate the other would be one refactor away from clobbering it.
     */
    setTrackFades(id, { fadeIn, fadeOut } = {}) {
      const track = trackById(id);
      if (!track) return;
      const wasIn = track.fadeIn;
      const wasOut = track.fadeOut;
      if (fadeIn !== undefined) {
        const next = Number(fadeIn);
        track.fadeIn = Number.isFinite(next) && next > 0 ? next : 0;
      }
      if (fadeOut !== undefined) {
        const next = Number(fadeOut);
        track.fadeOut = Number.isFinite(next) && next > 0 ? next : 0;
      }
      if (track.fadeIn === wasIn && track.fadeOut === wasOut) return;
      // TRACKS rather than NOTES: a fade changes what a part sounds like and how its strip reads, and
      // moves nothing on the grid. The roll draws it, so it redraws - but no note has changed.
      emit(CHANGE.TRACKS);
    },

    // regions
    trackExtent,
    trackFade: (track, key) => fadeOf(track, key),
    trackPeriod,
    trackOwnPeriod,
    trackLaneStepId,
    trackOffsetMs,
    trackBegin,
    trackSpan,
    trackEnd,
    trackPasses,
    trackCovers,
    repeatOffsets,
    sourceBeat: (trackId, beat) => sourceBeat(trackById(trackId), beat),
    songBeat: (trackId, local, near) => songBeat(trackById(trackId), local, near),

    // notes
    addNote,
    removeNotes,
    updateNote,
    notesAt,
    noteAtPitch,
    newNoteLength,
    getLastLength: () => lastLength,
    setLastLength(beats) {
      lastLength = clampLength(beats);
    },

    // keys
    getKeyMarkers: () => keyMarkers,
    addKeyMarker,
    updateKeyMarker,
    removeKeyMarker,
    keyAt,

    // spiral window
    getRefOctave: () => refOctave,
    setRefOctave,
    midiForSlot,
    slotForMidi,

    // cursors
    getCursor: () => cursor,
    setCursor,
    getPitchCursor: () => pitchCursor,
    setPitchCursor,

    // selection
    getSelection: () => selection,
    isSelected: (id) => selection.has(id),
    setSelection,
    toggleSelected,
    selectedNotes,
    clearSelection: () => setSelection([]),

    songEndBeat,

    // saving
    toDoc,
    load,

    pushUndo,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}
