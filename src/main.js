import { createSong } from './song.js';
import { createPianoRoll } from './piano-roll.js';
import { createSpiralPanel } from './spiral-panel.js';
import { createDrumLane } from './drum-lane.js';
import { createTrackRack } from './track-rack.js';
import { createKeyEditor } from './key-editor.js';
import { createTransport } from './transport.js';
import { createOptionsPanel } from './options-panel.js';
import { createAnalysisPanel, createLoadReadout } from './analysis-panel.js';
import { createReferencePanel, installReferenceDrop } from './reference-panel.js';
import { commitReferenceWindow, getReferenceParam, hasReference, subscribeReference } from './reference.js';
import { createSynthPanel } from './synth-panel.js';
import { createFxPanel } from './fx-panel.js';
import { reapInstruments, syncEffects } from './engine.js';
import { installKeyboard } from './keyboard.js';
import { getSetting, onSettingsChange } from './settings.js';
import { createMasterStrip } from './master-strip.js';
import { setMasterEffects } from './audio.js';
import { SNAP_CHOICES } from './music-theory.js';
import {
  RESOLUTION_CHOICES,
  getResolutionId,
  getSnapId,
  setResolutionId,
  setSnapId,
  subscribeGrid,
} from './grid.js';
import { METER_CHOICES, getMeterId, pulseLabel, setMeterId, subscribeMeter } from './meter.js';
import { alignSong } from './edits.js';
import { CHANGE } from './song.js';
import { createSavePanel } from './save-panel.js';
import { buildDemoSong } from './demo-song.js';
import { applyDoc, captureDoc, createAutosaver, readAutosave } from './storage.js';
import { getPxPerWhole, subscribeTimeScale, zoomBy } from './time-scale.js';
import { createTapper, getBpm, setBpm } from './tempo.js';

const song = createSong();
let looping = true;

// --- layout -------------------------------------------------------------------------------

const rackHost = document.getElementById('rack-host');
const rollHost = document.getElementById('roll-host');
const spiralHost = document.getElementById('spiral-host');

const rack = createTrackRack({
  song,
  // A part's level is one of its instrument's own knobs, so moving it in the rack is the same edit
  // the synth panel makes - and has to tell the same three things about it.
  onLevel: () => {
    markDirty();
    synthPanel.refresh();
    analysisPanel.scheduleMeasure();
  },
});
rackHost.appendChild(rack.element);

const roll = createPianoRoll({ song, getBpm });
rollHost.appendChild(roll.element);

const drumLane = createDrumLane({ song });
document.getElementById('lane-host').appendChild(drumLane.element);

const spiral = createSpiralPanel({ song, getBpm });
spiralHost.appendChild(spiral.element);

const keyEditor = createKeyEditor({ song });
document.body.appendChild(keyEditor.element);
roll.onKeyFlag((markerId, flag) => {
  keyEditor.open(markerId, flag.getBoundingClientRect().left);
});

document.getElementById('options-panel').appendChild(createOptionsPanel());

// The voice is looked up at measure time rather than captured, so the scope always shows the part
// you are editing - the same reason the synth panel re-reads it on every track change.
const analysisPanel = createAnalysisPanel({
  getVoice: () => song.activeTrack()?.instrument ?? null,
  getLabel: () => song.activeTrack()?.name,
  // The scope renders the voice on its own, so once a part has effects it is no longer measuring what
  // you hear. Saying which is cheaper than either pretending or rebuilding the harness.
  getChainNote: () => {
    const count = song.activeTrack()?.effects?.length ?? 0;
    return count ? `before ${count} effect${count === 1 ? '' : 's'}` : '';
  },
});
document.getElementById('voice-scope').appendChild(analysisPanel.element);

document.getElementById('load-host').appendChild(createLoadReadout().element);

// --- the recording being transcribed -----------------------------------------------------------

const referencePanel = createReferencePanel({ song, setBpm: (bpm) => showBpm(bpm) });
document.getElementById('reference-panel').appendChild(referencePanel.element);

// A file dropped on the workspace is the gesture people already have, and it is the one that does
// not require finding the menu first.
installReferenceDrop(document.querySelector('.workspace'), { onDropped: () => referenceDropdown.open() });

// The header button carries the state, because the overlay is a layer you turn off and on and the
// panel it is controlled from is shut most of the time. Lit means there is a recording and it is
// on screen; a loaded reference with the overlay hidden reads as unlit, which is the truth.
const referenceBtn = document.getElementById('toggle-reference');
function showReferenceState() {
  const on = hasReference() && getReferenceParam('show') === 'on';
  referenceBtn.classList.toggle('is-on', on);
  referenceBtn.setAttribute('aria-pressed', String(on));
}
subscribeReference(showReferenceState);
showReferenceState();

// --- transport ----------------------------------------------------------------------------

const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const loopBtn = document.getElementById('loop-btn');

const transport = createTransport({
  song,
  getBpm,
  getLooping: () => looping,
  onStateChange: (playing) => {
    playBtn.disabled = playing;
    stopBtn.disabled = !playing;
    document.body.classList.toggle('is-playing', playing);
    // Stopping puts the cursor back where playback began, the way a tape machine returns to
    // the punch-in point: you almost always want to hear the same passage again.
    if (!playing) song.setCursor(transport.getOrigin());
  },
  // The imported recording rides the same windows the notes do, so it cannot drift from them
  // however long the loop runs - see commitReferenceWindow for why almost all of them cost nothing.
  onWindow: commitReferenceWindow,
  onPlayhead: (beat) => {
    roll.setPlayhead(beat);
    if (beat === null) return;
    if (getSetting('followPlayhead') === 'on') {
      song.setCursor(beat);
      roll.revealBeat(beat, 160);
    }
  },
});

playBtn.addEventListener('click', () => transport.start());
stopBtn.addEventListener('click', () => transport.stop());

function setLooping(next) {
  looping = next;
  loopBtn.classList.toggle('is-on', looping);
  loopBtn.setAttribute('aria-pressed', String(looping));
}

loopBtn.addEventListener('click', () => setLooping(!looping));
setLooping(true);

// --- header controls -----------------------------------------------------------------------

const bpmInput = document.getElementById('bpm');
const pulseHint = document.getElementById('pulse-hint');

// BPM stays quarter notes per minute in every meter, because that is the one definition that
// means the same thing everywhere - so the box holds the unambiguous number and this says what
// it amounts to where you are: `1/4. = 66.7` in 6/8, `1/4 = 100` in 4/4.
function showPulse() {
  pulseHint.textContent = pulseLabel(getBpm());
}

// The number is tempo.js's; this is the box and the hint that sit on top of it, plus the one thing
// a tempo change has to do to the audio that a note-by-note push would not: a stopped transport
// pushes nothing, so a synced delay would keep the old interval until the next note.
function showBpm(value) {
  if (!setBpm(value)) return;
  const next = getBpm();
  if (Number(bpmInput.value) !== next) bpmInput.value = String(next);
  showPulse();
  syncEffects(song.getTracks());
  // The tempo is half of where an imported recording sits against the bars - the anchor is the
  // other half - so changing it moves the picture, and moves how many bars the recording covers.
  // Nothing else in the roll depends on the tempo, which is why this goes through the reference's
  // own path rather than redrawing the whole surface.
  roll.refreshReference();
  referencePanel.refresh();
}

bpmInput.addEventListener('input', () => {
  showBpm(bpmInput.value);
  markDirty();
});
showPulse();

// Tapping the tempo in, which is still the most reliable way to find one: it cannot make an octave
// error, it is not confused by a shuffle, and it works on a performance that breathes, where nothing
// automatic will. The arithmetic is tempo.js's - this is the button and the light on it.
const tapper = createTapper();
const tapBtn = document.getElementById('tap-tempo');
let tapTimer = null;

function tap() {
  const result = tapper.tap();
  tapBtn.classList.add('is-on');
  // The series is only open for as long as tempo.js will accept a continuation of it, so the light
  // goes out at the same moment the next tap would start counting again rather than extending.
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => tapBtn.classList.remove('is-on'), 2200);
  if (!result) return;
  // A tap is worth about a tenth of a BPM and no more, so it is rounded to one - unlike the beat
  // detector, which measures over hundreds of beats and earns its two decimal places.
  const bpm = Math.max(20, Math.min(300, Math.round(result.bpm * 10) / 10));
  showBpm(bpm);
  markDirty();
}

tapBtn.addEventListener('click', tap);

// The fader, the mix's own level, and what the limiter is doing about it. It reads the bus rather
// than being told, so it is on screen and calibrated before the first note has created a context.
const masterStrip = createMasterStrip();
document.getElementById('master-host').appendChild(masterStrip.element);

// The meter draws the bars and names the positions; it does not touch a note. Everything that
// follows from it - the lines, the ruler's numbers, the Bar and Beat snaps, the loop's rounding,
// the tempo reading - is read live from meter.js rather than pushed from here.
const meterSelect = document.getElementById('meter');
for (const choice of METER_CHOICES) meterSelect.appendChild(new Option(choice.label, choice.id));
meterSelect.value = getMeterId();
meterSelect.addEventListener('change', () => setMeterId(meterSelect.value));

subscribeMeter(() => {
  meterSelect.value = getMeterId();
  showPulse();
  spiral.refresh();
  markDirty();
});

const snapSelect = document.getElementById('snap');
for (const choice of SNAP_CHOICES) snapSelect.appendChild(new Option(choice.label, choice.id));
snapSelect.value = getSnapId();
snapSelect.addEventListener('change', () => setSnapId(snapSelect.value));

// Resolution is the grid under everything, fine enough to be invisible until you need it -
// which is why it sits next to snap rather than in the options, and why the button that pulls
// existing notes onto it sits right beside the choice.
const resolutionSelect = document.getElementById('resolution');
for (const choice of RESOLUTION_CHOICES) {
  const option = new Option(choice.label, choice.id);
  if (choice.ternary) option.title = 'Divides by three, so triplets land on it exactly';
  resolutionSelect.appendChild(option);
}
resolutionSelect.value = getResolutionId();
resolutionSelect.addEventListener('change', () => setResolutionId(resolutionSelect.value));

// Both controls follow the grid rather than owning it, because a loaded song brings its own snap
// and resolution with it (storage.js) and the header has to agree with what the notes were
// actually quantised against.
subscribeGrid(() => {
  snapSelect.value = getSnapId();
  resolutionSelect.value = getResolutionId();
  spiral.refresh();
  markDirty();
});

document.getElementById('align-song').addEventListener('click', () => {
  alignSong(song);
  spiral.refresh();
});

const zoomValue = document.getElementById('zoom-value');
document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(-1));
subscribeTimeScale(() => {
  zoomValue.textContent = `${getPxPerWhole()} px`;
});
zoomValue.textContent = `${getPxPerWhole()} px`;

document.getElementById('add-track').addEventListener('click', () => {
  const track = song.addTrack();
  song.setActiveTrack(track.id);
});

document.getElementById('add-key').addEventListener('click', () => {
  song.pushUndo();
  const context = song.keyAt(song.getCursor());
  const marker = song.addKeyMarker(song.getCursor(), context.tonicPc, 'major');
  keyEditor.open(marker.id, roll.screenXForBeat(marker.beat));
});

// --- saving ---------------------------------------------------------------------------------
//
// Two layers doing two different jobs. The autosave is the one nobody should have to think about:
// a structural change marks the song dirty and a moment later it is in localStorage, so closing
// the tab stops being an event. The Songs panel on top of that is for having more than one song,
// and for keeping the version you might want back after an hour of changing your mind.

const autosave = createAutosaver(() => captureDoc({ song, bpm: getBpm() }));

function markDirty() {
  autosave.mark();
}

song.subscribe((kind) => {
  // Cursor moves are left out deliberately: with follow-playhead on, playback moves the cursor
  // every frame, and re-serialising the song sixty times a second to record where a line is
  // would be absurd. Where it ended up rides along with the next real change.
  if (kind === CHANGE.NOTES || kind === CHANGE.TRACKS || kind === CHANGE.KEYS) markDirty();
});

// The last thing you did is exactly the thing an autosave has to have, so a pending write is
// forced out on the way off the page instead of being left on its timer.
window.addEventListener('pagehide', () => autosave.flush());

const savePanel = createSavePanel({
  song,
  getBpm,
  setBpm: showBpm,
  onLoaded: () => {
    synthPanel.refresh();
    roll.centerMidi(song.getPitchCursor());
    roll.revealBeat(song.getCursor());
    markDirty();
  },
});
document.getElementById('songs-panel').appendChild(savePanel.element);

// --- panels ---------------------------------------------------------------------------------

// The header wraps, so a dropdown anchored to a button can end up hanging off either edge.
// Anchor right by default, flip to left if that overflows, and as a last resort pin it into
// the viewport relative to its anchor.
function clampPanelToViewport(panel) {
  const margin = 8;
  panel.style.left = 'auto';
  panel.style.right = '0';
  if (panel.getBoundingClientRect().left >= margin) return;

  panel.style.right = 'auto';
  panel.style.left = '0';
  const rect = panel.getBoundingClientRect();
  if (rect.right <= window.innerWidth - margin) return;

  const anchorLeft = panel.offsetParent?.getBoundingClientRect().left ?? 0;
  panel.style.left = `${margin - anchorLeft}px`;
}

/**
 * `alsoWithin` names elements a click may land in without shutting the panel.
 *
 * The voice editor needs it and the others do not. It is about the part you are editing, and the way
 * you change which part that is, is to click one in the rack - which is outside the panel, so it shut
 * it. Comparing two voices meant reopening the panel for each, which is exactly the friction that
 * putting the controls and the scope together was meant to remove.
 */
function wireDropdown(buttonId, panelId, onOpen, alsoWithin = []) {
  const button = document.getElementById(buttonId);
  const panel = document.getElementById(panelId);
  const keepOpen = alsoWithin.map((id) => document.getElementById(id)).filter(Boolean);
  const onDocClick = (event) => {
    if (panel.contains(event.target) || button.contains(event.target)) return;
    if (keepOpen.some((element) => element.contains(event.target))) return;
    close();
  };
  function close() {
    panel.hidden = true;
    document.removeEventListener('click', onDocClick);
  }
  // Before the clamp, not after: a panel whose contents are filled in on open has no size to
  // measure until that has happened.
  function open() {
    onOpen?.();
    panel.hidden = false;
    clampPanelToViewport(panel);
    document.addEventListener('click', onDocClick);
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel.hidden) open();
    else close();
  });
  return { open, close };
}

const songsDropdown = wireDropdown('toggle-songs', 'songs-panel', () => savePanel.refresh());
const referenceDropdown = wireDropdown('toggle-reference', 'reference-panel', () => referencePanel.refresh());
wireDropdown('toggle-keys', 'keys-panel');
wireDropdown('toggle-options', 'options-panel');
// Stays open while you pick a different part, for the same reason the synth panel does: comparing two
// parts' chains means switching between them, and shutting on the click that changed the subject made
// that a chore.
wireDropdown('toggle-fx', 'fx-panel', () => fxPanel.refresh(), ['rack-host']);
// One panel holds the controls and the scope. Both are refreshed on open: the synth panel because
// the active part may have changed, the scope because its canvas is drawn rather than laid out and
// because opening it is what lets it measure - `offsetParent` is null until it is really on screen.
wireDropdown(
  'toggle-synth',
  'synth-panel',
  () => {
    synthPanel.refresh();
    analysisPanel.refresh();
  },
  // Stays open while you pick a different part. Both halves follow the active part, so this is how
  // you compare two voices - and shutting on the click that changed the subject made that a chore.
  ['rack-host'],
);

// --- synth panel ------------------------------------------------------------------------------

// Built from the active instrument's own parameter declarations (see instruments.js), so a new
// knob or a new instrument needs no edit here.
const synthPanel = createSynthPanel({
  song,
  onChange: (key) => {
    // A voice is written straight into the track object rather than through the song's setters,
    // so nothing has emitted a change and the autosave has to be told by hand.
    markDirty();
    // The rack shows the part's voice beside its name and its level beside that, so both of those
    // keys have a second place on screen that has to agree.
    if (key === 'waveform' || key === 'gain') rack.refresh();
    // And the scope is now sitting next to the control that just moved, so it measures again. It
    // does its own debouncing and declines when it cannot be seen - the panel only has to say that
    // something changed, not decide whether that is worth a render.
    analysisPanel.scheduleMeasure();
  },
});
document.getElementById('voice-controls').appendChild(synthPanel.element);

// A removed part's instrument is still holding audio nodes until something says otherwise, and an
// undo can remove several at once - so this reconciles against the list rather than being told.
song.subscribe((kind) => {
  if (kind !== CHANGE.TRACKS) return;
  reapInstruments(song.getTracks());
  // An undo or a load replaces every chain at once and says only that the tracks changed, so this is
  // where the live audio graph is reconciled against whatever the song now says.
  pushEffects();
  // Switching parts in the rack changes what the panel beside it is about, and the scope names the
  // part in its heading - so it retargets too. It measures nothing while shut.
  analysisPanel.refresh();
});

// --- effects ------------------------------------------------------------------------------------
//
// Two chains: the active part's, and the master's. Both are in the song, so both are saved and both
// come back with an undo - which is why the panel edits through song.js for anything structural and
// writes knobs straight into the live state, exactly like the synth panel.

const fxPanel = createFxPanel({
  song,
  onChange: () => {
    markDirty();
    // Pushed at the audio thread immediately rather than at the next note. Playback pushes state per
    // note, so during a song this happens anyway; with the transport stopped, or between two notes of
    // a held chord, nothing else would carry the change across - and turning a filter while a reverb
    // tail rings is exactly when you are listening hardest.
    pushEffects();
    // The rack shows how many effects a part has, so it has to hear about this too.
    rack.refresh();
  },
});
document.getElementById('fx-panel').appendChild(fxPanel.element);

function pushEffects() {
  syncEffects(song.getTracks());
  setMasterEffects(song.getEffects(null));
}

// --- settings ---------------------------------------------------------------------------------

function applySpiralSize() {
  document.body.dataset.spiralSize = getSetting('spiralSize');
}

onSettingsChange((key) => {
  if (key === 'spiralSize') applySpiralSize();
  spiral.refresh();
  roll.refresh();
  keyEditor.refresh();
});
applySpiralSize();

// --- keyboard -----------------------------------------------------------------------------------

installKeyboard({
  song,
  transport,
  roll,
  getBpm,
  onToggleLoop: () => setLooping(!looping),
  onTap: tap,
  // Opened rather than saved silently: the panel is where the confirmation lands, and a save
  // you cannot see happen is one you go on pressing.
  onSave: () => {
    songsDropdown.open();
    savePanel.quickSave();
  },
});

// The session you left, if there is one. The demo is what an empty browser gets, and also what a
// save too old to read gets - `applyDoc` changes nothing at all when it fails, so there is never
// a half-loaded song to clear up before falling back to it.
if (!applyDoc(readAutosave(), { song, setBpm })) buildDemoSong(song);

// Both panels that read a part's *instrument* rather than its notes have to be told by hand here.
// Loading a document replaces the tracks and emits a change, so that path refreshes itself; building
// the demo does not, because the last thing it does is write levels straight into instrument state
// and a direct state write emits nothing. Without this the rack's faders showed the instrument
// defaults - 80% - while the parts really were playing at the levels the demo had set.
rack.refresh();
synthPanel.refresh();
fxPanel.refresh();
roll.centerMidi(song.getPitchCursor());
roll.revealBeat(song.getCursor());
playBtn.disabled = false;
stopBtn.disabled = true;
