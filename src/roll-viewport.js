// Where the roll is looking.
//
// Five small functions that all do the same kind of thing - move the scroller so that something is
// on screen - and share exactly one piece of state between them, the part whose range was last
// followed. They came out of piano-roll.js together because scrolling is the one concern in there
// that never touches a note, a gesture or the DOM below the scroller: everything here reads
// geometry and writes `scrollLeft` / `scrollTop`.
//
// The distinction the names carry is worth keeping straight. *Reveal* moves the least it can, so
// something at the edge comes just inside it and anything already visible is left alone. *Centre*
// puts the thing in the middle regardless, which is right on the way in and wrong afterwards -
// it would yank the view every time.

import { getInstrument } from './instruments.js';

/**
 * The scrolling half of one roll.
 *
 * `metrics` is the roll's geometry, read live: `{ rowHeight, xForBeat, yForMidi }`.
 */
export function createRollViewport({ scroller, song, metrics }) {
  const { rowHeight } = metrics;

  function revealBeat(beat, margin = 120) {
    const x = metrics.xForBeat(beat);
    if (x < scroller.scrollLeft + margin) scroller.scrollLeft = Math.max(0, x - margin);
    else if (x > scroller.scrollLeft + scroller.clientWidth - margin) {
      scroller.scrollLeft = x - scroller.clientWidth + margin;
    }
  }

  // Used once, on the way in: seven octaves of empty grid is a bad first screen, and "reveal"
  // is the wrong shape for it - it would park the note against whichever edge it came from.
  function centerMidi(midi) {
    scroller.scrollTop = Math.max(0, metrics.yForMidi(midi) - scroller.clientHeight / 2);
  }

  function revealMidi(midi, margin = rowHeight * 3) {
    const y = metrics.yForMidi(midi);
    if (y < scroller.scrollTop + margin) scroller.scrollTop = Math.max(0, y - margin);
    else if (y + rowHeight > scroller.scrollTop + scroller.clientHeight - margin) {
      scroller.scrollTop = y + rowHeight - scroller.clientHeight + margin;
    }
  }

  function centreRange(range) {
    const top = metrics.yForMidi(range.high);
    const bottom = metrics.yForMidi(range.low) + rowHeight;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    // Only skip when the *whole* range already fits on screen. Skipping when any part of it was
    // visible was the first attempt and left the kit half off the bottom - the drums span sixteen
    // rows, three of them were showing, and the check called that good enough.
    if (top >= viewTop && bottom <= viewBottom) return;
    centerMidi(Math.round((range.low + range.high) / 2));
  }

  /**
   * Bring the active part's playable range into view when you switch to it.
   *
   * Only an instrument that declares a `noteRange` gets this, and so far only the kit does - and it
   * needs it badly, because a kit lives at 36-51 and the roll is usually parked two octaves above
   * that. Switching to one showed an empty grid over a piano keyboard, which reads as "this part is
   * broken" rather than "you are looking at the wrong end of it".
   *
   * Deliberately only on a change of part, and only when the range is entirely off screen. Doing it
   * on every render would yank the view back every time a note was added, and doing it when the
   * range is partly visible would fight anyone who had scrolled on purpose.
   */
  let lastRangeTrack = null;
  function followInstrumentRange() {
    const track = song.activeTrack();
    if (!track || track.id === lastRangeTrack) return;
    lastRangeTrack = track.id;
    const range = getInstrument(track.instrument?.type)?.noteRange?.();
    if (!range) return;
    // After layout, not during it. Switching to a kit also brings the step lane up, and the lane
    // takes its height out of the roll - so measuring `clientHeight` in this same event uses the
    // height the roll is about to stop having, and centres the kit onto the bottom edge.
    requestAnimationFrame(() => centreRange(range));
  }

  return { revealBeat, revealMidi, centerMidi, centreRange, followInstrumentRange };
}
