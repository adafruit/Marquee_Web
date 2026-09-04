/**
 * A5C — Wi-Fi credentials.
 *
 * The screen promises, on screen, that what you type here is used once and then gone:
 * written onto the device over USB by A6-A, never sent to Adafruit IO, never stored in
 * the account, not kept afterwards.
 *
 * THIS MODULE IS WHAT MAKES THAT TRUE, and the enforcement is deliberately boring:
 *
 *   - The credentials live in one module-level object and nowhere else.
 *   - They are not in devices.js#SETTINGS_SCOPE, so the settings persistence that
 *     saves every other field on input cannot see them.
 *   - They are never written to a device record, and the SSID is no exception — the
 *     promise says "the network name and password", and a stored SSID is still a fact
 *     about someone's home that we said we would not keep.
 *   - takeWifiCredentials() is read-ONCE: it hands the object over and nulls the
 *     holder, so the flash path cannot accidentally become a second store.
 *   - Leaving the screen clears them.
 *
 * If you add persistence here, delete the plate in index.html first — otherwise the
 * screen is lying.
 */

import { navigate } from '../core/router.js';
import { setSetupStep, activeDeviceId } from '../device/devices.js';
import { $, val } from '../core/util.js';

let creds = null;

/**
 * Hand the credentials to the flash path, once.
 *
 * Nulls the holder on the way out. A6-A gets exactly one chance to use them, which is
 * the same number of chances the copy on this screen promises.
 */
export function takeWifiCredentials() {
  const out = creds;
  creds = null;
  return out;
}

/** Whether A6-A has something to write. Does not consume. */
export function hasWifiCredentials() { return !!creds; }

/** Called on the way out of the setup run, and by A6-A once flashing resolves. */
export function clearWifiCredentials() {
  creds = null;
  const ssid = $('a5cSsid');
  const pass = $('a5cPass');
  if (ssid) ssid.value = '';
  if (pass) { pass.value = ''; pass.type = 'password'; }
  syncForm();
}

function syncForm() {
  const ok = !!val('a5cSsid');
  const btn = $('a5cSave');
  if (btn) btn.disabled = !ok;
}

export function initA5c({ onEnter }) {
  ['a5cSsid', 'a5cPass'].forEach((id) => $(id)?.addEventListener('input', syncForm));

  // The password is a long string being typed from memory or a router label, and a
  // masked field with no way to check it is how a board silently fails to associate.
  $('a5cPassReveal')?.addEventListener('click', (e) => {
    const input = $('a5cPass');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-pressed', String(!showing));
    e.currentTarget.textContent = showing ? 'Show' : 'Hide';
  });

  $('a5cBack')?.addEventListener('click', () => {
    clearWifiCredentials();
    navigate('a5b');
  });

  $('a5cSave')?.addEventListener('click', () => {
    const ssid = val('a5cSsid');
    if (!ssid) return;
    // An open network is a real configuration, so an empty password is allowed through
    // — the button gates on the SSID alone.
    creds = { ssid, password: $('a5cPass')?.value || '' };
    const id = activeDeviceId();
    if (id) setSetupStep(id, 'a6a');
    navigate('a6a');
  });

  onEnter('a5c', () => {
    // Re-entering means re-typing, which is the promise working rather than a bug. The
    // fields are blanked rather than left holding a value we have already discarded —
    // a filled-looking form backed by nothing is worse than an empty one.
    clearWifiCredentials();
  });
}
