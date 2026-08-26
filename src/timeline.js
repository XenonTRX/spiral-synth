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

import { secondsForBeats } from './music-theory.js';
import { slideSources } from './song.js';

// Starts are sums of halves, thirds and sixteenths, so a note landing exactly on a region boundary
// can compute a hair either side of it.
const EPSILON = 1e-9;

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
  for (const track of song.getTracks()) {
    if (track.muted) continue;
    const end = song.trackEnd(track);
    // Only when there is one, because this is a pass over the part's whole note list and it runs
    // every scheduling window. A part with no slides in it - which is most parts - pays one scan
    // for the question and nothing for the answer.
    const sources = track.notes.some((n) => n.slide > 0) ? slideSources(track.notes) : null;
    for (const offset of song.repeatOffsets(track)) {
      for (const note of track.notes) {
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
        yield { track, note, start, length, slide };
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
