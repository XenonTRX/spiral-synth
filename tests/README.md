# Tests

```bash
node --test tests/
```

No harness, no dependencies, no config — `node:test` and `node:assert`, the same way the project
has no build step. Everything here runs in a second.

## What these are for

The module comments are full of exact numbers: *"−1 dB ceiling, peak out 0.8913"*, *"1/8T is 1/12"*,
*"a full-scale sample comes back as 0.44"*. Every one of them was true when it was written and
none of them could fail afterwards, because prose does not run. These files are those same
measurements, moved somewhere they can break.

So the assertions are deliberately the *claims*, not the implementation. A test here should read
like the sentence it came from.

| file | what it pins down |
|---|---|
| `limiter.test.js` | nothing leaves above the ceiling, on six signals; below it, the output is the delayed input bit for bit; release is one time constant |
| `compressor.test.js` | the static curve — the knee is continuous, the ratio is the ratio, a ratio of 1 is a bypass |
| `drive-curve.test.js` | every character normalises a full-scale sine to unity; silence in, silence out at any bias; `fold` folds and the others do not |
| `delay-line.test.js` | fractional reads interpolate, the read distance never collapses, and saturation can only take level away |
| `music-theory.test.js` | the duration lattice is exact — three triplet eighths fill a quarter — and the chords in a key are the ones everybody knows |
| `fft.test.js` | forward-then-inverse is the identity, a pure bin is a pure tone, an impulse is flat |
| `decibels.test.js` | gain and dB are inverses, and silence is a number rather than −∞ |
| `server.test.js` | the static server stays inside its own directory, and one bad URL is a 400 rather than a dead process |
| `strum.test.js` | a rolled chord comes out in pitch order, its earliest note does not move, and the opposite stroke cancels the first exactly |
| `poly-engine.test.js` | notes land on the sample they were scheduled for, the pool steals the oldest, a slide is geometric, and a routing naming nothing is dropped |
| `pluck.test.js` | the plucked string is in tune to within a cent over six octaves, the damping control does not retune it, the fundamental decays at the rate the knob says, and a pick half way along loses the even harmonics |
| `bow.test.js` | the bowed string oscillates at the note asked for, sustains rather than decays, takes longer to speak than the bow takes to move, and stays bounded when the bow is pushed past what a bow can do |
| `piano.test.js` | the partials are progressively sharp of the harmonic series (20 cents by the sixteenth), what the scope is told matches what the voice does, and high partials die faster than low ones |
| `grid.test.js` | the step lane's bar lines are read off a cell's own time, so a triplet lane does not drift over 193 cells or a 5/8 bar; swing is straight at 50%, a 1/12 at two thirds, and only ever late |
| `timeline.test.js` | what the transport and the exporter are both handed: a twelve-step pattern comes round after twelve, steps past the last one are silent but not gone, swing moves the kit and not the bass, and nothing is dropped either way |
| `track-time.test.js` | a part's place in the song — the fold onto its passes and back out again, a span that can stop mid-pass, and a set pattern length that is not rounded to a bar |
| `edits.test.js` | the operations more than one surface reaches, on a part that does not begin at bar 1: a duplicate leaves the cursor on the copy, and a chord root is in song time whichever way it was named |

## What is deliberately not here

**Anything that needs Web Audio.** `AudioWorkletProcessor`, `AudioContext` and the native nodes
do not exist in Node, so the main-thread halves of the effects and instruments are not reachable
from here. This is the reason the DSP lives in its own `*-dsp.js` files in the first place — keep
new arithmetic there and it stays testable.

Worth knowing where that line actually falls, because it was assumed to be tighter than it is:
`song.js` and `timeline.js` both import here despite reaching the instrument *registry*, because a
registry is plain data until something asks it to make a sound. `timeline.test.js` therefore drives a
real song through the real scheduling walk. The swing measurements were originally taken in a
browser console, before anyone tried doing it here.

The three string instruments push that line further than the ones before them: their voice pools
and event queues are in the `*-dsp.js` half too, so `poly-engine.test.js` can ask when a note
started and which voice got stolen, and the processor files are the twenty lines that genuinely
cannot leave the audio thread. `string-helpers.js` is the shared rig — it renders a note through
an engine in 128-sample blocks, exactly as a processor would, and measures the result.

**Anything that needs a DOM.** The panels, the roll, the spiral and the storage layer all touch
`document` or `localStorage`.

**Whether it sounds good.** The limiter tests prove nothing gets past the ceiling; they say
nothing about whether the result is pleasant. That is still a listening question.

When adding a measurement to a comment, check whether it belongs here too. If it can be written
as a number and the code it describes has no browser in it, it can.
