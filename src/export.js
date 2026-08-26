// The song as a file.
//
// Rendering rather than recording, which is the whole design decision and worth stating because the
// other option looks easier. `MediaRecorder` would capture the live output: no refactor, a dozen
// lines. It also runs at wall-clock speed, so a three-minute song takes three minutes; it glitches
// if the tab is busy, because it is recording a thing that is being computed in real time and a late
// buffer is a hole in the file; and it produces lossy WebM/Opus. An OfflineAudioContext has none of
// those properties - it renders as fast as the machine can go, with no deadline to miss, and the
// samples it produces are the arithmetic rather than a recording of it. The scope has been measuring
// exactly that path since the harness was built, and the numbers it reports are why this is not even
// close: one voice renders at 556x realtime for FM, 333x subtractive, 113x for the hand-written
// worklet, so a whole song is a couple of seconds of work.
//
// What it cost was making two assumptions untrue - that there is one AudioContext (see audio.js and
// engine.js) and that only the transport knows where notes are (see timeline.js). Neither was a
// problem with export. Both were problems already: the scope had been measuring voices that never
// met the mix bus, which is why its peak readout had to be labelled "pre-master".

import { createOutputBus } from './audio.js';
import { chainTailSeconds, createInstrumentPool, tailSecondsFor } from './engine.js';
import { beatsForSeconds, secondsForBeats } from './music-theory.js';
import { glideFor, songNotes } from './timeline.js';
import { fadeShapeOf } from './automation.js';

// A moment of air after the last release finishes, so a file does not end on the exact sample a
// reverb tail would have needed. Nothing here has a reverb yet; this is the cheap half of that.
const TAIL_PAD_S = 0.25;

// One channel, because every instrument here is mono and the mix bus does not pan. A stereo file
// would be two identical channels, twice the size, claiming a width the synth does not have.
const CHANNELS = 1;

// How much of the render one automation curve covers. At automation.js's sample rate this is 7,200
// points, comfortably inside the cap, so a song of any length gets the same resolution as a short one.
const AUTOMATION_CHUNK_S = 30;

/**
 * Render the whole song, once through, into a buffer.
 *
 * Muted parts are absent and repeats are present, because that is what `songNotes` walks and what
 * you heard. The loop button is not consulted: looping is a way of listening, not a property of the
 * song, and a file that repeated until you closed it would be a strange object.
 */
export async function renderSong({ song, bpm, sampleRate = 44100 }) {
  const tracks = song.getTracks();
  const endBeat = song.songEndBeat();
  if (!(endBeat > 0)) return null;

  const bodySeconds = secondsForBeats(endBeat, bpm);
  // How much to leave after the last note starts letting go. An OfflineAudioContext is given its
  // length at construction and cannot grow, so this has to be a guess made in advance - which is
  // why `playNote` hands back the moment each note actually ends, so the guess can be checked
  // against what the notes turned out to say rather than merely trusted.
  // The longest part's own tail, plus whatever the master chain holds on to after that - a reverb on
  // the bus goes on sounding after the last part has finished, so the two are in series.
  const tail =
    Math.max(0, ...tracks.map(tailSecondsFor)) + chainTailSeconds(song.getEffects(null)) + TAIL_PAD_S;
  const frames = Math.ceil((bodySeconds + tail) * sampleRate);

  const offline = new OfflineAudioContext(CHANNELS, frames, sampleRate);
  // The same bus the speakers get, at unity. Unity rather than the volume slider's position because
  // the slider is a monitor control - exporting a quiet file because you happened to be listening
  // quietly would be a surprise, and since the volume sits after the limiter it is the only
  // difference between this chain and the live one.
  // The same bus, with the same master chain - which is in the song, so it travels with it.
  const bus = createOutputBus(offline, { volume: 1, effects: song.getEffects(null) });
  const pool = createInstrumentPool(offline, bus.input);

  // Worklets first. A render finishes faster than a module loads, and rendering before one has
  // arrived produces silence - which the scope once reported as a flawless synth. The bus is in that
  // list now too: the limiter is a worklet, and a file rendered before it loaded would be the mix
  // *without* the one stage that guarantees it fits.
  await Promise.all([pool.prepare(tracks), bus.ready()]);

  let latest = 0;
  let notes = 0;
  for (const { track, note, start, length, slide } of songNotes(song)) {
    const when = secondsForBeats(start, bpm);
    const end = pool.playNote(
      track,
      note.midi,
      when,
      secondsForBeats(length, bpm),
      note.velocity,
      glideFor(slide, bpm),
    );
    // Per note, because the tail depends on which part the note was in: a note into a four-second
    // reverb is still sounding four seconds after the voice has let go. Without this the buffer was
    // long enough and the *trim* below cut the tail off anyway - measured as a 3.4s hall ending
    // abruptly at 0.6s, which is exactly the kind of bug that only a number finds.
    latest = Math.max(latest, end + chainTailSeconds(track.effects));
    notes++;
  }

  // Everything that moves without being played, over the whole buffer.
  //
  // Past the last note as well as under it, which is the point of using the buffer's length rather than
  // the song's: a part fading out has its *tail* faded too, and the tail is what happens after the last
  // note. A fade is a function of song position, so a position past the end simply holds the value the
  // region's edge reached - see `fadeGainAt`.
  //
  // In chunks, because one `setValueCurveAtTime` for a ten-minute song would exceed the point cap and be
  // quietly under-sampled. Chunks abut exactly, which is the one thing an AudioParam insists on.
  const renderSeconds = frames / sampleRate;
  for (let at = 0; at < renderSeconds; at += AUTOMATION_CHUNK_S) {
    const endTime = Math.min(renderSeconds, at + AUTOMATION_CHUNK_S);
    const moving = {
      fromBeat: beatsForSeconds(at, bpm),
      toBeat: beatsForSeconds(endTime, bpm),
      startTime: at,
      endTime,
    };
    pool.scheduleAutomation(tracks, moving, (track) => fadeShapeOf(song, track));
    bus.scheduleAutomation(moving);
  }

  // Everything is now known, and an offline render finishes faster than a message crosses a thread,
  // so an instrument that has to be told before its first sample gets its chance here.
  pool.commit();

  const startedAt = performance.now();
  const buffer = await offline.startRendering();
  const renderMs = performance.now() - startedAt;
  pool.dispose();

  // Trimmed to where the sound actually stopped rather than to the guess. The guess is a ceiling
  // built from the longest release in the song, and most songs do not end on their longest-tailed
  // part, so without this every file would carry a second or two of measured silence.
  // The master chain is in series after all of it, so its tail is added once rather than per note.
  const masterTail = chainTailSeconds(song.getEffects(null));
  const usedFrames = Math.min(
    frames,
    Math.max(1, Math.ceil((latest + masterTail + TAIL_PAD_S) * sampleRate)),
  );

  return {
    buffer,
    usedFrames,
    notes,
    seconds: usedFrames / sampleRate,
    sampleRate,
    renderMs,
    realtime: usedFrames / sampleRate / (renderMs / 1000),
    // True when a note's real ending fell past the end of the buffer, which means the guess above
    // was too small and the file is short of something. Reported rather than silently accepted,
    // because a truncated tail is exactly the kind of thing you would not notice until later.
    truncated: latest + masterTail > frames / sampleRate,
    ...measure(buffer, usedFrames),
  };
}

/** Loudest sample, and how many of them the 16-bit encoding will have to flatten. */
function measure(buffer, frames) {
  let peak = 0;
  let clipped = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i++) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 1) clipped++;
    }
  }
  return { peak, clipped };
}

/**
 * A buffer as a WAV file: 16-bit signed PCM in a RIFF container.
 *
 * Written out rather than reached for, because it is forty lines and the alternative is a
 * dependency and a build step this project does not have. 16-bit because that is what a delivery
 * file is; the render is float and nothing is gained by shipping the extra bits to a listener.
 *
 * Samples over full scale are clamped, and the count of them is reported by `renderSong` instead of
 * being quietly normalised away. Normalising would change the mix on the way out of the door, and
 * "the file is 0.4dB quieter than the mix" is a worse surprise than "your mix clips".
 */
export function encodeWav(buffer, { frames = buffer.length } = {}) {
  const channels = buffer.numberOfChannels;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true); // bytes per second
  view.setUint16(32, channels * bytesPerSample, true); // bytes per frame
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const data = [];
  for (let channel = 0; channel < channels; channel++) data.push(buffer.getChannelData(channel));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]));
      // Asymmetric on purpose: signed 16-bit runs from -32768 to +32767, so scaling both ends by
      // 32768 would wrap the one positive sample that reaches full scale round to the loudest
      // possible negative one - a full-scale click in an otherwise clean file.
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Not before the click has been processed, or the download has nothing to fetch. A frame is
  // enough and leaking the object URL until the tab closes would be the alternative.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/** A song name as a filename: no separators, no surprises, always ends in .wav. */
export function wavFilename(name) {
  const base = String(name ?? '')
    .trim()
    .replace(/[^\w \-().]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  return `${base || 'spiral-synth'}.wav`;
}
