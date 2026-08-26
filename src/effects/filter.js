// A filter you put on a part, which is not the same thing as the filter inside a synth.
//
// This one is native `BiquadFilterNode`s, and that is a deliberate contrast with instruments/ladder.js
// - a whole worklet written from scratch because a Biquad *cannot* be driven into saturation, cannot
// self-oscillate, and cannot have a drive knob. None of which an insert filter wants. What it wants is
// to be exactly the textbook shape, at exactly the frequency asked for, cheaply, on the whole part;
// the browser's implementation is that, is written in C++, and has its own automation. Reaching for a
// worklet here would be work spent to arrive somewhere slightly worse.
//
// The slope is two cascaded sections rather than one, which is the ordinary way to get 24dB per octave
// and worth stating because cascading also sharpens the resonance: two sections each at Q both peak at
// the cutoff, so the same Q reads louder at 24dB than at 12. The knob is left alone about it rather
// than compensated, because a filter that changed its resonance when you changed its slope would be
// harder to predict than one that does the arithmetic in the open.

import { choiceParam, numberParam } from '../params.js';
import { defineEffect } from '../effects.js';
import { SWEEP_POLARITIES, SWEEP_SHAPES, releaseToRest, scheduleCurve, sweepAt } from '../automation.js';
import { barBeats } from '../meter.js';
import { divisionWholes } from '../tempo.js';

const SHELF_OR_PEAK = new Set(['lowshelf', 'highshelf', 'peaking']);

/**
 * The shapes whose `Q` a `BiquadFilterNode` reads in **decibels** rather than as a Q.
 *
 * This is not a guess and not a browser bug - it is what the Web Audio specification says, and it
 * catches everyone once. For a low pass and a high pass the node's `Q` is `20·log10(q)`; for every
 * other shape it is the Q itself. Measured before it was believed: a low pass at 300Hz with `Q` set to
 * 0.7 lifted a 110Hz tone by **0.6dB**, which is what a Q of 10^(0.7/20) = 1.084 does at that
 * frequency and is nothing like what 0.7 - below the flat value of 0.707 - should do.
 *
 * So the knob is one linear Q for every shape and this converts. Without the conversion "Q 0.7" would
 * mean resonant on a low pass and gentle on a band pass, in the same control, with no way to tell.
 */
const Q_IN_DECIBELS = new Set(['lowpass', 'highpass']);

/**
 * How long one cycle of the sweep lasts, in whole notes, or null for a sweep that is off.
 *
 * Two units in one list, which is not sloppiness: an arrangement sweep is counted in **bars** and a
 * rhythmic one in **note divisions**, and a bar is not a fixed number of wholes - it is whatever the
 * meter says, so 4 bars is 3 wholes in 3/4 and 4 in 4/4. Resolving both here means the sweep follows a
 * meter change as well as a tempo change, and means automation.js never has to know what either of
 * those is: it is handed a number of wholes and a position in wholes.
 */
const SWEEP_BARS = { 'bars-8': 8, 'bars-4': 4, 'bars-2': 2, 'bars-1': 1 };

function sweepWholes(division) {
  const bars = SWEEP_BARS[division];
  if (bars) return bars * (barBeats() || 1);
  return divisionWholes(division);
}

export const FILTER_PARAMS = [
  choiceParam({
    key: 'type',
    label: 'Shape',
    def: 'lowpass',
    choices: [
      { value: 'lowpass', label: 'Low pass', help: 'Keeps what is below the frequency.' },
      { value: 'highpass', label: 'High pass', help: 'Keeps what is above it - the usual way to get a bass part out of the way of a kick.' },
      { value: 'bandpass', label: 'Band pass', help: 'Keeps a band around it and nothing else. Q is the width.' },
      { value: 'notch', label: 'Notch', help: 'Removes a narrow band and keeps everything else.' },
      { value: 'peaking', label: 'Peak', help: 'Lifts or cuts a band without removing it - an EQ bell. Uses Gain.' },
      { value: 'lowshelf', label: 'Low shelf', help: 'Lifts or cuts everything below the frequency. Uses Gain.' },
      { value: 'highshelf', label: 'High shelf', help: 'Lifts or cuts everything above it. Uses Gain.' },
    ],
  }),
  numberParam({
    key: 'frequency',
    label: 'Frequency',
    min: 20,
    max: 20000,
    scale: 'log',
    def: 1200,
    step: 1,
    // Logarithmic, because that is how the ear reads frequency: a linear control spends four fifths
    // of its travel above 4kHz, where almost nothing is.
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}k` : `${Math.round(v)} Hz`),
  }),
  numberParam({
    key: 'q',
    label: 'Q',
    min: 0.1,
    max: 18,
    scale: 'log',
    def: 0.707,
    // A shelf has no Q: `BiquadFilterNode` ignores the parameter for `lowshelf` and `highshelf`, so
    // the knob moved and nothing happened. It says so now instead.
    activeWhen: (state) => state.type !== 'lowshelf' && state.type !== 'highshelf',
    help: 'How resonant, or for a band pass and a notch, how narrow. 0.707 is the flattest a low pass gets — above that it peaks at the cutoff, below it starts rolling off early. It means the same thing in every shape, which takes a conversion: a BiquadFilterNode reads this in decibels for a low and a high pass and as a plain Q for the rest.',
    format: (v) => v.toFixed(2),
  }),
  numberParam({
    key: 'gain',
    label: 'Gain',
    min: -24,
    max: 24,
    def: 0,
    step: 0.5,
    // The other four shapes have nothing to lift, and `setState` already forces this to zero for them.
    activeWhen: (state) => SHELF_OR_PEAK.has(state.type),
    help: 'How much the shelf or the peak lifts or cuts. Greyed out for the shapes that ignore it.',
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
  }),
  choiceParam({
    key: 'slope',
    label: 'Slope',
    def: '12',
    choices: [
      { value: '12', label: '12 dB/oct' },
      { value: '24', label: '24 dB/oct', help: 'Two sections in series. Twice as steep, and the resonance reads louder for the same Q because both sections peak at the cutoff.' },
    ],
  }),
  choiceParam({
    key: 'sweep',
    label: 'Sweep',
    def: 'off',
    help: 'How long one pass of the sweep takes, measured in the song rather than in seconds — so it follows the tempo, it repeats identically every time round the loop, and a render sounds like what you heard. It only moves while the transport is running; auditioning a note leaves the cutoff where the knob is.',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'bars-8', label: '8 bars', help: 'A whole section. What opens a track up.' },
      { value: 'bars-4', label: '4 bars' },
      { value: 'bars-2', label: '2 bars' },
      { value: 'bars-1', label: '1 bar' },
      { value: '1/2', label: '1/2' },
      { value: '1/4', label: '1/4' },
      { value: '1/4t', label: '1/4 triplet' },
      { value: '1/8.', label: '1/8 dotted' },
      { value: '1/8', label: '1/8' },
      { value: '1/16', label: '1/16', help: 'Fast enough to be a texture rather than a movement. With a square shape and a low cutoff this is the gated sound.' },
    ],
  }),
  choiceParam({
    key: 'sweepShape',
    label: 'Sweep shape',
    def: 'sine',
    activeWhen: (state) => state.sweep !== 'off',
    choices: SWEEP_SHAPES,
  }),
  choiceParam({
    key: 'sweepPolarity',
    label: 'Sweep from',
    def: 'down',
    activeWhen: (state) => state.sweep !== 'off',
    help: 'Where the Frequency knob sits in the sweep. Below is the default because a cutoff you set by ear is the brightest you want the part to get, so the sweep should only ever darken it.',
    choices: SWEEP_POLARITIES,
  }),
  numberParam({
    key: 'sweepSpan',
    label: 'Sweep span',
    min: 0,
    max: 6,
    def: 2.5,
    step: 0.05,
    activeWhen: (state) => state.sweep !== 'off',
    help: 'How far the sweep travels, in octaves, and the whole distance rather than the distance each way — so changing where it sweeps from does not change how far it goes. It reaches the cutoff through the node\'s detune input, which is exponential, so two octaves is two octaves at 200 Hz and at 8 kHz.',
    format: (v) => (v <= 0 ? 'off' : `${v.toFixed(2)} oct`),
  }),
];

export default defineEffect({
  id: 'filter',
  name: 'Filter',
  short: 'FLT',
  params: FILTER_PARAMS,
  presets: [
    { name: 'Low 24', state: { type: 'lowpass', frequency: 900, q: 1.2, slope: '24' } },
    { name: 'Rumble out', state: { type: 'highpass', frequency: 90, q: 0.7, slope: '24' } },
    { name: 'Telephone', state: { type: 'bandpass', frequency: 1400, q: 2.2 } },
    { name: 'Air', state: { type: 'highshelf', frequency: 6000, gain: 5 } },
    { name: 'Scoop', state: { type: 'peaking', frequency: 500, q: 1.4, gain: -7 } },
    // The three that move. `Opening` is the one an arrangement wants: a ramp up over eight bars, so the
    // part arrives dull and is fully itself by the ninth bar.
    { name: 'Opening', state: { type: 'lowpass', frequency: 5000, q: 1.1, slope: '24', sweep: 'bars-8', sweepShape: 'up', sweepPolarity: 'down', sweepSpan: 4 } },
    { name: 'Bar pump', state: { type: 'lowpass', frequency: 2600, q: 2.4, slope: '24', sweep: 'bars-1', sweepShape: 'down', sweepPolarity: 'down', sweepSpan: 2 } },
    { name: '8th gate', state: { type: 'lowpass', frequency: 3200, q: 3, slope: '24', sweep: '1/8', sweepShape: 'square', sweepPolarity: 'down', sweepSpan: 3.5 } },
  ],
  summary: (state) => {
    const hz = state.frequency >= 1000 ? `${(state.frequency / 1000).toFixed(1)}k` : Math.round(state.frequency);
    const shape = FILTER_PARAMS[0].choices.find((c) => c.value === state.type)?.label ?? state.type;
    const sweeping = state.sweep && state.sweep !== 'off' && (state.sweepSpan ?? 0) > 0;
    const per = FILTER_PARAMS.find((p) => p.key === 'sweep').choices.find((c) => c.value === state.sweep)?.label;
    return sweeping ? `${shape} ${hz} · ${state.sweepSpan.toFixed(1)} oct/${per}` : `${shape} ${hz}`;
  },

  create(ctx) {
    // Both sections always exist; the 12dB setting simply routes past the second one. Building the
    // second one on demand would mean a graph edit on a parameter change, which is a click, for a
    // saving of one node.
    const sections = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    const input = sections[0];
    const output = ctx.createGain();
    let cascaded = null;

    function wire(next) {
      if (cascaded === next) return;
      sections[0].disconnect();
      sections[1].disconnect();
      if (next) {
        sections[0].connect(sections[1]);
        sections[1].connect(output);
      } else {
        sections[0].connect(output);
      }
      cascaded = next;
    }
    wire(false);

    // Whether the last window this effect was asked about had a moving cutoff. Kept so that turning
    // the sweep off schedules exactly one more window - a flat curve back at the knob - and then stops
    // scheduling. Without it, switching Sweep to Off would leave the detune frozen wherever the last
    // curve had got to, and the cutoff would be some arbitrary distance from the number on screen.
    let sweeping = false;

    return {
      input,
      output,

      /**
       * One window of song time, as a curve on both sections' `detune`.
       *
       * `detune` rather than `frequency`, and that is the same reasoning the modulation matrix uses for
       * every frequency destination: detune is in cents and applies exponentially, so a span of two
       * octaves is two octaves wherever the cutoff happens to be sitting. Written to `frequency` it
       * would be a different gesture at every setting of the knob.
       *
       * Both sections get the same curve even at 12dB per octave, where the second one is routed
       * around. One redundant call against a branch that would have to be kept in step with `wire`.
       */
      schedule(state, window) {
        const wholes = sweepWholes(state.sweep);
        const span = state.sweepSpan ?? 0;
        const active = wholes > 0 && span > 0;
        if (!active && !sweeping) return;
        sweeping = active;
        const shape = state.sweepShape ?? 'sine';
        const polarity = state.sweepPolarity ?? 'down';
        const valueAt = (beat) => 1200 * sweepAt(beat, { wholes, shape, polarity, span });
        for (const section of sections) scheduleCurve(section.detune, { ...window, valueAt });
      },

      /** Cutoff back to where the knob says, once everything already committed has played out. */
      restAutomation(afterTime) {
        sweeping = false;
        for (const section of sections) releaseToRest(section.detune, 0, afterTime);
      },

      setState(state) {
        const type = state.type ?? 'lowpass';
        // Clamped below Nyquist rather than trusted: a BiquadFilter at or above half the sample rate
        // is undefined, and the knob's own maximum of 20kHz is above Nyquist at 32kHz - which some
        // devices really do run at.
        const frequency = Math.min(state.frequency ?? 1200, ctx.sampleRate * 0.49);
        const q = Math.max(0.0001, state.q ?? 0.707);
        const gain = SHELF_OR_PEAK.has(type) ? (state.gain ?? 0) : 0;
        // See Q_IN_DECIBELS. One knob, two units underneath it.
        const nodeQ = Q_IN_DECIBELS.has(type) ? 20 * Math.log10(q) : q;
        for (const section of sections) {
          section.type = type;
          section.frequency.value = frequency;
          section.Q.value = nodeQ;
          section.gain.value = gain;
        }
        wire(String(state.slope ?? '12') === '24');
      },
      dispose() {
        sections[0].disconnect();
        sections[1].disconnect();
        output.disconnect();
      },
    };
  },
});
