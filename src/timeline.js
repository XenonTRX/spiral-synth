// Which notes are where, in song time.
//
// One walk, in one place, because there are now two things that need it and they must not disagree.
// It used to live inside the transport's `fireWindow`, welded to the anchor and the lookahead, which
// was fine while playing was the only way to hear a song. Export is the second way, and if it had
// re-implemented this walk the two would have drifted - a mute honoured in one and not the other, a
// repeat counted from a different place - and drifted *silently*, because both would still produce
// plausible audio. The bug would have been "the file isn't quite what I heard", found late and hard
// to pin down. So the transport and the exporter now ask the same question of the same function and
// differ only in what they do with the answer: one hands each note to the audio clock as it
// approaches, the other hands all of them over at once.

import { SWING_STRAIGHT, getSwing, laneStepBeats, swungStart } from './grid.js';
import { getInstrument } from './instruments.js';
import { beatsForSeconds, secondsForBeats } from './music-theory.js';
import { slideSources } from './song.js';
// The tempo, because a part's offset is in milliseconds and everything on the way out of here is in
// whole notes. Converting it needs the one number tempo.js owns - see its header for why reaching
// for it directly is the arrangement rather than a shortcut.
import { getBpm } from './tempo.js';

// Starts are sums of halves, thirds and sixteenths, so a note landing exactly on a region boundary
// can compute a hair either side of it.
const EPSILON = 1e-9;

/**
 * Whether this part is a step sequencer, which is the only thing swing applies to.
 *
 * Swing is the drum machine's, not the song's, and that is a scope decision rather than a limitation
 * of the arithmetic - it would work on any part. A shuffle set from a control in the step lane has no
 * business moving the bass line, and the pairing it is defined against is the *lane's* step, which
 * only a part with a lane has. Widening it to the song means giving it a home that is not the lane
 * and a subdivision of its own; both are reasonable and neither is this.
 *
 * Asked per part rather than per note: it is a registry lookup, and the walk below runs every
 * scheduling window.
 */
const hasSteps = (track) => Boolean(getInstrument(track?.instrument?.type)?.steps);

/**
 * Every note that *starts* inside `[from, to)` of song time, in every unmuted part.
 *
 * Half-open on purpose, and the half that matters is the start: a note already sounding when the
 * window opens is deliberately not yielded again. It was committed whole, with its full length, in
 * whichever window it began - so a window is a list of note *beginnings*, not of what is audible.
 *
 * A repeated part contributes the same note once per pass, at its own offset. The passes are
 * generated rather than stored, so a part that repeats sixteen times costs a loop rather than
 * sixteen copies, and editing it changes every pass at once because there is only ever one of each
 * note.
 *
 * The yielded `length` is the note's, clipped to where the part stops. Callers must use it rather
 * than `note.length` - that is the difference between a part that ends and a part that fades out
 * whenever its last note happens to finish.
 *
 * `slide` is the note's glide, resolved: which pitch it arrives from and how long it takes, or null
 * for the overwhelming majority of notes that simply start where they are. Resolved here rather
 * than by the caller because it depends on the *neighbouring* notes, and this is the walk that has
 * them - a scheduler holding one note at a time would have had to go and look, and the two callers
 * would have had to agree on how. The time is in whole notes, like everything else here, and it is
 * clipped to the note's own sounding length: a slide longer than the note it is on would be a note
 * that never reaches its pitch, which is not a musical intention anyone has to be allowed to state.
 */
export function* notesInWindow(song, from, to) {
  // One reading of the swing for the whole window, so a knob moved mid-window cannot shuffle half of
  // it one way and half the other.
  const swing = getSwing();
  const shuffling = swing > SWING_STRAIGHT;
  for (const track of song.getTracks()) {
    if (track.muted) continue;
    // One amount of swing, each part shuffling against *its own* scale - so a kit at a 1/32 and one
    // at a 1/8 both shuffle, and neither is shuffled at the other's resolution. Which is the whole
    // reason the scale had to stop being global: a single step size can only describe one part.
    const swingStep = shuffling && hasSteps(track) ? laneStepBeats(track) : 0;
    const swung = swingStep > 0;
    const end = song.trackEnd(track);
    // How long one pass is, which is also where the pattern stops - see trackPeriod.
    const period = song.trackPeriod(track);
    // The part's own lag, converted once per part rather than per note. Positive is late.
    const offsetMs = song.trackOffsetMs(track);
    const offsetBeats = offsetMs === 0 ? 0 : beatsForSeconds(offsetMs / 1000, getBpm());
    // Only when there is one, because this is a pass over the part's whole note list and it runs
    // every scheduling window. A part with no slides in it - which is most parts - pays one scan
    // for the question and nothing for the answer.
    const sources = track.notes.some((n) => n.slide > 0) ? slideSources(track.notes) : null;
    for (const offset of song.repeatOffsets(track)) {
      for (const note of track.notes) {
        // Past the last step, so it does not play. The material keeps it - shorten a pattern and
        // lengthen it again and the steps come back - but one pass is `period` long and anything
        // outside that is outside the pattern. A *derived* period always contains the material it was
        // derived from, so this can only ever reject a note when someone has set a length themselves.
        if (period > 0 && note.start >= period - EPSILON) continue;
        const start = note.start + offset;
        if (start < from || start >= to) continue;
        // Past where the part stops, so it never sounds - which is how a part can enter halfway
        // through its own last pass and leave again on a beat that is not a pass boundary.
        if (start >= end - EPSILON) continue;
        // And clipped, for the note that straddles the boundary. A region that let its last note
        // ring on past the end would make "the drums stop here" mean "the drums mostly stop here",
        // and the one place it is most audible is exactly the transition you set the end for.
        const length = Math.min(note.length, end - start);
        if (length <= EPSILON) continue;
        // The sources are read off the part's *material*, so the note that opens it has none - and
        // neither, therefore, does the note that opens any pass repeating it. That is a decision
        // rather than an oversight: a pass could be made to glide out of the last note of the one
        // before it, and the boundary is the one place a listener is counting on the loop landing
        // cleanly.
        const source = note.slide > 0 ? sources?.get(note.id) : null;
        const slide = source ? { fromMidi: source.midi, beats: Math.min(note.slide, length) } : null;
        // Last, and on the way out rather than on the way in. Everything above - the window, the
        // part's end, the clip - is decided on the straight position the note was written at, and only
        // the moment it sounds is shifted. That ordering is the whole of why this is safe for swing:
        // it moves a note later and never earlier, so nothing can be shifted out of a window it was
        // selected for, and every note is still yielded exactly once. Its *length* is left alone too,
        // which costs nothing where swing applies - a drum ignores the length entirely.
        //
        // The part's offset then shifts the result, and *can* be negative, which is the whole point of
        // it - a part that sits fractionally ahead of the grid is the half of this that no amount of
        // moving notes about can express, since nothing can be written before the first beat. That it
        // is bounded well inside the scheduler's lookahead is what keeps "earlier" from meaning "in
        // the past" (see MAX_TRACK_OFFSET_MS), and the floor at zero is for the one place that is not
        // enough: a note on the very first beat, which has no earlier to be moved to.
        let when = swung ? swungStart(start, swingStep, swing) : start;
        if (offsetBeats !== 0) when = Math.max(0, when + offsetBeats);
        yield { track, note, start: when, length, slide };
      }
    }
  }
}

/**
 * A resolved slide in the units the audio clock keeps, which is the last thing either caller does
 * with one.
 *
 * One line, and it lives here rather than in the two callers for the reason the walk above does:
 * playing and rendering must not be able to disagree about a note, and "seconds per whole note"
 * being written out twice is exactly how they would start to.
 */
export function glideFor(slide, bpm) {
  if (!slide) return null;
  return { fromMidi: slide.fromMidi, seconds: secondsForBeats(slide.beats, bpm) };
}

/**
 * The whole song once through, unlooped - what a file contains.
 *
 * The `+ 1` is slack rather than arithmetic. `songEndBeat` is the last moment anything is *still
 * sounding*, so nothing can start at or after it and the bound is already sufficient; a beat of
 * headroom costs one comparison per note and means a future definition of "the end" that rounds
 * some other way cannot silently drop the last note.
 */
export function songNotes(song) {
  return notesInWindow(song, 0, song.songEndBeat() + 1);
}
