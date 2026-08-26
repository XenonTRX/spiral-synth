// The end of the signal path, on screen: how loudly you are listening, how loud the mix is, and what
// the limiter is having to do about it.
//
// What was here before was one unlabelled range input. It worked, and it was three separate lies of
// omission. It was linear in *amplitude*, so the top half of its travel covered 6dB and the bottom
// half covered everything else - a control whose useful range is a third of an inch at one end. It
// had no readout, so "a bit quieter" was the only thing it could express and no number could be
// written down or repeated. And it was the only thing on screen about level at all, so a mix 11dB
// over full scale looked exactly like a mix that fit, right up until the exported file said
// otherwise. That last one is the real cost, and it is why this is a meter first and a fader second.
//
// The three readings are deliberately different quantities:
//
//   - **the fader** is monitoring, and changes nothing about the mix or the file;
//   - **the VU meter** is the mix, taken after the limiter and before the fader, so it does not move
//     when you turn the volume down. It reads *average* level, which is the useful thing to read
//     here: with a limiter on, the peak is pinned to the ceiling by construction and tells you
//     nothing at all, while the average moves with the music;
//   - **the reduction bar** is the limiter working, which is the one number that says the mix is too
//     hot rather than that the room is too loud.

import {
  getLimiterParams,
  getMasterVolume,
  peekContext,
  setLimiterParams,
  setMasterVolume,
  subscribeMasterMeter,
} from './audio.js';
import { dbLabel, dbToGain, gainToDb } from './decibels.js';
import { readPref, writePref } from './storage.js';
import { cssVar } from './theme.js';

// Where the fader bottoms out before it becomes silence. A monitor control needs a floor rather than
// a true zero with a taper: -60dB is inaudible on any system, and the alternative - carrying on down
// to -infinity - spends travel on differences nobody can hear.
const MONITOR_FLOOR_DB = -60;
const FADER_STEPS = 240;

/**
 * What "0 VU" means here, in dBFS.
 *
 * A VU meter's zero is a reference level, not a maximum, and in the analogue world it is +4dBu on a
 * line - a voltage, which a file does not have. So the alignment is a convention and the honest thing
 * is to name which one: this is K-12, 0 VU at -12dBFS, the member of the K-system meant for dense loud
 * material. A synth mix through a brickwall limiter is exactly that.
 *
 * **It was K-14, and that was chosen against the wrong quantity.** I justified -14 with the demo song's
 * whole-song average of -16.5dBFS, which put the needle at about -2 VU. But a VU with 300ms ballistics
 * does not read a whole-song average; it reaches the level of the loudest 300ms, and for the same song
 * that is -11.9dBFS - 4.6dB louder. So the needle actually sat at +2.1 VU on the deliberately staged
 * reference mix, which is the top of the scale, and it pegged on anything busier. Measuring the right
 * window puts the demo's loudest passage at +0.1 VU and its average at -4.5, which is what a VU is
 * supposed to do: sit a few dB below zero and touch it on the peaks.
 *
 * The broadcast alignments would be much worse, not better: EBU's -18 and SMPTE's -20 assume programme
 * material far less dense than this, and would peg the needle by six to eight decibels.
 */
const ZERO_VU_DBFS = -12;

/**
 * The ballistics, which is the whole of what makes this a VU rather than a bar with a slow decay.
 *
 * The standard is specific: a steady tone applied suddenly brings the needle to 99% of its reading in
 * 300ms, with no more than 1.5% overshoot, and the fall is the same shape as the rise. Two cascaded
 * one-poles give exactly that character - symmetric, and critically damped so there is no overshoot
 * at all - and a critically damped second-order step reaches 99% at 6.64 time constants, so 300ms of
 * rise wants 45.2ms per pole. Verified numerically rather than trusted; see the README.
 *
 * The important consequence is that a VU cannot see a transient, and is not meant to. A kick drum
 * moves it barely at all. That is why the reduction reading beside it is not redundant: one says how
 * loud the music is, the other says what the peaks are doing.
 */
const VU_POLE_TAU_S = 0.0452;

/**
 * Where 0 VU sits along the sweep, as a fraction of full deflection.
 *
 * A real VU's needle deflects with the *voltage* it is fed, not with its logarithm, so the face is
 * crowded at the bottom and open at the top - which is not a decorative quirk, it is why the meter is
 * legible exactly in the last few decibels where mixing decisions are made. Drawing it linearly in dB
 * would be a different instrument wearing a VU's clothes. 0.708 puts full deflection at +3 VU, which
 * is where a VU face ends.
 */
const ZERO_VU_DEFLECTION = 0.708;

// The face, in VU. Crowded at the bottom, as above.
const VU_TICKS = [-20, -10, -7, -5, -3, 0, 3];

// The sweep, in degrees either side of straight up.
const VU_SWEEP_DEG = 32;

// How far outside the scale the reduction arc is drawn, in pixels.
const REDUCTION_OFFSET = 11;

// Reduction still falls on its own, because the limiter reports the extreme since the last message
// rather than a continuous value - so without this the bar would flicker rather than move.
const REDUCTION_FALL_DB_PER_S = 14;

const CEILING_CHOICES = [
  { value: 'off', label: 'Off', title: 'No limiter. The mix goes to the speakers and to the file exactly as the parts sum, which is the honest A/B — and which this project measured at +11dBFS with 9,771 samples over full scale.' },
  { value: '-0.3', label: '−0.3 dB', title: 'As close to full scale as is sensible. Leaves nothing for inter-sample peaks, which a sample-peak limiter cannot see.' },
  { value: '-1', label: '−1 dB', title: 'A dB of air below full scale — enough for the smoothing residue and for peaks that land between two samples.' },
  { value: '-3', label: '−3 dB', title: 'Quiet delivery, and useful while mixing: the more headroom the ceiling leaves, the sooner the reduction bar tells you a part is too loud.' },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Fader position to gain. dB-linear, because that is the scale the ear reads level on. */
function gainForPosition(position) {
  if (position <= 0) return 0;
  return dbToGain(MONITOR_FLOOR_DB * (1 - clamp01(position)));
}

function positionForGain(gain) {
  if (!(gain > 0)) return 0;
  return clamp01(1 - gainToDb(gain) / MONITOR_FLOOR_DB);
}

export function createMasterStrip() {
  const element = document.createElement('div');
  element.className = 'master';

  const label = document.createElement('span');
  label.className = 'control__label';
  const labelText = document.createElement('span');
  labelText.textContent = 'Master';
  const volumeReadout = document.createElement('em');
  volumeReadout.className = 'control__hint';
  const reductionReadout = document.createElement('em');
  reductionReadout.className = 'master__reduction';
  // Blank unless something got past the ceiling, which with the limiter on it never does. It is the
  // one thing the VU cannot say: a needle with 300ms of ballistics is nearly deaf to a single sample.
  const overReadout = document.createElement('em');
  overReadout.className = 'master__over';
  label.append(labelText, volumeReadout, reductionReadout, overReadout);

  const row = document.createElement('div');
  row.className = 'master__row';

  const canvas = document.createElement('canvas');
  canvas.className = 'master__meter';
  canvas.title = 'A VU meter on the mix, taken after the limiter and before the volume, so it does not move with the fader. Proper ballistics — 300ms to 99% of a reading — with 0 VU at −14 dBFS, so it says how loud the music is and is deliberately deaf to transients. The arc outside the face is how much the limiter is taking off. Click to clear a clip.';

  const fader = document.createElement('input');
  fader.type = 'range';
  fader.className = 'master__fader';
  fader.min = '0';
  fader.max = '1';
  fader.step = String(1 / FADER_STEPS);
  fader.title = 'How loudly you are listening. It sits after the limiter, so it changes nothing about the mix and nothing about an exported file.';

  const ceiling = document.createElement('select');
  ceiling.className = 'master__ceiling';
  for (const choice of CEILING_CHOICES) {
    const option = new Option(choice.label, choice.value);
    option.title = choice.title;
    ceiling.appendChild(option);
  }

  // Stacked beside the meter, so a taller face does not cost the header a third row.
  const controls = document.createElement('div');
  controls.className = 'master__controls';
  controls.append(fader, ceiling);
  row.append(canvas, controls);
  element.append(label, row);

  // --- the fader ---------------------------------------------------------------------------------

  function showVolume(gain) {
    volumeReadout.textContent = gain > 0 ? dbLabel(gainToDb(gain)) : 'silent';
  }

  // `typeof` before any arithmetic, because `Number(null)` is 0 and `Number.isFinite(0)` is true - so
  // the obvious version of this reads "nothing saved" as "saved at silence" and the app opens mute.
  // Which is exactly what it did, and it is the second time this project has been caught by that
  // particular pair: the same two lines read an unset region end as a pinned end of zero and dropped
  // every note in the part. A stored number is a number; anything else is nothing stored.
  const savedVolume = readPref('volume');
  const startVolume =
    typeof savedVolume === 'number' && savedVolume >= 0 && savedVolume <= 1
      ? savedVolume
      : getMasterVolume();
  setMasterVolume(startVolume);
  fader.value = String(positionForGain(startVolume));
  showVolume(startVolume);

  fader.addEventListener('input', () => {
    const gain = gainForPosition(Number(fader.value));
    setMasterVolume(gain);
    showVolume(gain);
    writePref('volume', gain);
  });

  // --- the limiter's one control -----------------------------------------------------------------
  //
  // On/off and the ceiling are one widget because they are one question - what is the mix allowed to
  // reach - and because a bypass switch next to a threshold invites the reading that the two are
  // independent settings you could get into a contradictory state.

  function applyCeiling(value, { save = true } = {}) {
    if (value === 'off') setLimiterParams({ enabled: false });
    else setLimiterParams({ enabled: true, ceilingDb: Number(value) });
    if (save) writePref('limiter', value);
  }

  const savedCeiling = readPref('limiter');
  const startCeiling = CEILING_CHOICES.some((c) => c.value === savedCeiling)
    ? savedCeiling
    : String(getLimiterParams().ceilingDb);
  ceiling.value = CEILING_CHOICES.some((c) => c.value === startCeiling) ? startCeiling : '-1';
  applyCeiling(ceiling.value, { save: false });

  ceiling.addEventListener('change', () => applyCeiling(ceiling.value));

  // --- the meter ---------------------------------------------------------------------------------

  // The needle's position is an amplitude rather than a level in dB, because that is what a
  // moving-coil movement responds to - see ZERO_VU_DEFLECTION. Two poles cascaded, hence two of them.
  let vuFirstPole = 0;
  let vuAmplitude = 0;
  let reductionDb = 0;
  let overDb = null;
  let clipped = false;
  let lastReport = 0;
  let sounding = false;

  canvas.addEventListener('click', () => {
    clipped = false;
    overDb = null;
    draw();
  });

  const unsubscribe = subscribeMasterMeter((data) => {
    const now = performance.now();
    // Clamped, because a tab that was in the background hands back a gap of seconds, and a gap of
    // seconds through this filter is a needle that teleports.
    const elapsed = lastReport ? Math.min(0.5, (now - lastReport) / 1000) : 0;
    lastReport = now;
    sounding = true;

    const coefficient = elapsed > 0 ? 1 - Math.exp(-elapsed / VU_POLE_TAU_S) : 1;
    vuFirstPole += (data.rms - vuFirstPole) * coefficient;
    vuAmplitude += (vuFirstPole - vuAmplitude) * coefficient;

    // Reported as the lowest gain reached since the last message, so it is already the extreme over
    // that window and only needs somewhere to fall back to.
    const reduction = -gainToDb(data.gainFloor);
    reductionDb = Math.max(reduction, reductionDb - REDUCTION_FALL_DB_PER_S * elapsed);

    // Above the ceiling is worth a number; below it is not. With the limiter on this stays blank,
    // which is what "the limiter is holding" looks like. It latches, like the clip.
    const peakDb = gainToDb(data.peakOut);
    if (peakDb > getLimiterParams().ceilingDb + 0.2 && (overDb === null || peakDb > overDb)) {
      overDb = peakDb;
    }
    if (data.clipped > 0) clipped = true;

    draw();
  });

  /** Where the needle sits for an amplitude, as a fraction of full deflection. */
  const deflectionFor = (amplitude) =>
    clamp01((amplitude * ZERO_VU_DEFLECTION) / dbToGain(ZERO_VU_DBFS));

  /** And where a mark on the face goes, which is the same question asked in VU. */
  const deflectionForVu = (vu) => clamp01(ZERO_VU_DEFLECTION * dbToGain(vu));

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 132;
    const height = canvas.clientHeight || 44;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // The pivot is below the canvas on purpose: a shallow wide arc is what fits a header row, and it
    // is also what a real meter looks like - you see the top of the needle through a window rather
    // than the whole movement.
    //
    // The radius comes from the *width* rather than the height, because the sweep is what has to fit:
    // a 32-degree arc of radius r is 2r·sin32 across and only r(1−cos32) tall, which is six and a
    // half times wider than it is tall. Deriving it from the height put the ends of the scale forty
    // pixels outside the canvas.
    const sweep = (VU_SWEEP_DEG * Math.PI) / 180;
    const centreX = width / 2;
    const scaleRadius = (centreX - 8) / Math.sin(sweep);
    // Low enough that the reduction arc, which sits outside the face, still clears the top edge.
    const pivotY = 2 + REDUCTION_OFFSET + scaleRadius;

    const at = (radius, fraction) => {
      const angle = (fraction * 2 - 1) * sweep;
      return [centreX + radius * Math.sin(angle), pivotY - radius * Math.cos(angle)];
    };
    const arc = (radius, from, to, colour, lineWidth) => {
      if (to <= from) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      const base = -Math.PI / 2;
      ctx.arc(centreX, pivotY, radius, base + (from * 2 - 1) * sweep, base + (to * 2 - 1) * sweep);
      ctx.stroke();
    };

    const idle = !peekContext();
    const dim = cssVar('--panel-border', '#2c3040');

    arc(scaleRadius, 0, 1, dim, 1);
    // Past zero, in red, which is the one thing every VU face has in common.
    arc(scaleRadius, deflectionForVu(0), 1, idle ? dim : '#7f3d3d', 2);

    for (const vu of VU_TICKS) {
      const fraction = deflectionForVu(vu);
      const zero = vu === 0;
      const [x1, y1] = at(scaleRadius + 1, fraction);
      const [x2, y2] = at(scaleRadius + (zero ? 7 : 4), fraction);
      ctx.globalAlpha = idle ? 0.35 : 1;
      ctx.lineWidth = zero ? 1.5 : 1;
      ctx.strokeStyle = zero ? cssVar('--text', '#e8e9ee') : cssVar('--text-dim', '#9aa0b0');
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // What the limiter is taking off, outside the face, hanging down from the top of the scale. The
    // face is linear in amplitude rather than in dB, so this is drawn by turning the reduction into
    // the amplitude ratio it is - which lands 3dB of reduction exactly on the zero mark.
    if (reductionDb > 0.05 && !idle) {
      arc(scaleRadius + REDUCTION_OFFSET, clamp01(dbToGain(-reductionDb)), 1, '#c4b5fd', 2.5);
    }

    if (idle) {
      ctx.fillStyle = cssVar('--text-dim', '#9aa0b0');
      ctx.globalAlpha = 0.5;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText('no sound yet', 4, height - 3);
      ctx.globalAlpha = 1;
      reductionReadout.textContent = '';
      overReadout.textContent = '';
      return;
    }

    if (sounding) {
      const fraction = deflectionFor(vuAmplitude);
      const [tipX, tipY] = at(scaleRadius - 2, fraction);
      // The root is off the bottom of the canvas at the extremes, and that is the window effect
      // rather than an accident.
      const [rootX, rootY] = at(scaleRadius - 30, fraction);
      ctx.strokeStyle = cssVar('--text', '#e8e9ee');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rootX, rootY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }

    if (clipped) {
      ctx.fillStyle = '#f87171';
      ctx.fillRect(width - 6, 2, 4, 4);
    }

    // The same reading as a number, small and dim, under the face.
    //
    // A needle is for feel - is it moving, is it near the top - and it is genuinely better than a bar
    // at that. What it cannot do is be written down or compared with a figure from a render, and the
    // one question that keeps coming up about this meter is exactly that: "how loud is this, really".
    // So both, which is what every mastering meter ends up doing.
    if (sounding && vuAmplitude > 0) {
      ctx.fillStyle = cssVar('--text-dim', '#9aa0b0');
      ctx.font = '9px ui-monospace, monospace';
      ctx.globalAlpha = 0.75;
      ctx.fillText(`${gainToDb(vuAmplitude).toFixed(1)}`, 3, height - 2);
      ctx.globalAlpha = 1;
    }

    reductionReadout.textContent = reductionDb > 0.05 ? `▼${reductionDb.toFixed(1)}` : '';
    reductionReadout.title = reductionDb > 0.05
      ? `The limiter is taking off ${reductionDb.toFixed(1)}dB. More than a few dB means a part's Level is too high — the limiter is a safety net, not a mixer.`
      : '';
    overReadout.textContent = overDb === null ? '' : `over ${overDb.toFixed(1)}`;
    overReadout.title = overDb === null
      ? ''
      : `A sample reached ${overDb.toFixed(1)}dBFS, above the ceiling. Click the meter to clear it.`;
  }

  // Once now, so the scale is on screen from page load rather than appearing with the first note.
  // The canvas has no layout at this instant, hence the fallbacks in draw().
  requestAnimationFrame(draw);

  return {
    element,
    refresh: draw,
    dispose: unsubscribe,
  };
}
