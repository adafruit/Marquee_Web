/**
 * A6-A — flash the device.
 *
 * The last step of setup, and the one that turns a draft into a display. Browser-side
 * esptool over WebSerial: no server is involved, which is what lets the whole flow work
 * from a static host.
 *
 * THE WRITE PATH IS A SEAM in this build — see flash.js. Everything around it is real:
 * the states, the log, the progress rows, the copy, and the browser gate. Connect calls
 * the seam and reports what it says, which is that it is not implemented. Nothing here
 * mimes a result.
 *
 * What WOULD be written is real too: the record's `cfg` (device/cfg.js) is the board's
 * cfg-marquee.json, assembled across the previous screens. "Show JSON config" in the
 * rail opens it, so what the flash path will hand the board can be read before there is
 * a flash path — and so a board configured by hand can be given the same file.
 *
 * The browser gate IS real even so. It costs a capability check, it decides which of
 * two messages the screen shows, and getting it wrong means a Safari user clicking a
 * dead button — so there is no reason to defer it with the rest.
 */

import { navigate } from '../core/router.js';
import { flashDevice, serialSupported } from '../device/flash.js';
import { syncCfg, cfgJson, CFG_FILENAME } from '../device/cfg.js';
import * as devices from '../device/devices.js';
import {
  $, show, setCheck, toast, fmtLocalSeconds, wireModal, openModal, copyFromButton, download,
} from '../core/util.js';

let running = false;

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

function setProgress({ phase, pct }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = $(phase === 'erase' ? 'a6aEraseFill' : 'a6aWriteFill');
  const label = $(phase === 'erase' ? 'a6aErasePct' : 'a6aWritePct');
  if (fill) fill.style.width = `${clamped}%`;
  if (label) label.textContent = `${clamped}%`;
}

/** Connected swaps the connect row for the progress rows — they occupy the same slot
 *  because they are the same moment in the screen, before and after. */
function setConnected(on, chip) {
  show($('a6aConnectRow'), !on);
  show($('a6aProgressRow'), on);
  if (on) setCheck('a6aStatus', 'wait', chip ? `Connected — ${chip}` : 'Connected');
  else setCheck('a6aStatus', 'wait', 'Not connected');
}

/**
 * Finish setup for this device.
 *
 * The slot the old completeActOne() occupied. Reached two ways — a successful flash, or
 * "my board is already flashed" — because both mean the same thing about the record:
 * there is nothing left for setup to ask.
 */
function finish(message) {
  const id = devices.activeDeviceId();
  if (id) devices.promoteDraft(id);
  navigate('a7');
  if (message) toast(message);
}

async function connect() {
  if (running) return;
  running = true;
  $('a6aConnect').disabled = true;

  try {
    // Rebuilt at the moment it is needed, so an edit in Settings since A5C is in the
    // file that goes to the board rather than only on the screen.
    const cfg = syncCfg();
    if (!cfg?.network?.wifi_ssid) log('No network saved for this display — go back to Wi-Fi setup before flashing.');

    const res = await flashDevice({
      device: devices.activeDevice(),
      cfg,
      onLog: log,
      onProgress: setProgress,
    });

    if (res.ok) {
      setConnected(true, res.chip);
      finish('Flashed — opening the editor');
      return;
    }
    setCheck('a6aStatus', 'fail', 'Not connected');
  } finally {
    running = false;
    $('a6aConnect').disabled = !serialSupported();
  }
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
  $('a6aConnect')?.addEventListener('click', connect);

  wireModal('cfgModal', ['cfgClose']);
  $('a6aShowCfg')?.addEventListener('click', (e) => showCfg(e.currentTarget));
  $('cfgCopy')?.addEventListener('click', (e) => copyFromButton(e.currentTarget, cfgJson()));
  $('cfgDownload')?.addEventListener('click', () => {
    download(new Blob([cfgJson()], { type: 'application/json' }), CFG_FILENAME);
  });

  $('a6aSkip')?.addEventListener('click', () => {
    finish('Setup complete');
  });

  // Back to Wi-Fi. Cheap now that A5C keeps what was typed — it re-opens prefilled
  // rather than empty. setupStep follows, so a reload lands on the screen being shown.
  $('a6aBack')?.addEventListener('click', () => {
    const id = devices.activeDeviceId();
    if (id) devices.setSetupStep(id, 'a5c');
    navigate('a5c');
  });

  onEnter('a6a', () => {
    const ok = serialSupported();
    // The unsupported message REPLACES the instruction rather than joining it: telling
    // someone how to connect and then that they cannot is two sentences where one will
    // do, and the second one is the only one that matters.
    show($('a6aLead'), ok);
    $('a6aUnsupported').hidden = ok;
    $('a6aConnect').disabled = !ok;

    setConnected(false);
    setProgress({ phase: 'erase', pct: 0 });
    setProgress({ phase: 'write', pct: 0 });
    clearLog();
  });
}
