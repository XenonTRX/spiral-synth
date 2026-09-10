// The part of a worklet instrument that is not the sound.
//
// Three instruments arrived at once - a plucked string, a bowed string and a struck one - and every
// one of them needs the same hundred lines that have nothing to do with strings: a pool of voices
// with a rule for what to steal, a queue of events drained against the audio clock rather than
// against the block edge, a routing matrix flattened into arrays the inner loop can read, and a
// modulation clock coarser than the sample clock. The two worklets written before them each have
// their own copy of all of it, which was correct when there was one and defensible when there were
// two; four copies is where the thing being copied should have a name.
//
// **What this is not.** It is not a base class for voices and it does not know what a note sounds
// like. voice-dsp.js draws the line as "share the arithmetic, not the architecture", and this is the
// other side of that line: the architecture, shared once, with the arithmetic left entirely to the
// voice. The engine never looks inside a voice except through the five methods below, and a voice
// never learns that queues or stealing exist.
//
// **The contract.** A voice is a plain object the caller constructs (so it can allocate its own
// buffers against the sample rate, once, before any deadline exists) with:
//
//   - `start(velocity, state)` - a new note begins. `this.freq` is already set.
//   - `setFrequency(hz, state)` - the pitch moved: a glide arriving, or something routed at tune.
//   - `release(state)` - let go of it. The voice decides what that means and how long it takes.
//   - `tick(state)` - one sample, including its own velocity and whatever `this.mod` says.
//   - `active` - false when it has finished and the slot can be reused. The *voice* decides this,
//     because only it knows when it is inaudible, and for a string that is not a knob on an
//     envelope: it is when the energy in the delay line has gone.
//
// Everything else on a voice - the note id, how old it is, where its pitch came from and is going -
// is written by the engine and documented at `allocate`.
//
// Same audio-thread rules as anything it drives: nothing here allocates after construction, and
// there are no browser globals, which is what lets a test render a note (see tests/).

import { MOD_SOURCES } from '../modulation.js';

/** More than the panel will let anyone build, so the flattened arrays can be fixed. */
export const MAX_ROUTINGS = 8;

/**
 * How often modulation is re-evaluated, in samples. The ladder's number, and its reasoning:
 *
 * Not per sample, which is pure waste - sixteen voices times eight routings is a hundred and
 * twenty-eight source evaluations per sample, most of them `Math.sin`, for quantities whose fastest
 * cycle is a thousand samples long. Not per quantum either, which is where this would have gone
 * wrong: 128 samples is 2.9ms, so a fast LFO would arrive as a staircase of 344Hz steps and put a
 * buzz into whatever it was aimed at. Eight samples is a 5.5kHz update rate against a 40Hz ceiling.
 */
export const MOD_SUBBLOCK = 8;

const SOURCE_BY_ID = Object.create(null);
for (const source of MOD_SOURCES) SOURCE_BY_ID[source.id] = source;

export class PolyEngine {
  /**
   * `targets` is the destination list, in the order the codes run - so `targets[0]` is what a voice
   * reads as `this.mod[0]`. Strings rather than numbers at the seam, because that is what a saved
   * routing names and what the panel shows; the translation happens once, here, when the state
   * changes, and never in the inner loop.
   */
  constructor({ sampleRate, defaults, targets, voices }) {
    this.sampleRate = sampleRate;
    this.state = { ...defaults };
    this.targets = targets;
    this.voices = voices;
    this.targetCode = Object.create(null);
    for (let i = 0; i < targets.length; i++) this.targetCode[targets[i]] = i;
    for (const voice of voices) {
      voice.active = false;
      voice.mod = new Float64Array(targets.length);
      voice.id = -1;
      voice.age = 0;
      voice.midi = 60;
      voice.freq = 440;
      voice.startTime = 0;
      voice.releasedAt = Infinity;
      voice.glideFrom = 0;
      voice.glideTo = 0;
      voice.glideSeconds = 0;
      voice.tuned = 0;
    }

    // Events arrive with a time on the audio clock and are applied at the sample they land on rather
    // than at the start of whatever quantum is running. 128 samples is 2.9ms, and two parts
    // disagreeing by 2.9ms is exactly the flamming the scheduler exists to avoid.
    this.events = [];

    this.routeSource = new Array(MAX_ROUTINGS).fill(null);
    this.routeTarget = new Int32Array(MAX_ROUTINGS);
    this.routeDepth = new Float64Array(MAX_ROUTINGS);
    this.routeCount = 0;
    this.tuneCode = this.targetCode.tune ?? -1;
    // Built here as well as on every `params` message, because the defaults can already contain a
    // matrix - a preset that ships a routing pre-wired is exactly that - and in the live app the
    // omission was invisible: the pool pushes the state on every note, so the routes were rebuilt a
    // moment later and nothing was ever heard to be wrong. A test that constructed an engine and
    // rendered straight from it found them missing.
    this.rebuildRoutes();
  }

  /**
   * Everything that has to be true before the first sample, which on an offline render is
   * everything: a message posted to a port is delivered between quanta, and an OfflineAudioContext
   * finishes rendering before the main thread's message queue has been serviced. Measured, not
   * assumed - see the note in instruments/ladder.js.
   */
  init(initial) {
    if (initial?.state) this.setParams(initial.state);
    if (initial?.events?.length) {
      // Only things that happen at a time belong in a queue drained by time. Anything else would
      // never compare true and would block everything behind it, which is how this went wrong once
      // already: a params message with no `time` sat at the head of the queue and every note waited
      // forever behind it, and the render came back silent.
      for (const event of initial.events) if (typeof event.time === 'number') this.events.push(event);
      this.events.sort((a, b) => a.time - b.time);
    }
  }

  /** Field by field into the object the inner loop already reads, so nothing is allocated. */
  setParams(next) {
    for (const key in next) this.state[key] = next[key];
    this.rebuildRoutes();
  }

  message(message) {
    if (!message) return;
    if (message.type === 'params') this.setParams(message.state);
    else if (message.type === 'noteOn' || message.type === 'noteOff') {
      this.events.push(message);
      this.events.sort((a, b) => a.time - b.time);
    } else if (message.type === 'panic') {
      for (const voice of this.voices) voice.active = false;
      this.events.length = 0;
    }
  }

  /**
   * Flatten the matrix into the arrays the inner loop reads.
   *
   * Runs between quanta, so it is allowed to look things up by string and skip over rubbish. It
   * writes into arrays that already exist rather than building new ones, because a fresh array here
   * is garbage to collect on the audio thread.
   */
  rebuildRoutes() {
    this.routeCount = 0;
    const matrix = this.state.mod;
    if (!Array.isArray(matrix)) return;
    for (let i = 0; i < matrix.length && this.routeCount < MAX_ROUTINGS; i++) {
      const routing = matrix[i];
      if (!routing) continue;
      const code = this.targetCode[routing.target];
      const source = SOURCE_BY_ID[routing.source];
      const depth = +routing.depth;
      if (code === undefined || !source || !depth) continue;
      this.routeSource[this.routeCount] = source;
      this.routeTarget[this.routeCount] = code;
      this.routeDepth[this.routeCount] = depth;
      this.routeCount++;
    }
  }

  /**
   * A slot for a new note: a free one, or the one that has been going longest.
   *
   * Stealing the oldest is the least bad answer - the alternative is dropping the note you just
   * asked for - and it is a worse trade here than on a subtractive synth, because these voices ring
   * for whole seconds after they are released and a chord followed by a chord can genuinely want
   * more strings than a hand has. Which is the argument for the pools being generous rather than for
   * a cleverer rule.
   */
  allocate(event, now) {
    let free = -1;
    let oldest = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (!voice.active) {
        free = i;
        break;
      }
      if (voice.age > this.voices[oldest].age) oldest = i;
    }
    const voice = this.voices[free === -1 ? oldest : free];
    const freq = event.freq > 0 ? event.freq : 440;
    const sliding = event.glideFrom > 0 && event.glideSeconds > 0;
    voice.active = true;
    voice.id = event.id;
    voice.age = 0;
    voice.midi = event.midi ?? 60;
    voice.startTime = now;
    voice.releasedAt = Infinity;
    voice.freq = sliding ? event.glideFrom : freq;
    voice.glideFrom = sliding ? event.glideFrom : 0;
    voice.glideTo = freq;
    voice.glideSeconds = sliding ? event.glideSeconds : 0;
    // Cleared so `retune` below always fires: a voice reusing a slot would otherwise still be holding
    // the last note's pitch here, and a new note that happened to land on the same frequency as the
    // one before it would never be told what it was.
    voice.tuned = 0;
    voice.mod.fill(0);
    voice.start(event.velocity ?? 1, this.state);
    this.retune(voice);
    return voice;
  }

  releaseVoice(id, at) {
    for (const voice of this.voices) {
      if (voice.active && voice.id === id && voice.releasedAt === Infinity) {
        voice.releasedAt = at - voice.startTime;
        voice.release(this.state);
      }
    }
  }

  /**
   * The pitch this voice comes out at, whatever moved it: the note, the tune knob, anything routed
   * at tune, and a glide still arriving. All four end up here so no two of them can be applied in a
   * different order or, worse, one of them forget the others.
   */
  retune(voice) {
    const semitones = (this.state.tune ?? 0) + (this.tuneCode >= 0 ? voice.mod[this.tuneCode] : 0);
    const hz = voice.freq * 2 ** (semitones / 12);
    if (hz === voice.tuned) return;
    voice.tuned = hz;
    voice.setFrequency(hz, this.state);
  }

  /** Re-evaluate every routing for one voice. Sums into the array the voice reads. */
  evaluateModulation(voice, now) {
    const mod = voice.mod;
    mod.fill(0);
    const t = now - voice.startTime;
    for (let r = 0; r < this.routeCount; r++) {
      mod[this.routeTarget[r]] +=
        this.routeSource[r].sample(this.state, t, voice.releasedAt, voice.midi) * this.routeDepth[r];
    }
  }

  /**
   * Geometric, because that is what a pitch travelling at a constant rate is: equal ratios in equal
   * times, which is a straight line in semitones. A linear ramp through Hz would leave most of the
   * journey sounding like the destination.
   */
  glideStep(voice, now) {
    const u = (now - voice.startTime) / voice.glideSeconds;
    if (u >= 1) {
      voice.freq = voice.glideTo;
      voice.glideSeconds = 0;
      return;
    }
    voice.freq = voice.glideFrom * (voice.glideTo / voice.glideFrom) ** u;
  }

  /**
   * One quantum. `out` is written, not added to, so the caller does not have to clear it.
   *
   * `blockStart` is the audio clock at sample 0 of this block - `currentTime` in a processor, and a
   * running count in a test, which is the whole reason it is an argument.
   */
  render(out, frames, blockStart) {
    const sr = this.sampleRate;
    const state = this.state;
    const gain = state.gain ?? 1;

    // Per-quantum, not per-sample: parameters cannot change inside a quantum, since messages are
    // delivered between them, so a voice recomputing its coefficients per sample would be 128 times
    // the work for the same answer.
    for (const voice of this.voices) if (voice.active) voice.prepare?.(state);

    for (let i = 0; i < frames; i++) {
      const now = blockStart + i / sr;
      while (this.events.length && this.events[0].time <= now) {
        const event = this.events.shift();
        if (event.type === 'noteOn') this.allocate(event, now);
        else this.releaseVoice(event.id, now);
      }

      // Its own coarser clock, and `i % MOD_SUBBLOCK` rather than a second loop so that a voice
      // starting mid-block is still evaluated before it is first heard: one allocated at sample 3 is
      // evaluated at sample 8, which is 90µs later.
      const evaluateMod = this.routeCount > 0 && i % MOD_SUBBLOCK === 0;

      let mix = 0;
      for (let v = 0; v < this.voices.length; v++) {
        const voice = this.voices[v];
        if (!voice.active) continue;
        voice.age++;
        if (evaluateMod) {
          this.evaluateModulation(voice, now);
          this.retune(voice);
        }
        if (voice.glideSeconds > 0 && i % MOD_SUBBLOCK === 0) {
          this.glideStep(voice, now);
          this.retune(voice);
        }
        mix += voice.tick(state);
      }

      out[i] = mix * gain;
    }
  }

  /** How many voices are really sounding, which is all an audio thread can honestly report. */
  sounding() {
    let count = 0;
    for (const voice of this.voices) if (voice.active) count++;
    return count;
  }
}
