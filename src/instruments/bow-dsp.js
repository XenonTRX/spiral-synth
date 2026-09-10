// A bowed string, which is the same string as the plucked one with something still touching it.
//
// A pluck is an initial condition: put energy in, let it out, done. A bow is a *boundary condition
// that changes every sample* - the hair is in contact with the wire for as long as the note lasts,
// and what it does depends on how fast the string is already moving under it. That is the whole
// difference, and it is why a bowed string cannot be faked with an envelope: the note is not shaped
// by anything, it emerges from a feedback loop between the bow and the string, and everything that
// makes it sound played rather than triggered comes out of that loop rather than being applied to it.
//
// **Stick and slip.** Rosin makes the contact grip hard while the bow and the string move together
// and let go sharply once they slide. So the string is dragged sideways, the restoring force builds
// until it beats the grip, the string snaps back, the bow catches it again, and the cycle repeats at
// whatever rate the string's own round trip dictates. **The pitch comes from the string and the
// waveform comes from the release** - the sawtooth-ish corner in a violin's waveform is the moment
// the grip fails, not a shape anybody chose. `bowFriction` in string-dsp.js is that grip, and the
// note exists because of the curve's steepness. Flatten it and the string never lets go, so the note
// dies as a slow drift; steepen it and it never grips, so there is nothing to release.
//
// **Two delay lines, not one.** A plucked string can be one loop because it is excited once, at one
// point, and after that the shape of it does not matter. A bow acts *at a point*, continuously, so
// the string has to be split there: the wave travelling towards the bridge and the wave travelling
// towards the nut are separate, they arrive at the bow at different times, and where the bow sits
// decides those times. That is what `bowPosition` is - not a tone control bolted on, but the ratio
// between the two halves of the loop - and it is why bowing near the bridge is thin and edgy and
// bowing over the fingerboard is soft: the short half comes back sooner and reinforces different
// harmonics.
//
// **Where the vibrato is.** Nowhere in this file. A violin vibrato is an LFO on the pitch with a
// fade-in so it arrives after the note has settled, and modulation.js already has exactly that -
// LFO 1 has a rate, a shape and a fade, `tune` is declared as a destination in semitones, and the
// panel draws the routing. A fourth private LFO would have been a fourth thing to keep in step for
// no gain. The Vibrato preset ships the routing already wired, which is also how anyone finds out
// the matrix is there.
//
// Audio-thread rules as everywhere: no allocation after the constructor, no browser globals, so a
// test can bow a string and check that it oscillates at the note it was asked for.

import {
  Body,
  DcBlock,
  DelayLine,
  OneZero,
  Rng,
  bowFriction,
  noteSeed,
  stringLineSamples,
  stringLoss,
} from './string-dsp.js';
import { PolyEngine } from './poly-engine.js';

/**
 * What a part's state looks like when nothing has been saved. Mirrors BOW_PARAMS' defaults.
 *
 * These are measured rather than chosen, and the measurement is not "does it sound nice" - it is
 * *which mode the string settles into*, which is a thing a bowed model gets wrong loudly. Swept at
 * 440Hz and read off the harmonic amplitudes: at a bow position of 0.13 the fundamental is the
 * strongest partial at every pressure and damping tried, with the partials above it falling away at
 * 9.4, 12.4, 14.4 and 15.7dB, which is what a bowed string's spectrum looks like. Move the bow to
 * 0.07 and the fundamental drops 24dB below the third harmonic - the string stops moving as a whole
 * and starts moving in thirds. That is not a bug and it is not avoided: it is what bowing hard by the
 * bridge does, and it has a name (sul ponticello). But it is not what the instrument should do before
 * anybody has touched a knob.
 */
export const BOW_DEFAULTS = {
  bowSpeed: 0.14,
  bowPressure: 2,
  bowPosition: 0.13,
  attack: 0.09,
  release: 0.2,
  damping: 0.3,
  body: 0.45,
  bodySize: 1,
  noise: 0.14,
  tune: 0,
  gain: 0.25,
  mod: [],
};

export const BOW_TARGETS = ['gain', 'tune', 'bowSpeed', 'bowPressure'];
const MOD_GAIN = 0;
const MOD_SPEED = 2;
const MOD_PRESSURE = 3;

/**
 * A violin's box, in Hz.
 *
 * Not the guitar's numbers scaled - the two instruments are not the same shape. A violin's air
 * resonance sits around 275Hz (the famous one, just under the open D) and its main plate mode near
 * 460Hz, with a broad hump above that carrying most of what makes the instrument bright. A guitar's
 * equivalents are an octave and a bit lower. Getting these wrong is what makes a bowed-string model
 * sound like a bowed cello played fast.
 */
const VIOLIN_BODY_HZ = [275, 460, 820];
const VIOLIN_BODY_Q = [5, 6.5, 4];
const VIOLIN_BODY_GAIN = [1, 0.8, 0.5];

/**
 * How long the string rings once nothing is bowing it.
 *
 * A violin string is short, thin and heavily loaded by the bridge, so it stops fast - a plucked one
 * is gone in well under a second, which is why pizzicato sounds nothing like a guitar. During a bowed
 * note this is the loss the bow is working against; after the release it is the whole of what is
 * left, so a note ends with a short ring rather than a step.
 */
const STRING_T60_S = 0.55;

/**
 * A bound on what can be in the string, and the one unphysical line in the model.
 *
 * The friction curve can only ever take energy away - it returns a coefficient between 0 and 1 - so
 * the loop is bounded by construction, and for every setting a player could reach it is. What is not
 * bounded is the *product* `v·f(v)`, whose slope steepens with bow pressure, and at the very top of
 * the instrument the two halves of the string are only a sample or two long, so that slope closes a
 * feedback path barely a sample deep. Measured: at 2093Hz with the pressure at its old ceiling of 8,
 * the bow position at 0.05 and no damping at all, the delay lines overflowed to infinity inside forty
 * milliseconds.
 *
 * Two things were changed for that. The pressure range now stops where a bow does rather than well
 * past it, and each half of the string is at least two samples long, which is what makes it a string
 * rather than a one-sample recursion. This clamp is the third: it is seven times any level the model
 * reaches in use, so nothing musical ever meets it, and it turns a divergence into a loud noise -
 * which is what over-pressing a real bow sounds like, and is in any case something you can turn down.
 */
const STRING_CEILING = 1.5;

const bounded = (x) => (x > STRING_CEILING ? STRING_CEILING : x < -STRING_CEILING ? -STRING_CEILING : x);

export class BowVoice {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // The two halves of the string, either side of the bow.
    this.bridge = new DelayLine(stringLineSamples(sampleRate));
    this.nut = new DelayLine(stringLineSamples(sampleRate));
    // The reflection at the bridge, which is where a string loses its top end: the bridge is not a
    // perfect mirror and the body it drives takes energy away. Reflection at the nut is taken as
    // total, because a stopped finger or a nut is much closer to rigid than a bridge is.
    this.reflect = new OneZero();
    this.dc = new DcBlock(sampleRate);
    this.body = new Body(sampleRate, VIOLIN_BODY_HZ, VIOLIN_BODY_Q, VIOLIN_BODY_GAIN);
    this.rng = new Rng();

    this.bridgeDelay = 40;
    this.nutDelay = 60;
    this.loopGain = 0.99;
    this.slope = 3;
    this.bowTarget = 0.24;
    this.bow = 0;
    this.attackStep = 0;
    this.releaseStep = 0;
    this.velocity = 1;
    this.noise = 0;
    this.bodyMix = 0;
    this.energy = 0;
    this.released = false;
    this.active = false;
  }

  start(velocity, state) {
    const v = velocity <= 0 ? 0.02 : velocity > 1 ? 1 : velocity;
    this.bridge.reset();
    this.nut.reset();
    this.reflect.reset();
    this.dc.reset();
    this.body.reset();
    this.rng.reseed(noteSeed(this.id, 23));
    this.velocity = v;
    this.bow = 0;
    this.released = false;
    this.active = true;
    this.energy = 1;
    this.prepare(state);
  }

  /**
   * The bow's own gesture, and the string's geometry, once per quantum.
   *
   * The bow envelope is a straight ramp rather than an exponential, and that is the physical thing
   * rather than a shortcut: what is being ramped is the *speed of an arm*, and an arm accelerates
   * roughly linearly into a stroke. The sound's own attack is nothing like linear, because the
   * stick-slip loop takes a few periods to establish - which is exactly the "the note takes a moment
   * to speak" that a bowed instrument has and a synthesiser does not.
   */
  prepare(state) {
    const hz = this.tuned || this.freq;
    // The reflection filter and the flat loss, solved together so the string's own decay is the same
    // number of seconds at every pitch - see `stringLoss` for why setting them separately does not
    // work at the top of the instrument.
    const loss = stringLoss(hz, this.released ? Math.max(0.02, state.release) : STRING_T60_S, state.damping, this.sampleRate);
    this.reflect.set(loss.b);
    this.loopGain = loss.gain;
    const total = Math.max(4, this.sampleRate / Math.max(1, hz) - this.reflect.delay);
    // Measured from the bridge, because that is how a player thinks about it and how it is written
    // down. Both halves have to be at least a sample long or there is no loop.
    const position = Math.max(0.02, Math.min(0.45, state.bowPosition));
    // Two samples at least in each half. Below that the interpolated read is reaching into what it
    // just wrote and the half stops behaving like a length of string - see STRING_CEILING.
    this.bridgeDelay = Math.max(2, total * position);
    this.nutDelay = Math.max(2, total - this.bridgeDelay);

    // Pressure, inverted: a small slope is a heavy sticky bow that grips through a wide range of
    // speeds, and a large one slips early. Named the way a player would name it, and turned round
    // here rather than in the panel so the knob reads as pressure everywhere else.
    this.slope = Math.max(0.8, Math.min(6, state.bowPressure));
    this.bowTarget = Math.max(0, state.bowSpeed) * this.velocity;
    // Per-sample steps for a 0..1 ramp, so the inner loop is one add.
    this.attackStep = 1 / Math.max(1, Math.max(0.002, state.attack) * this.sampleRate);
    this.releaseStep = 1 / Math.max(1, Math.max(0.01, state.release) * this.sampleRate);
    this.noise = Math.max(0, Math.min(1, state.noise));
    this.body.setScale(Math.max(0.4, state.bodySize));
    this.bodyMix = Math.max(0, Math.min(1, state.body));
  }

  setFrequency(hz, state) {
    this.tuned = hz;
    this.prepare(state);
  }

  release(state) {
    this.released = true;
    this.prepare(state);
  }

  tick(state) {
    // The two waves arriving at the bow, from either end. Read before write, because a loop that
    // reads what it wrote in the same sample is a zero-delay path.
    const atBridge = this.bridge.readAt(this.bridgeDelay);
    const atNut = this.nut.readAt(this.nutDelay);
    // Both ends invert - a fixed end reflects a displacement upside down, which is why a string
    // repeats over two lengths rather than one. The bridge also filters, and that is where the top
    // end of a bowed note goes.
    // The loss is applied once per round trip, at the bridge, because that is the end where the
    // energy actually leaves - into the body, which is what you hear. Applying it at both ends would
    // square it and make the decay knob mean half of what it says.
    const fromBridge = -this.reflect.process(atBridge) * this.loopGain;
    const fromNut = -atNut;

    // The bow ramp. Lifting is the same ramp downwards, so a released note stops being driven and is
    // then just a string with something soft resting on it.
    if (this.released) {
      this.bow -= this.releaseStep;
      if (this.bow < 0) this.bow = 0;
    } else if (this.bow < 1) {
      this.bow += this.attackStep;
      if (this.bow > 1) this.bow = 1;
    }

    let delta = 0;
    if (this.bow > 0) {
      // Hair is not a smooth surface and rosin is not evenly spread, so the bow's grip flickers. It
      // is a small amount of noise and it does a large amount of work: without it every note starts
      // identically and the sustain is a perfectly periodic buzz, which is the sound of a synthesised
      // bow rather than a played one.
      const speed = this.bowTarget * this.bow * (1 + this.noise * 0.4 * this.rng.next())
        + this.mod[MOD_SPEED];
      const velocityDifference = speed - (fromBridge + fromNut);
      let slope = this.slope + this.mod[MOD_PRESSURE];
      if (slope < 0.4) slope = 0.4;
      delta = velocityDifference * bowFriction(velocityDifference, slope) * this.bow;
    }

    // Each half is fed what came back from the other one, plus whatever the bow just did to the
    // string at the point they meet.
    this.nut.write(bounded(fromBridge + delta));
    this.bridge.write(bounded(fromNut + delta));

    const magnitude = atBridge < 0 ? -atBridge : atBridge;
    this.energy += (magnitude - this.energy) * 0.0005;
    // Only ever after the bow has gone: a note still being played is never finished, however quiet
    // the string happens to be at the moment the stroke begins.
    if (this.released && this.bow <= 0 && this.energy < 2e-5) this.active = false;

    // The bridge is what drives the body, and the body is what you hear - a string on its own moves
    // almost no air. So this is the one instrument here where the body is not a colour on top of the
    // string, and mixing it that way is a compromise the knob makes visible rather than hides.
    let out = this.dc.process(atBridge);
    if (this.bodyMix > 0) out += this.body.process(out) * this.bodyMix * 1.4;
    const level = 1 + this.mod[MOD_GAIN];
    return out * (level > 0 ? level : 0);
  }
}

export function createBowEngine(sampleRate, voiceCount = 6) {
  const voices = [];
  for (let i = 0; i < voiceCount; i++) voices.push(new BowVoice(sampleRate));
  return new PolyEngine({ sampleRate, defaults: BOW_DEFAULTS, targets: BOW_TARGETS, voices });
}
