import { createListeners } from './observable.js';
// Behavioural options that are still open questions for this prototype - the point is to be
// able to flip them mid-session and judge which reading of the notation actually works, so
// each one is a live setting rather than a decision baked into the code.
//
// Values are plain strings so the options panel can be generated straight from SETTING_DEFS.
//
// Two settings from the step-sequencer version are gone rather than moved. `keyChangeMode`
// asked whether a key change should drag notes with it or leave their pitches alone; a note
// here *is* a pitch, held in absolute midi, so there is nothing left for a key change to move
// and the question no longer exists. `loopMode` asked what a short track does while a longer
// one is still running; tracks no longer have their own lengths, only the song does, so the
// answer is always "together".

const settings = {
  keyboardStyle: 'piano',
  colorMode: 'pitch-class',
  ghostNotes: 'on',
  angleGuides: 'on',
  followPlayhead: 'on',
  spiralSize: 'medium',
};

const { subscribe: onSettingsChange, emit } = createListeners();
export { onSettingsChange };

export const SETTING_DEFS = [
  {
    key: 'keyboardStyle',
    label: 'Pitch axis',
    help: 'How the gutter down the left of the roll draws pitch.',
    options: [
      {
        value: 'piano',
        label: 'Piano',
        help: 'A keyboard. Its whole job is done by shape - the black keys make an irregular 2-3 pattern you read position from without counting - but it says pitch class as a physical object, which is a different language from the one the spiral speaks.',
      },
      {
        value: 'rainbow',
        label: 'Rainbow',
        help: 'One hue per semitone, the same hue the note has in the roll and the slot has on the spiral, so a pitch class is one colour everywhere. Under a key, in-scale rows keep their colour, the rest fall back and the tonic is marked - the spiral\'s three tiers applied to the roll. You lose the black-key landmark, so the octave lines and the C labels are doing all the orienting.',
      },
    ],
  },
  {
    key: 'colorMode',
    label: 'Colour by',
    help: 'Only differs once a key is in force - unkeyed, slot and pitch coincide.',
    options: [
      {
        value: 'pitch-class',
        label: 'Pitch',
        help: 'A pitch keeps its colour everywhere, so transposing visibly rotates the palette. This is also the reading the piano roll uses, so a note is the same colour in both halves of the screen.',
      },
      {
        value: 'slot',
        label: 'Position',
        help: 'A slot keeps its colour everywhere, so the palette never moves on the spiral and colour tracks scale degree instead.',
      },
    ],
  },
  {
    key: 'ghostNotes',
    label: 'Ghost notes',
    help: 'Faint dots on the spiral for pitches sounding at the cursor in the tracks you are not editing, so a chord can be read against the part underneath it.',
    options: [
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  },
  {
    key: 'angleGuides',
    label: 'Angle guides',
    help: 'Hairlines from the centre of the spiral out through every angle that has a note on it.',
    options: [
      {
        value: 'on',
        label: 'On',
        help: 'Angle is pitch class, so the lines draw the chord\'s shape on its own - octaves collapsed, a pitch lit on two turns still counting once - which is what makes the same chord rooted somewhere else recognisable as the same figure, just rotated.',
      },
      { value: 'off', label: 'Off' },
    ],
  },
  {
    key: 'followPlayhead',
    label: 'Follow playhead',
    help: 'Whether the cursor rides the playhead during playback, which turns the spiral into a live read-out of what is sounding.',
    options: [
      { value: 'on', label: 'On' },
      {
        value: 'off',
        label: 'Off',
        help: 'The cursor stays where you left it, so you can keep editing one moment while the song runs past it.',
      },
    ],
  },
  {
    key: 'spiralSize',
    label: 'Spiral size',
    help: 'How much of the window the spiral takes, and therefore how much is left for the roll. The spiral is drawn in relative units, so this is a rescale rather than a second set of geometry.',
    options: [
      { value: 'small', label: 'S', help: 'Most room for the roll.' },
      { value: 'medium', label: 'M' },
      { value: 'large', label: 'L', help: 'Roomiest slots, easiest to aim at the inner turn.' },
    ],
  },
];

export function getSetting(key) {
  return settings[key];
}

export function setSetting(key, value) {
  if (!(key in settings) || settings[key] === value) return;
  settings[key] = value;
  emit(key, value);
}

