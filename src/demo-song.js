// The song a new browser opens with.
//
// It was inside main.js, which was the natural place for it right up until the mix bus grew a limiter
// and a meter. Then it stopped being wiring and became a *fixture*: the one song this project can
// measure without a human having written anything, so "what does the demo peak at, and how much is
// the limiter having to take off it" is a question with an answer. A fixture that can only be reached
// by booting the whole app is a fixture that gets checked by eye, and this project's whole method is
// the opposite of that.
//
// Two bars of two parts, chosen so the first thing on screen shows what the arrangement is for:
// the chords are halves and the bass is eighths, so the length a new note gets depends on which
// part you are in and where the cursor is - which is the rule the whole editing model turns on.

export function buildDemoSong(song) {
  // The progression below is a I-vi-IV-V in C, so say so. Without a marker the spiral draws no
  // scale shading at all - which is the honest reading of a song with no key, and a poor first
  // screen, because the tiering that makes a chord readable on the spiral is exactly what is
  // missing. Starting keyed means the first thing you see is the notation doing its job.
  song.addKeyMarker(0, 0, 'major');

  const chords = song.addTrack('Chords');
  const bass = song.addTrack('Bass');
  const drums = song.addTrack('Drums');
  song.setInstrument(drums.id, 'drums');

  const HALF = 1 / 2;
  const EIGHTH = 1 / 8;
  const SIXTEENTH = 1 / 16;

  for (const [start, midis] of [
    [0, [60, 64, 67]],
    [0.5, [57, 60, 64]],
    [1, [53, 57, 60]],
    [1.5, [55, 59, 62]],
  ]) {
    for (const midi of midis) song.addNote(chords.id, { midi, start, length: HALF });
  }

  for (const [start, midi] of [
    [0, 48],
    [0.25, 48],
    [0.5, 45],
    [0.75, 45],
    [1, 41],
    [1.25, 41],
    [1.5, 43],
    [1.75, 43],
  ]) {
    song.addNote(bass.id, { midi, start, length: EIGHTH });
  }

  // Two bars of a beat, written in sixteenths.
  //
  // The velocities are the point of it. Every hit at full is what a drum machine sounds like when
  // nobody has touched it, and it is the first thing that makes programmed drums sound programmed -
  // so the backbeat is accented, the off-beat hats sit under the on-beat ones, and there are two
  // ghost snares doing what a drummer's left hand does between them. It is also the only part of
  // the demo that shows what the step lane is for.
  const KICK = 36;
  const SNARE = 38;
  const HAT = 42;
  const OPEN_HAT = 46;
  const beat = [
    // [drum, step, velocity] over 32 sixteenths
    ...[0, 6, 10, 16, 22, 27].map((step) => [KICK, step, step % 16 === 0 ? 1 : 0.8]),
    ...[4, 12, 20, 28].map((step) => [SNARE, step, 0.95]),
    ...[7, 23].map((step) => [SNARE, step, 0.3]),
    ...[0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 28].map((step) => [HAT, step, step % 4 === 0 ? 0.8 : 0.45]),
    [OPEN_HAT, 14, 0.7],
    [OPEN_HAT, 30, 0.7],
  ];
  for (const [midi, step, velocity] of beat) {
    song.addNote(drums.id, { midi, start: step * SIXTEENTH, length: SIXTEENTH, velocity });
  }

  // --- the arrangement -------------------------------------------------------------------------
  //
  // Two bars of material per part, and then an eight-bar song built out of *when each part plays*
  // rather than out of more notes. This is the whole point of a region: the parts enter one at a
  // time, which is a transition, and none of it needed a single note to be duplicated.
  //
  // The drums stop three quarters of the way through the last bar rather than at the end of it, and
  // that is deliberate - it drops the kit out for the final beat, and it is the thing a whole number
  // of passes could never express. A count can only say "four times"; a span can say "until here".
  const BAR = 1;
  song.setTrackRegion(chords.id, { begin: 0, end: 8 * BAR });
  song.setTrackRegion(bass.id, { begin: 2 * BAR, end: 8 * BAR });
  song.setTrackRegion(drums.id, { begin: 4 * BAR, end: 7.75 * BAR });

  // --- gain staging, measured -------------------------------------------------------------------
  //
  // Two decibel figures and one about the kit, and they are the reason the whole demo exists in a
  // file of its own: they were chosen by rendering this song and reading the numbers off it.
  //
  // At the instruments' default levels these three parts summed to a peak of 3.44 - eleven decibels
  // over full scale. The bus limiter catches every bit of that and puts the file out at exactly
  // -1.00dBFS with nothing clipped, which is precisely the problem: a limiter taking twelve decibels
  // off is not protecting a mix, it *is* the mix, and the first song anybody sees should not be an
  // argument for that. Set here, the three parts sum to 1.367 (+2.7dBFS), the limiter takes 3.72dB
  // at the loudest transient, and the reduction bar in the header moves without pinning. Switching
  // the ceiling to Off is then a real A/B rather than a way to make the demo unlistenable - off, the
  // same render puts 727 samples over full scale.
  //
  // The numbers are readable now, which they were not before: -9dB on each of the tonal parts and
  // -15dB on the kit. Until the instruments' outputs were calibrated against each other, 0.35 on one
  // and 0.35 on another meant two different loudnesses (see OUTPUT_TRIM in any instrument), so these
  // could only ever be arbitrary constants that happened to work.
  chords.instrument.state.gain = 0.35;
  bass.instrument.state.gain = 0.35;
  drums.instrument.state.gain = 0.18;

  song.setActiveTrack(chords.id);
  song.setCursor(0);
  song.setPitchCursor(60);
}
