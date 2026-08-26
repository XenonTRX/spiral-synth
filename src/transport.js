// Playback, on one shared timeline.
//
// The old transport walked each track's list of steps, holding each one for its own length.
// That structure is gone: notes overlap, they start wherever they like, and two of them in the
// same track can be sounding at once. So the scheduler stops thinking in "next step" and thinks
// in windows instead - every tick it asks which notes *begin* in the next slice of song time,
// wherever they are and whoever owns them, and commits those to the audio clock.
//
// It is still a lookahead scheduler rather than a chain of timers, and for the same reason as
// before: setTimeout drifts by milliseconds a tick, which is inaudible alone and immediately
// audible as flamming between two parts. The timer's only job is to wake up often enough to
// keep the audio clock fed.

import { audioNow, restMasterAutomation, scheduleMasterAutomation } from './audio.js';
import { playNote, restAutomation, scheduleAutomation } from './engine.js';
import { RETURN_S, fadeShapeOf } from './automation.js';
import { beatsForSeconds, secondsForBeats } from './music-theory.js';
import { ceilToBar } from './meter.js';
import { glideFor, notesInWindow } from './timeline.js';
import { referenceEndBeat } from './reference.js';

const TICK_MS = 25;
const LOOKAHEAD_S = 0.15;
// Browsers throttle timers in a hidden tab to roughly one tick a second, which would leave the
// normal lookahead committing notes that are already in the past - they'd bunch up at the clamp
// every instrument applies to a start time and the beat would collapse. Committing further ahead
// costs nothing there.
const HIDDEN_LOOKAHEAD_S = 1.5;
const START_PAD_S = 0.06; // headroom so the very first notes aren't already late
const MAX_SLICES_PER_TICK = 64; // a zero-length loop must not pin the scheduler

export function createTransport({ song, getBpm, getLooping, onPlayhead, onStateChange, onWindow }) {
  let playing = false;
  let intervalId = null;
  let frameId = null;

  // The mapping from song time to audio time is one anchor and a tempo: a beat `b` sounds at
  // `anchorTime + secondsForBeats(b - anchorBeat)`. Absolute beats keep counting up through
  // every repeat, so the loop is a fold applied when reading rather than a reset of the clock.
  let anchorBeat = 0;
  let anchorTime = 0;
  let scheduledAbs = 0;
  let originBeat = 0;
  let loopBeats = 0;
  let lastBpm = 0;
  // The end of the last window handed to an AudioParam, which is where the automation has to be sent
  // home from when the transport stops. Not `now`: cancelling inside a curve that is already running
  // removes the whole curve and steps the parameter, which is a click. See `restAutomation`.
  let lastCommittedTime = 0;
  let restUntil = 0;

  const timeForAbs = (abs) => anchorTime + secondsForBeats(abs - anchorBeat, getBpm());
  const absAtTime = (time) => anchorBeat + beatsForSeconds(time - anchorTime, getBpm());

  /**
   * How far the song runs: its last note, or the end of an imported recording, whichever is later.
   *
   * The recording counts because of what it is for. You transcribe by writing a few bars against a
   * four-minute record, and a transport that stopped at the end of the notes would put the rest of
   * the record out of reach - the one part of it you have not done yet. See `referenceEndBeat`.
   */
  const endBeat = () => Math.max(song.songEndBeat(), referenceEndBeat());

  /** The loop's length: that end rounded up to a whole bar, so a repeat lands on a downbeat. */
  function loopLength() {
    const end = endBeat();
    if (end <= 0) return 0;
    return ceilToBar(end);
  }

  const songPosFor = (abs) => (loopBeats > 0 && getLooping() ? ((abs % loopBeats) + loopBeats) % loopBeats : abs);

  // Commit one window of song time to the audio clock. Which notes are in it is timeline.js's
  // question - the same one the exporter asks - and this adds the only part that is peculiar to
  // playing: where in *audio* time a beat lands, which depends on an anchor and a tempo that a
  // file does not have.
  function fireWindow(from, to, absFrom, bpm) {
    // What this window *is*, before anything is done with it: a span of song position, and the span
    // of audio time it lands in. Anything that has to run alongside the song without being a note
    // needs exactly that pair and nothing else - the imported recording the roll draws behind the
    // notes is the first such thing, and it wants the untrimmed times, so this is announced before
    // the automation below starts trimming them against what has already been committed.
    onWindow?.({
      fromBeat: from,
      toBeat: to,
      startTime: timeForAbs(absFrom),
      endTime: timeForAbs(absFrom + (to - from)),
    });

    for (const { track, note, start, length, slide } of notesInWindow(song, from, to)) {
      const when = timeForAbs(absFrom + (start - from));
      // Both ends of the note in one call. The sequencer is the case that knows the length up
      // front; the instrument is told the start and the stop separately anyway, so that a
      // player who only knows the first can say the second when it arrives.
      //
      // The slide is converted here for the same reason the length is: song time is in whole notes
      // and the audio clock is in seconds, and the tempo is the thing this side of the seam has.
      playNote(track, note.midi, when, secondsForBeats(length, bpm), note.velocity, glideFor(slide, bpm));
    }
    // And everything that moves without being played: a part's fades, and any effect with a sweep.
    //
    // The same window, deliberately. A window here is a span of song *position* paired with the span of
    // audio time it lands in, which is exactly what a function of song position needs to be committed -
    // and the window has already been split at the loop seam two lines above, so it never straddles the
    // point where the song position jumps back. Getting that for nothing is why automation is scheduled
    // here rather than in a mechanism of its own.
    //
    // Trimmed against what has already been given to an AudioParam, because `setValueCurveAtTime`
    // refuses to span an existing event and there are two ways to end up asking it to. A **tempo
    // change** re-anchors the clock, so the next window's audio time can land before the end of a curve
    // committed at the old tempo. And **stopping and starting again** leaves the rest ramp's endpoint
    // up to RETURN_S in the future. Trimming keeps the song position and the audio time in step - the
    // window loses its first slice at both ends together - so the automation stays exactly where the
    // song says it should be rather than sliding.
    const span = to - from;
    const endTime = timeForAbs(absFrom + span);
    let startTime = timeForAbs(absFrom);
    let fromBeat = from;
    if (startTime < lastCommittedTime) {
      const overlap = (lastCommittedTime - startTime) / (endTime - startTime);
      fromBeat = from + span * overlap;
      startTime = lastCommittedTime;
    }
    if (endTime > startTime) {
      const moving = { fromBeat, toBeat: to, startTime, endTime };
      scheduleAutomation(song.getTracks(), moving, (track) => fadeShapeOf(song, track));
      scheduleMasterAutomation(moving);
      lastCommittedTime = endTime;
    }
  }

  function schedule() {
    const bpm = getBpm();
    // A tempo change re-anchors rather than rescaling history: everything already committed
    // keeps the tempo it was committed at (at most a lookahead's worth), and everything from
    // here runs at the new one.
    if (bpm !== lastBpm) {
      const now = audioNow();
      anchorBeat = absAtTime(now);
      anchorTime = now;
      lastBpm = bpm;
      scheduledAbs = Math.max(scheduledAbs, anchorBeat);
    }

    loopBeats = loopLength();
    const horizon = absAtTime(audioNow() + (document.hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S));

    if (!getLooping() && scheduledAbs > endBeat()) {
      // Let the last note ring out before tearing the voices down.
      if (timeForAbs(scheduledAbs) < audioNow()) stop();
      return;
    }

    let abs = scheduledAbs;
    let slices = 0;
    while (abs < horizon && slices++ < MAX_SLICES_PER_TICK) {
      const pos = songPosFor(abs);
      // How much song time is left before the loop wraps - a window may not straddle the seam,
      // because the two sides of it are different places in the song.
      const room = loopBeats > 0 && getLooping() ? loopBeats - pos : horizon - abs;
      const span = Math.min(horizon - abs, room);
      if (span <= 0) break;
      fireWindow(pos, pos + span, abs, bpm);
      abs += span;
    }
    scheduledAbs = abs;
  }

  // The playhead is read off the audio clock every frame rather than driven by timers, so it
  // cannot drift from what you are hearing however long the loop runs.
  function frame() {
    frameId = requestAnimationFrame(frame);
    if (!playing) return;
    const abs = Math.max(anchorBeat, absAtTime(audioNow()));
    onPlayhead?.(songPosFor(abs));
  }

  function start() {
    if (playing) return;
    playing = true;
    originBeat = song.getCursor();
    loopBeats = loopLength();
    // Starting from a cursor parked past the end of the song would look like nothing happened.
    if (loopBeats > 0 && originBeat >= loopBeats) originBeat = 0;
    anchorBeat = originBeat;
    anchorTime = audioNow() + START_PAD_S;
    scheduledAbs = originBeat;
    lastBpm = getBpm();
    // Past the rest ramp a previous stop may still have pending - see the trimming in `fireWindow`.
    lastCommittedTime = Math.max(anchorTime, restUntil);
    onStateChange?.(true);
    intervalId = setInterval(schedule, TICK_MS);
    schedule();
    frameId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(intervalId);
    intervalId = null;
    cancelAnimationFrame(frameId);
    frameId = null;
    // Fades back to unity and sweeps back to their knobs, from the end of the last committed window
    // rather than from now - so a part you stop mid-fade is not yanked to full level, and a note still
    // ringing goes on being faded until the automation runs out.
    const home = Math.max(audioNow(), lastCommittedTime);
    restAutomation(home);
    restMasterAutomation(home);
    restUntil = home + RETURN_S;
    onWindow?.(null);
    onPlayhead?.(null);
    onStateChange?.(false);
  }

  return {
    start,
    stop,
    toggle: () => (playing ? stop() : start()),
    isPlaying: () => playing,
    /** Where playback began, so stopping can put the cursor back rather than leaving it adrift. */
    getOrigin: () => originBeat,
  };
}
