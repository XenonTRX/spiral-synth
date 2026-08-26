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

## What is deliberately not here

**Anything that needs Web Audio.** `AudioWorkletProcessor`, `AudioContext` and the native nodes
do not exist in Node, so the main-thread halves of the effects and instruments are not reachable
from here. This is the reason the DSP lives in its own `*-dsp.js` files in the first place — keep
new arithmetic there and it stays testable.

**Anything that needs a DOM.** The panels, the roll, the spiral and the storage layer all touch
`document` or `localStorage`.

**Whether it sounds good.** The limiter tests prove nothing gets past the ceiling; they say
nothing about whether the result is pleasant. That is still a listening question.

When adding a measurement to a comment, check whether it belongs here too. If it can be written
as a number and the code it describes has no browser in it, it can.
