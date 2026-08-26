// The Songs panel: name a song, keep it, bring it back.
//
// The autosave underneath this (see storage.js) already means nothing is ever lost by closing the
// tab, so what this panel is actually for is the other thing - having more than one song, and
// being able to try something reckless knowing the version you liked is still on the shelf. That
// is why loading is one click and deleting takes two: one of them is undoable and the other is
// the only permanent thing in the app.

import {
  MAX_NAME,
  applyDoc,
  captureDoc,
  cleanName,
  deleteSave,
  listSaves,
  readSave,
  writeSave,
} from './storage.js';
import { encodeWav, renderSong, saveBlob, wavFilename } from './export.js';

const dbfs = (peak) => (peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : 'silent');

/**
 * What the render turned out to be, in the order you would want to be told it.
 *
 * The two warnings come first and say what to do, because both of them mean the file is not the mix
 * and neither is something the exporter can put right on its own. Clipping in particular is worth
 * being blunt about: the monitor volume used to hide it - it sat before the bus stage, so listening
 * quietly meant the peaks never got near full scale - and a render at unity is the first thing here
 * that has ever had to face the mix at its real level.
 */
function describeRender(result) {
  const parts = [
    `${result.seconds.toFixed(1)}s`,
    `${result.notes} note${result.notes === 1 ? '' : 's'}`,
    `peak ${dbfs(result.peak)}`,
    `${Math.round(result.realtime)}× realtime`,
  ];
  if (result.clipped > 0) {
    parts.unshift(
      `over full scale on ${result.clipped} sample${result.clipped === 1 ? '' : 's'} - turn a part's Level down`,
    );
  }
  if (result.truncated) parts.unshift('tail cut short - a part rings for longer than it declares');
  return parts.join(' · ');
}

function agoLabel(timestamp) {
  if (!timestamp) return 'unknown';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function countLabel(save) {
  if (!save.readable) return 'unreadable';
  const parts = `${save.tracks} part${save.tracks === 1 ? '' : 's'}`;
  return `${parts} · ${save.notes} note${save.notes === 1 ? '' : 's'}`;
}

export function createSavePanel({ song, getBpm, setBpm, onLoaded }) {
  const element = document.createElement('div');
  element.className = 'save-panel';

  const heading = document.createElement('h3');
  heading.textContent = 'Kept in this browser';

  const form = document.createElement('div');
  form.className = 'save-form';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Name this song';
  nameInput.maxLength = MAX_NAME;

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn--primary';

  form.append(nameInput, saveBtn);

  const list = document.createElement('div');
  list.className = 'save-list';

  const exportRow = document.createElement('div');
  exportRow.className = 'save-export';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn btn--ghost';
  exportBtn.textContent = 'Export WAV';
  const exportNote = document.createElement('span');
  exportNote.className = 'save-export__note';
  exportRow.append(exportBtn, exportNote);

  const status = document.createElement('p');
  status.className = 'save-status';

  const note = document.createElement('p');
  note.className = 'dropdown-panel__note';
  note.textContent =
    'Whatever you are working on is kept as you go and comes back when you reopen the page, so this is only for keeping more than one song. Loading replaces what is on screen, but it is one ⌘Z away. Deleting is not.';

  element.append(heading, form, list, exportRow, status, note);

  // The name the song is currently going under, so ⌘S means "save this again" rather than
  // "invent a name". Set by saving and by loading, since after a load that is the song you have.
  let currentName = '';
  let pendingDelete = null;
  let statusTimer = null;
  let exporting = false;

  // A render's result is several numbers and worth reading, so it gets longer on screen than
  // "Saved" does.
  function say(text, holdMs = 2600) {
    status.textContent = text;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = '';
      statusTimer = null;
    }, holdMs);
  }

  function saveAs(name) {
    const key = cleanName(name);
    if (!key) {
      nameInput.focus();
      say('Give it a name first.');
      return false;
    }
    const ok = writeSave(key, captureDoc({ song, bpm: getBpm() }));
    currentName = ok ? key : currentName;
    say(ok ? `Saved “${key}”.` : 'Could not save - this browser is not letting the page store anything.');
    render();
    return ok;
  }

  function load(name) {
    const doc = readSave(name);
    if (!applyDoc(doc, { song, setBpm })) {
      say(`“${name}” could not be read.`);
      return;
    }
    currentName = name;
    say(`Loaded “${name}”.`);
    render();
    onLoaded?.();
  }

  /**
   * Render the song and hand it over as a file.
   *
   * Nothing here needs the live AudioContext, so this works on a page where you have not played a
   * note yet - an OfflineAudioContext is not subject to the gesture rule, because it is not going
   * to make a sound.
   */
  async function exportWav() {
    if (exporting) return;
    if (!(song.songEndBeat() > 0)) {
      say('Nothing to export yet - write some notes first.');
      return;
    }
    exporting = true;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Rendering...';
    say('Rendering the whole song offline...', 60000);
    try {
      const result = await renderSong({ song, bpm: getBpm() });
      if (!result) {
        say('Nothing to export yet - write some notes first.');
        return;
      }
      saveBlob(encodeWav(result.buffer, { frames: result.usedFrames }), wavFilename(currentName));
      say(describeRender(result), 12000);
    } catch (error) {
      // Rendering touches the audio engine, worklet loading and a file download, and any of the
      // three can fail in a way this panel cannot fix. Saying which is more use than a spinner
      // that stops.
      say(`Could not render: ${error?.message ?? error}`, 8000);
    } finally {
      exporting = false;
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export WAV';
      render();
    }
  }

  exportBtn.addEventListener('click', exportWav);

  function renderRow(save) {
    const row = document.createElement('div');
    row.className = 'save-row';
    if (save.name === currentName) row.classList.add('save-row--current');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'save-row__open';
    open.disabled = !save.readable;
    open.title = save.readable ? `Load “${save.name}”` : 'Nothing readable left in this one';

    const name = document.createElement('span');
    name.className = 'save-row__name';
    name.textContent = save.name;

    const meta = document.createElement('span');
    meta.className = 'save-row__meta';
    meta.textContent = `${countLabel(save)} · ${agoLabel(save.savedAt)}`;

    open.append(name, meta);
    open.addEventListener('click', () => load(save.name));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'save-row__delete';
    const armed = pendingDelete === save.name;
    remove.textContent = armed ? 'sure?' : '×';
    remove.title = armed ? 'Click again to delete for good' : `Delete “${save.name}”`;
    if (armed) remove.classList.add('is-armed');
    // Two clicks, because this is the one action in the app that undo cannot reach. A dialog
    // would say it louder, but it would also say it every single time.
    remove.addEventListener('click', () => {
      if (!armed) {
        pendingDelete = save.name;
        render();
        return;
      }
      deleteSave(save.name);
      if (currentName === save.name) currentName = '';
      pendingDelete = null;
      say(`Deleted “${save.name}”.`);
      render();
    });

    row.append(open, remove);
    return row;
  }

  function render() {
    const saves = listSaves();
    if (pendingDelete && !saves.some((s) => s.name === pendingDelete)) pendingDelete = null;

    list.replaceChildren();
    if (!saves.length) {
      const empty = document.createElement('p');
      empty.className = 'save-empty';
      empty.textContent = 'Nothing saved yet.';
      list.appendChild(empty);
    } else {
      for (const save of saves) list.appendChild(renderRow(save));
    }

    // Typing a name something already has is how you overwrite it, so the button says so before
    // you press it rather than after.
    const typed = cleanName(nameInput.value);
    const clashes = saves.some((s) => s.name === typed);
    saveBtn.textContent = typed && clashes ? 'Replace' : 'Save';
    saveBtn.title = typed && clashes ? `Overwrite “${typed}”` : 'Keep this song under that name';

    const empty = !(song.songEndBeat() > 0);
    const muted = song.getTracks().filter((track) => track.muted).length;
    exportBtn.disabled = exporting || empty;
    exportBtn.title = empty ? 'Write some notes first' : `Render the song to ${wavFilename(currentName)}`;
    // The muted count is here because "where did that part go" is the question a file provokes, and
    // it is much better answered before the render than after it.
    exportNote.textContent = empty
      ? 'nothing to render yet'
      : ['mono 16-bit 44.1kHz', muted ? `${muted} muted part${muted === 1 ? '' : 's'} left out` : null]
          .filter(Boolean)
          .join(' · ');
  }

  nameInput.addEventListener('input', render);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveAs(nameInput.value);
  });
  saveBtn.addEventListener('click', () => saveAs(nameInput.value));

  render();

  return {
    element,

    /** Called when the panel opens: the list may be stale, and the name field should be primed. */
    refresh() {
      pendingDelete = null;
      if (currentName) nameInput.value = currentName;
      render();
    },

    /** ⌘S. A song that already has a name just gets saved again; a new one has to be named. */
    quickSave() {
      if (currentName) return saveAs(currentName);
      nameInput.focus();
      nameInput.select();
      say('Name it, then press Enter.');
      return false;
    },

    setCurrentName(name) {
      currentName = cleanName(name);
      render();
    },
  };
}
