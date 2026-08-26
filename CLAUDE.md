# Spiral Synth — working notes

A browser DAW built around a chromatic pitch-spiral. No build step, no dependencies, no
framework: ES modules served raw by `server.js` and loaded by `index.html`.

## Orientation

- **[`README.md`](README.md)** — what it does, the keyboard map, and a table of every module and
  what it owns. Read that table before hunting for where something lives.
- **Module header comments** — why things are the way they are. Most files open with the reasoning
  behind the approach and what the alternatives cost. Read the head of a file before changing it.

## Run and verify

```bash
node server.js     # http://127.0.0.1:5173
node --test tests/ # the DSP and server assertions
```

There is a `.claude/launch.json` entry (`spiral-synth`), so the preview tooling can start it
directly rather than through a shell.

## Conventions that are load-bearing

**DSP is split three ways.** A worklet effect or instrument is `*-dsp.js` (pure arithmetic, no
browser globals, no Web Audio) + `worklets/*-processor.js` (the `AudioWorkletProcessor` shell) +
a main-thread wrapper. Keep new DSP in the `-dsp.js` half: it is the half the tests can import,
and the half the offline exporter and the live context both reach through the same code path.

**`src/params.js` must stay import-light.** A knob descriptor is defined there so that both
registries can depend on it without anything depending back — that is what keeps it out of a
cycle. Do not import panels, engines or registries into it.

**Anything reachable from two surfaces lives in `src/edits.js`.** The roll, the spiral, the step
lane and the keyboard all mutate the same song; an operation implemented twice will diverge.

**Worklets load per context, not per page.** `audioWorklet.addModule` is per-`AudioContext`, and
every offline render (export, scope, measurement) is a new context. Always go through
`src/worklet-loader.js` — it holds the registry in a `WeakMap` so throwaway render contexts can
be collected.

**Tempo has one owner (`src/tempo.js`).** A signal processor should never learn what a bar is:
resolve note divisions to seconds on the main thread and send seconds across.

**Colours come from the stylesheet.** Canvas drawing code reads them through `src/theme.js`
rather than hard-coding hex, so the roll, the spiral and the scope stay in one palette.

**Shared helpers already exist — check before writing a fourth copy.** `src/decibels.js` (gain
and dB), `src/format.js` (knob value formatting), `src/observable.js` (subscribe/notify),
`src/param-state.js`, `src/param-controls.js`, `src/effects/worklet-effect.js`,
`src/instruments/worklets/voice-dsp.js`.

## Documentation

Explanation belongs in a header comment on the module it explains, where it is next to the code
and gets read while editing. Keep `README.md` about *what* and *where*; it is the file that gets
read every time and it should stay short.

When a comment quotes an exact number, assert it in `tests/` as well — prose cannot fail.
