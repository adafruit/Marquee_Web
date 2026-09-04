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
 * The browser gate IS real even so. It costs a capability check, it decides which of
 * two messages the screen shows, and getting it wrong means a Safari user clicking a
 * dead button — so there is no reason to defer it with the rest.
 */

import { navigate, setChromeBadge } from '../core/router.js';
import { flashDevice, serialSupported } from '../device/flash.js';
import { takeWifiCredentials, clearWifiCredentials } from './a5c.js';
import * as devices from '../device/devices.js';
import { $, show, setCheck, toast, fmtLocalSeconds } from '../core/util.js';

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
  // Whatever happened to the board, the credentials are done with. The promise on A5C
  // said they would not outlive this step.
  clearWifiCredentials();
  if (id) devices.promoteDraft(id);
  navigate('a7');
  if (message) toast(message);
}

async function connect() {
  if (running) return;
  running = true;
  $('a6aConnect').disabled = true;

  try {
    // Read-once, and only at the moment they are needed. Held no longer than the call.
    const wifi = takeWifiCredentials();
    if (!wifi) log('No network configuration from the previous step — re-run Wi-Fi setup before flashing.');

    const res = await flashDevice({
      device: devices.activeDevice(),
      wifi,
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

export function initA6a({ onEnter }) {
  $('a6aConnect')?.addEventListener('click', connect);

  $('a6aSkip')?.addEventListener('click', () => {
    finish('Setup complete');
  });

  onEnter('a6a', () => {
    // Names the capability this whole screen rests on, up where the app's own state
    // lives. router.js holds it in a variable rather than the DOM so it survives the
    // syncChrome() that every setState() triggers; it clears itself on the way out
    // because SCREENS says the badge belongs to setup only.
    setChromeBadge('WEBSERIAL');

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
