/**
 * A6-A — flash the device, then hand it its configuration.
 *
 * The last step of setup, and the one that turns a draft into a display. Three stages in one
 * screen, because they are one job with two hardware moments in it:
 *
 *   flash   fetch the latest release's merged-flash.bin for this board (device/firmware.js),
 *           or take one from disk; put the board in bootloader mode; write it over WebSerial
 *           (device/flash.js, esptool-js underneath).
 *   drive   press RESET; the firmware comes up as a USB drive named MARQUEE; pick that drive
 *           in the browser and we write cfg-marquee.json into it (device/drive.js).
 *   done    eject, press RESET again; the board reads the file at boot and is on its own.
 *
 * The stage is DERIVED, never stored. `rec.firmware.flashedAt` says a flash happened, so a
 * reload — or a board sent back through setup to change networks — lands on the drive stage
 * rather than re-flashing; nothing lands on `done`, because writing the file again is cheap
 * and is usually the point of coming back. `setupStep` stays 'a6a' throughout.
 *
 * The log is one column for the whole screen and is cleared only on enter: the drive stage's
 * lines land under the flash lines, which is the order things happened in. It is HIDDEN unless
 * something fails — while things are going right it is noise under the instruction, and when
 * they go wrong it is the evidence. Lines are collected either way.
 *
 * Two capability gates, checked separately — Web Serial for the flash, the File System Access
 * API for the drive — because a browser can have one without the other, and getting either
 * wrong is a user clicking a dead button.
 */

import { navigate } from '../core/router.js';
import {
  flashDevice, serialSupported, firmwareFor, loadFirmware, validateFirmware, describeFlashError,
  FIRMWARE_ARTIFACT,
} from '../device/flash.js';
import { fetchManifest, describeFirmwareError, RELEASES_URL } from '../device/firmware.js';
import { dirPickerSupported, writeConfigToDrive, describeDriveError, DRIVE_VOLUME } from '../device/drive.js';
import { syncCfg, cfgJson, CFG_FILENAME } from '../device/cfg.js';
import * as devices from '../device/devices.js';
import {
  $, show, setCheck, toast, fmtBytes, fmtLocalSeconds, wireModal, openModal, copyFromButton, download,
} from '../core/util.js';

const STAGES = ['flash', 'drive', 'done'];

let stage = 'flash';
let running = false;
/** The loaded image and its validation, or null until one is fetched or chosen. */
let fw = null;
let fwCheck = null;
/** Where the image comes from: the latest release, or a file the user picks. */
let fwMode = 'release';
/**
 * The release fetch in flight, if any. `seq` is the real re-entrancy guard: the AbortController
 * stops the network, but the sha digest cannot be interrupted, so a stale run could still
 * resolve after Back or "Use a file" — every await in startReleaseFetch() re-checks `seq`
 * before touching state.
 */
const fwFetch = { state: 'idle', ctrl: null, seq: 0, manifest: null, message: '' };

function log(line) {
  const el = $('a6aLog');
  if (!el) return;
  el.textContent += `${fmtLocalSeconds(new Date())}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  const el = $('a6aLog');
  if (el) el.textContent = '';
}

/** Reveal the log plate. Called on every failure and never re-hidden mid-visit, because
 *  once something has gone wrong the trail stays useful. */
function revealLog() {
  const plate = $('a6aLogPlate');
  show(plate, true);
  const el = $('a6aLog');
  if (el) el.scrollTop = el.scrollHeight;
}

// ---------- progress --------------------------------------------------------

/**
 * One bar. `state` decides what the label says: a full-chip erase reports nothing while it
 * runs, so `busy` animates the track and says "erasing…" rather than inventing a number, and
 * `skipped` says so instead of sitting at 0% as if it were about to start.
 */
function setProgress({ phase, pct = 0, state = 'idle' }) {
  const erase = phase === 'erase';
  const row = $(erase ? 'a6aEraseRow' : 'a6aWriteRow');
  const fill = $(erase ? 'a6aEraseFill' : 'a6aWriteFill');
  const label = $(erase ? 'a6aErasePct' : 'a6aWritePct');
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (row) row.dataset.state = state;
  if (fill) fill.style.width = state === 'busy' ? '' : `${state === 'skipped' ? 0 : clamped}%`;
  if (label) {
    label.textContent = state === 'skipped' ? 'skipped'
      : state === 'busy' ? 'erasing…'
        : `${clamped}%`;
  }
}

function resetProgress() {
  setProgress({ phase: 'erase', state: 'idle', pct: 0 });
  setProgress({ phase: 'write', state: 'idle', pct: 0 });
}

/** Connected swaps the connect row for the progress rows — they occupy the same slot
 *  because they are the same moment in the screen, before and after. */
function setConnected(on, text) {
  show($('a6aConnectRow'), !on);
  show($('a6aProgressRow'), on);
  setCheck('a6aStatus', 'wait', text || (on ? 'Connected' : 'Not connected'));
}

// ---------- the stages ------------------------------------------------------

const LEADS = {
  flash: 'Put the board in bootloader mode — hold BOOT, tap RESET, release BOOT — then, once the firmware has downloaded, click Connect and flash.',
  drive: `Press RESET. When a drive named ${DRIVE_VOLUME} appears, choose it below and the configuration is written onto it.`,
  done: `Eject ${DRIVE_VOLUME}, then press RESET. The board reads its configuration at boot and takes it from there.`,
};

function setStage(next) {
  if (!STAGES.includes(next)) return;
  stage = next;
  STAGES.forEach((s) => {
    const cap = s[0].toUpperCase() + s.slice(1);
    show($(`a6aStage${cap}`), s === stage);
    show($(`a6aRail${cap}`), s === stage);
  });
  const lead = $('a6aLead');
  if (lead) lead.textContent = LEADS[stage];
  // The lead is the flash stage's instruction, and the unsupported message REPLACES it there.
  // On the other stages serial is not involved, so the instruction always shows.
  if (stage !== 'flash') { show(lead, true); $('a6aUnsupported').hidden = true; } else { syncSerialGate(); }

  syncGates();
}

function syncSerialGate() {
  const ok = serialSupported();
  // The unsupported message REPLACES the instruction rather than joining it: telling someone
  // how to connect and then that they cannot is two sentences where one will do, and the
  // second one is the only one that matters.
  show($('a6aLead'), ok);
  $('a6aUnsupported').hidden = ok;
}

/**
 * Every enable/disable rule on the screen, in one place, re-run after anything changes.
 * During a run EVERYTHING is locked: a second port dialog mid-write breaks the transport, and
 * flipping the erase box after the erase decision was made would have the bars lie.
 */
function syncGates() {
  const canFlash = serialSupported() && !running && !!fw && !!fwCheck?.ok;
  $('a6aConnect').disabled = !canFlash;
  ['a6aFwPick', 'a6aFwUseFile', 'a6aFwUseRelease', 'a6aFwRetry', 'a6aEraseAll', 'a6aSkip', 'a6aBack',
    'a6aOpenDrive', 'a6aDriveSkip', 'a6aDone', 'a6aDriveContinue', 'a6aFlashAgain', 'a6aRewrite']
    .forEach((id) => { const el = $(id); if (el) el.disabled = running; });
}

// ---------- stage: flash ----------------------------------------------------

function expected() { return firmwareFor(devices.activeDevice()); }

/** "MagTag · v1.0.0-alpha (pre-release)" — the release half of the status line. */
function releaseLabel(expect, m) {
  if (!m) return '';
  return `${expect?.label || 'board'} · v${m.version}${m.prerelease ? ' (pre-release)' : ''}`;
}

/**
 * The firmware row, in whichever mode it is in. Release mode is a status line that fills in as
 * the manifest and then the image arrive; file mode is the old row — a button and a name.
 */
function renderFirmwareRow() {
  const row = $('a6aFwRow');
  if (row) { row.dataset.mode = fwMode; row.dataset.state = fwMode === 'release' ? fwFetch.state : 'idle'; }
  const release = fwMode === 'release';
  show($('a6aFwRelease'), release);
  show($('a6aFwUseFile'), release);
  show($('a6aFwRetry'), release && fwFetch.state === 'failed');
  show($('a6aFwTrack'), release && fwFetch.state === 'fetching' && !!fwFetch.manifest);
  show($('a6aFwName'), !release);
  show($('a6aFwPick'), !release);
  show($('a6aFwUseRelease'), !release);

  const expect = expected();
  if (release) {
    const m = fwFetch.manifest;
    if (fwFetch.state === 'failed') setCheck('a6aFwStatus', 'fail', fwFetch.message);
    else if (fw && fwCheck?.ok) setCheck('a6aFwStatus', 'pass', `${releaseLabel(expect, m)} · ${fmtBytes(fw.size)}`);
    else if (fw && fwCheck) setCheck('a6aFwStatus', 'fail', `${releaseLabel(expect, m)} — ${fwCheck.problems.join(' ')}`);
    else if (m) setCheck('a6aFwStatus', 'wait', `${releaseLabel(expect, m)} · downloading…`);
    else setCheck('a6aFwStatus', 'wait', fwFetch.state === 'fetching' ? 'Looking for the latest release…' : 'Latest release');
  } else {
    const name = $('a6aFwName');
    if (name) {
      name.textContent = fw ? `${fw.name} · ${fmtBytes(fw.size)}` : 'No file chosen';
      name.dataset.state = fw ? (fwCheck?.ok ? 'ok' : 'bad') : 'empty';
    }
  }

  const err = $('a6aFwError');
  if (err) {
    const problems = fwCheck && !fwCheck.ok ? fwCheck.problems : [];
    err.textContent = problems.join(' ');
    err.hidden = problems.length === 0;
  }
}

function setFetchProgress({ received, total }) {
  const fill = $('a6aFwFill');
  if (fill) fill.style.width = total ? `${Math.min(100, (received / total) * 100)}%` : '';
  const m = fwFetch.manifest;
  const amount = total ? `${fmtBytes(received)} of ${fmtBytes(total)}` : fmtBytes(received);
  setCheck('a6aFwStatus', 'wait', `${releaseLabel(expected(), m)} · ${amount}`);
}

/** Stop any release fetch in flight and make sure its late results are ignored. */
function abortReleaseFetch() {
  fwFetch.ctrl?.abort();
  fwFetch.ctrl = null;
  fwFetch.seq += 1;
  if (fwFetch.state === 'fetching') fwFetch.state = 'idle';
}

function setFwHint(text) {
  const hint = $('a6aFwExpect');
  if (hint) hint.textContent = text;
}

/**
 * Download the latest release for this board. Idempotent while one is in flight; a fresh call
 * after a failure is the Retry.
 */
async function startReleaseFetch() {
  if (stage !== 'flash' || fwMode !== 'release' || running || !serialSupported()) return;
  const expect = expected();
  if (!expect) {
    enterFileMode('Panel set up by hand — there is no release build to pick, so choose merged-flash.bin for your board. The chip will not be checked.');
    return;
  }
  if (fwFetch.state === 'fetching') return;

  abortReleaseFetch();
  const seq = fwFetch.seq;
  const ctrl = new AbortController();
  fwFetch.ctrl = ctrl;
  fwFetch.state = 'fetching';
  fwFetch.manifest = null;
  fwFetch.message = '';
  fw = null; fwCheck = null;
  renderFirmwareRow();
  syncGates();

  const m = await fetchManifest({ signal: ctrl.signal });
  if (seq !== fwFetch.seq) return;
  if (!m.ok) { failRelease(m); return; }
  fwFetch.manifest = m.manifest;
  renderFirmwareRow();

  if (!m.manifest.boards?.[expect.board]) {
    log(`The ${m.manifest.tag} release has no build for the ${expect.label}.`);
    enterFileMode(`The ${m.manifest.tag} release has no build for the ${expect.label} — choose merged-flash.bin for it instead.`);
    return;
  }

  const loaded = await loadFirmware({
    kind: 'release', manifest: m.manifest, board: expect.board, signal: ctrl.signal, onProgress: setFetchProgress,
  });
  if (seq !== fwFetch.seq) return;
  if (!loaded.ok) { failRelease(loaded); return; }

  fw = loaded;
  fwCheck = validateFirmware(fw, expect);
  fwFetch.state = fwCheck.ok ? 'ready' : 'failed';
  fwFetch.ctrl = null;
  if (fwCheck.ok) {
    log(`Downloaded ${fw.name} v${fw.version} for the ${expect.label} (${fmtBytes(fw.size)}), checksum verified.`);
  } else {
    fwFetch.message = fwCheck.problems.join(' ');
    log(`Rejected the release image: ${fwFetch.message}`);
    revealLog();
  }
  if (fw.chip && fw.chip !== expect.chip) log(`Note: the release lists this build as ${fw.chip}; the ${expect.label} is an ${expect.chip}.`);
  fwCheck.warnings.forEach((w) => log(`Note: ${w}`));
  renderFirmwareRow();
  syncGates();
}

function failRelease(res) {
  fwFetch.ctrl = null;
  if (res.error === 'aborted') { fwFetch.state = 'idle'; renderFirmwareRow(); return; }
  fwFetch.state = 'failed';
  fwFetch.message = describeFirmwareError(res);
  log(`Firmware download failed: ${res.message || res.error}`);
  revealLog();
  renderFirmwareRow();
  syncGates();
}

/** Switch the row to the file picker. `hint` replaces the release hint under the row. */
function enterFileMode(hint) {
  abortReleaseFetch();
  fwMode = 'file';
  fw = null; fwCheck = null;
  const input = $('a6aFwFile');
  if (input) input.value = '';
  setFwHint(hint || 'Choose merged-flash.bin from a CI artifact or an older release for this board.');
  renderFirmwareRow();
  syncGates();
}

function enterReleaseMode() {
  fwMode = 'release';
  fw = null; fwCheck = null;
  fwFetch.state = 'idle';
  setFwHint(releaseHint());
  renderFirmwareRow();
  syncGates();
  startReleaseFetch();
}

function releaseHint() {
  const expect = expected();
  return expect
    ? `Built for the ${expect.label} (${expect.chip}) — the latest release from ${RELEASES_URL.replace('https://', '')}.`
    : '';
}

async function onFirmwarePicked(e) {
  const file = e.currentTarget.files?.[0];
  if (!file) return;
  const loaded = await loadFirmware({ kind: 'file', file });
  if (!loaded.ok) {
    fw = null; fwCheck = null;
    renderFirmwareRow();
    log(`Could not read ${file.name}: ${loaded.message}`);
    syncGates();
    return;
  }
  fw = loaded;
  fwCheck = validateFirmware(fw, expected());
  renderFirmwareRow();
  if (fwCheck.ok) log(`Loaded ${fw.name} (${fmtBytes(fw.size)}).`);
  else log(`Rejected ${fw.name}: ${fwCheck.problems.join(' ')}`);
  fwCheck.warnings.forEach((w) => log(`Note: ${w}`));
  syncGates();
}

async function connect() {
  if (running || !fw || !fwCheck?.ok) return;
  running = true;
  syncGates();
  resetProgress();
  setConnected(true, 'Connecting…');

  const expect = expected();
  const eraseAll = !!$('a6aEraseAll')?.checked;

  try {
    const res = await flashDevice({ firmware: fw, expect, eraseAll, onLog: log, onProgress: setProgress });

    if (res.ok) {
      devices.patchActive({
        firmware: {
          flashedAt: Date.now(), board: expect?.board ?? null, chip: res.chip,
          fileName: fw.name, bytes: fw.size, erased: eraseAll,
          source: fw.source ?? fwMode, version: fw.version ?? null, tag: fw.tag ?? null, sha256: fw.sha256 ?? null,
        },
      });
      setCheck('a6aStatus', 'pass', `Flashed — ${res.chip}`);
      toast('Firmware written');
      setStage('drive');
      return;
    }

    setConnected(false);
    const sentence = describeFlashError(res);
    setCheck('a6aStatus', res.error === 'cancelled' ? 'wait' : 'fail', sentence);
    if (res.error === 'cancelled') log(sentence);
    else revealLog();
  } finally {
    running = false;
    syncGates();
  }
}

// ---------- stage: drive ----------------------------------------------------

/** The drive stage's status line. Shown only when it has something to say — there is no
 *  "not written yet" idle state, the plate above already says what to do. */
function setDriveStatus(state, text) {
  setCheck('a6aDriveStatus', state, text || '');
  show($('a6aDriveStatus'), !!text);
}

async function writeConfig() {
  if (running) return;
  // syncCfg() is synchronous and runs BEFORE the picker: an edit in Settings since A5C has to
  // be in the file that goes to the board, and the picker needs the click's activation intact.
  const cfg = syncCfg();
  if (!cfg?.display) {
    setDriveStatus('fail', 'No panel configured — go back and choose one before writing.');
    return;
  }
  if (!cfg.network?.wifi_ssid) log('No network saved for this display — the board will not be able to join Wi-Fi with this file.');

  running = true;
  syncGates();
  try {
    const res = await writeConfigToDrive(cfgJson(), {
      onLog: log,
      confirmMismatch: async (name) => window.confirm(
        `That drive is called "${name}", not ${DRIVE_VOLUME}.\n\nWrite ${CFG_FILENAME} there anyway?`,
      ),
    });

    if (res.ok) {
      devices.patchActive({ cfgWrittenAt: Date.now() });
      setDriveStatus('pass', `${CFG_FILENAME} written to ${res.volume}`);
      toast('Configuration written');
      setStage('done');
      return;
    }

    const sentence = describeDriveError(res);
    const soft = res.error === 'cancelled' || res.error === 'wrong-volume';
    setDriveStatus(soft ? 'wait' : 'fail', sentence);
    if (res.error === 'cancelled') log(sentence);
    if (!soft) revealLog();
    // A browser that cannot get at the drive still has the download route.
    if (res.error === 'unsupported' || res.error === 'denied' || res.error === 'write-failed') show($('a6aDriveFallback'), true);
  } finally {
    running = false;
    syncGates();
  }
}

function downloadCfg() {
  syncCfg();
  download(new Blob([cfgJson()], { type: 'application/json' }), CFG_FILENAME);
  log(`Downloaded ${CFG_FILENAME} — copy it to the root of the ${DRIVE_VOLUME} drive.`);
}

/**
 * Finish setup for this device.
 *
 * Reached from the done stage, or from either skip — because all of them mean the same thing
 * about the record: there is nothing left for setup to ask.
 */
function finish(message) {
  abortReleaseFetch();
  const id = devices.activeDeviceId();
  if (id) devices.promoteDraft(id);
  navigate('a7');
  if (message) toast(message);
}

// ---------- the debug view --------------------------------------------------

/** The config as it stands, into the modal's <pre>. Re-synced first: the point of the
 *  view is to see what the board WOULD get, and that must not be a stale snapshot. */
function showCfg(trigger) {
  syncCfg();
  const view = $('cfgJson');
  if (view) view.textContent = cfgJson();
  openModal('cfgModal', { returnFocusTo: trigger });
}

export function initA6a({ onEnter }) {
  // Stage: flash
  $('a6aFwPick')?.addEventListener('click', () => $('a6aFwFile')?.click());
  $('a6aFwFile')?.addEventListener('change', onFirmwarePicked);
  // Same click, so the picker keeps the user's activation.
  $('a6aFwUseFile')?.addEventListener('click', () => { enterFileMode(); $('a6aFwFile')?.click(); });
  $('a6aFwUseRelease')?.addEventListener('click', enterReleaseMode);
  $('a6aFwRetry')?.addEventListener('click', () => { fwFetch.state = 'idle'; startReleaseFetch(); });
  $('a6aEraseAll')?.addEventListener('change', (e) => show($('a6aEraseWarn'), e.currentTarget.checked));
  $('a6aConnect')?.addEventListener('click', connect);
  $('a6aSkip')?.addEventListener('click', () => {
    abortReleaseFetch();
    log('Skipping the flash — the board is taken to be running the marquee firmware already.');
    setStage('drive');
  });

  // Stage: drive
  $('a6aOpenDrive')?.addEventListener('click', writeConfig);
  $('a6aDownloadCfg')?.addEventListener('click', downloadCfg);
  $('a6aDriveContinue')?.addEventListener('click', () => setStage('done'));
  $('a6aDriveSkip')?.addEventListener('click', () => finish('Setup complete'));
  // The way back to a re-flash lives IN the stage, not on the foot's Back button — Back has
  // one meaning on every setup screen, and a board that needs re-flashing is the exception.
  $('a6aFlashAgain')?.addEventListener('click', () => {
    setStage('flash');
    if (!fw) startReleaseFetch();
  });

  // Stage: done
  $('a6aDone')?.addEventListener('click', () => finish('Setup complete — opening the editor'));
  $('a6aRewrite')?.addEventListener('click', () => setStage('drive'));

  // The debug view
  wireModal('cfgModal', ['cfgClose']);
  $('a6aShowCfg')?.addEventListener('click', (e) => showCfg(e.currentTarget));
  $('cfgCopy')?.addEventListener('click', (e) => copyFromButton(e.currentTarget, cfgJson()));
  $('cfgDownload')?.addEventListener('click', () => {
    download(new Blob([cfgJson()], { type: 'application/json' }), CFG_FILENAME);
  });

  // Back to Wi-Fi, from every stage. Cheap now that A5C keeps what was typed — it re-opens
  // prefilled rather than empty. setupStep follows, so a reload lands on the screen being
  // shown. Moving between stages is done by buttons inside the stages themselves.
  $('a6aBack')?.addEventListener('click', () => {
    abortReleaseFetch();
    const id = devices.activeDeviceId();
    if (id) devices.setSetupStep(id, 'a5c');
    navigate('a5c');
  });

  onEnter('a6a', () => {
    const rec = devices.activeDevice();
    const expect = expected();

    abortReleaseFetch();
    fw = null; fwCheck = null; running = false;
    fwMode = 'release';
    fwFetch.state = 'idle'; fwFetch.manifest = null; fwFetch.message = '';
    const input = $('a6aFwFile');
    if (input) input.value = '';
    setFwHint(releaseHint());
    renderFirmwareRow();
    const erase = $('a6aEraseAll');
    if (erase) erase.checked = false;
    show($('a6aEraseWarn'), false);

    // The drive and done plates name the board they are talking about — "reset the MagTag" —
    // from the same table the flash checks against. A hand-configured panel has no name; "board" is it.
    document.querySelectorAll('#a6aStageDrive [data-role="board"], #a6aStageDone [data-role="board"]')
      .forEach((el) => { el.textContent = expect?.label || 'board'; });

    const canPick = dirPickerSupported();
    show($('a6aOpenDrive'), canPick);
    show($('a6aDriveFallback'), !canPick);
    setDriveStatus('wait', '');

    setConnected(false);
    resetProgress();
    clearLog();
    show($('a6aLogPlate'), false);
    if (rec?.firmware?.flashedAt) {
      const ver = rec.firmware.version ? ` v${rec.firmware.version}` : '';
      log(`Flashed ${fmtLocalSeconds(new Date(rec.firmware.flashedAt))} — ${rec.firmware.chip || 'chip unknown'} · ${rec.firmware.fileName || FIRMWARE_ARTIFACT}${ver}. "Flash again" redoes it.`);
    }
    setStage(rec?.firmware?.flashedAt ? 'drive' : 'flash');
    // The download starts on its own; a board that was already flashed lands on the drive stage
    // and does not pull 1.3 MB it may never use — "Flash again" starts it then.
    if (stage === 'flash') startReleaseFetch();
  });
}
