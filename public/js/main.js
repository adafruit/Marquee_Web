/**
 * Boot, the settings modal, and the device-switch sequence.
 *
 * Order matters in three places and nowhere else:
 *   - initDevices() runs FIRST. It migrates the pre-multi-device stores and decides
 *     which record is active, and both initSettings() and initConfig() need a record
 *     to restore from.
 *   - initConfig() runs before anything reads the display descriptor, because it is
 *     what restores it and pushes it into `display`.
 *   - the screen modules register their enter hooks before the first navigate(), or
 *     the landing screen would miss its own hook.
 *
 * The device-switch sequence itself is activate.js — A1 has to call it too, and a
 * screen importing this entry point would be a cycle.
 */

import { initConfig, configChanged } from './core/config.js';
import { initDoc, saveCanvasNow } from './core/doc.js';
import { initRender } from './canvas/render.js';
import { initFeeds } from './device/feeds.js';
import { initIconFont } from './canvas/elements.js';
import { initDevice, scheduleWakeResponseSync } from './device/device.js';
import { initKeyboard } from './canvas/selection.js';
import { initRouter, navigate, onEnter, syncNav, isNavigable } from './core/router.js';
import { getState, subscribe, replaceFlow } from './core/state.js';
import * as devices from './device/devices.js';
import { rehydrateFor, removeDevice } from './device/activate.js';
import { initA1 } from './screens/a1.js';
import { initA4 } from './screens/a4.js';
import { initA5b } from './screens/a5b.js';
import { initA5c } from './screens/a5c.js';
import { initA6a } from './screens/a6a.js';
import { initA7 } from './screens/a7.js';
import { initA8 } from './screens/a8.js';
import { $, wireModal, openModal, closeModal, toast } from './core/util.js';

// ---------- settings persistence --------------------------------------------
//
// Credentials, the ProtoMQ target and the sleep behaviour live in localStorage rather
// than on the server: they are per-browser bench setup, and keeping them client-side
// means they survive a server restart.
//
// They are no longer ONE blob. Half of these fields describe the Adafruit IO account
// and half describe a particular board, and the split is declared once in
// devices.js#SETTINGS_SCOPE so a field cannot quietly end up in both or neither. The
// two legacy migrations that used to live here (ioFeed -> ioGroup, ioProd -> !ioDev)
// moved into devices.js#migrate(), which is the last place the old flat blob is ever
// read — so they now run once instead of on every boot forever.
//
// NOTE: the AIO key is stored here in plaintext. Acceptable for a local dev tool on
// your own machine; it is also written onto the device at A6-A.

function saveSettings(id) {
  const scope = devices.SETTINGS_SCOPE[id];
  if (scope === 'account') devices.saveAccount(devices.snapshotAccountFields());
  else devices.flushActive();
}

function restoreSettings() {
  devices.restoreAccountFields();
  devices.restoreDeviceFields(devices.activeDevice()?.settings || {});
}

function initSettings() {
  wireModal('settingsModal', ['settingsClose', 'settingsDone']);
  $('btnSettings')?.addEventListener('click', () => openModal('settingsModal'));

  restoreSettings();

  Object.keys(devices.SETTINGS_SCOPE).forEach((id) => {
    const el = $(id);
    if (!el) return;
    const evt = id === 'ioDev' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      saveSettings(id);
      // The refresh interval is what a sleeping device is re-registered with — and
      // also what picks its sleep mode (sleepModeFor in config.js) — so an edit here
      // has to reach the device path exactly like a pin change does. It does not stale
      // a downloaded bundle: cfg-marquee.json carries no timing, and code.py owns its
      // own.
      //
      // wakeAlarm is deliberately NOT in here: it reaches a CircuitPython board over
      // the sleep feed, so it neither re-registers a broker cycle nor invalidates a
      // bundle.
      if (id === 'sleepDuration') {
        configChanged();
        scheduleWakeResponseSync();
      }
    });
  });

  // Send THIS device back through setup. Only its flow record is cleared — the panel
  // descriptor, credentials and dashboard are bench setup and survive, exactly as they
  // do through "Reset state".
  //
  // The old copy promised "Acts I-III run again from the firmware question", which is
  // wrong twice over now: there is no firmware question, and with more than one device
  // on the list it never said which one it meant.
  $('restartSetup')?.addEventListener('click', async () => {
    const rec = devices.activeDevice();
    if (!rec) { toast('No display selected'); return; }
    const name = devices.deviceLabel(rec);
    if (!confirm(`Start setup over for "${name}"?\n\nYou will pick the device, its Adafruit IO `
      + 'group and its Wi-Fi again. Its panel settings, credentials and current dashboard '
      + 'are kept.')) return;
    devices.resetDevice(rec.id);
    closeModal('settingsModal');
    navigate('a4');
    toast(`Setup restarted for ${name}`);
  });

  // Forget this device entirely. The sibling to the above, and the only way to get a
  // record out of the list.
  $('removeDisplay')?.addEventListener('click', async () => {
    const rec = devices.activeDevice();
    if (!rec) { toast('No display selected'); return; }
    const name = devices.deviceLabel(rec);
    if (!confirm(`Remove "${name}" from this browser?\n\nIts dashboard and settings are `
      + 'deleted here. Nothing on Adafruit IO is touched — the group and its feeds stay, '
      + 'and the board keeps running whatever was last flashed onto it.')) return;
    closeModal('settingsModal');
    // The same path A1's Remove takes, and it does more than delete: this record is the
    // active one, so the canvas, the descriptor and the status watch in front of the user
    // are all still full of it — see removeDevice().
    await removeDevice(rec.id);
    navigate('a1');
    toast(`Removed ${name}`);
  });
}

// ---------- where to land ---------------------------------------------------

function landingScreen() {
  const rec = devices.activeDevice();
  if (!rec) return 'a1';
  // Setup progress is recorded on the record, not inferred from flow state.
  if (rec.setupStep) return rec.setupStep;
  const st = getState();
  // Coming back to a sleeping device should show the sleep state, not the editor —
  // that is the screen that explains why nothing is updating.
  if (st.deviceState === 'asleep' && st.lastWriteAt) return 'a8';
  // isNavigable() is required, not defensive padding: a record migrated from the old
  // build can carry lastScreen: 'a5', which is parked. navigate() hard-rejects it, so
  // NO screen would get data-active and the app would boot to an empty <main> with
  // nothing thrown.
  if (st.lastScreen && st.lastScreen !== 'a8' && isNavigable(st.lastScreen)) return st.lastScreen;
  return 'a7';
}

// ---------- go --------------------------------------------------------------

async function boot() {
  devices.initDevices();

  initRouter();
  initSettings();
  initConfig();
  initDoc();
  initRender();
  initFeeds();
  initDevice();
  initKeyboard();

  // A3 (the firmware fork), A5 (confirm settings) and A6 (the code bundle) are parked:
  // their sections stay in the DOM because config.js reads the descriptor fields inside
  // A5's advanced disclosure, but they are not initialised and router.js has no entry
  // for them. Dropping them from this list is what keeps their modules out of the graph
  // entirely — they still import router exports that no longer exist.
  initA1({ onEnter });
  initA4({ onEnter });
  initA5b({ onEnter });
  initA5c({ onEnter });
  initA6a({ onEnter });
  initA7({ onEnter });
  initA8({ onEnter });

  // Any flow-state change can move the rail, the badge or the device pill — and has to
  // reach the active device's record.
  //
  // The mirror is not optional bookkeeping. state.js persists to its own single key, so
  // without this the record's `flow` slice was only refreshed when something happened to
  // call flushActive() — a device switch, or an edit in Settings. Everything in between
  // (deviceState, wakesAt, lastWriteAt, lastScreen) went to the global key and never to
  // the record, and boot's replaceFlow(rec.flow) then installed the stale copy OVER the
  // fresher one. The visible symptom was reopening the app on the last setup screen you
  // happened to pass through instead of the editor.
  subscribe(() => {
    devices.patchActive({ flow: getState() });
    syncNav();
  });

  const rec = devices.activeDevice();
  if (rec) {
    // The first activation of the session. No flush — there is no outgoing device — but
    // everything else has to run, because the stores were just loaded from a record
    // rather than from the keys initConfig() and initSettings() know about.
    replaceFlow(rec.flow);
    await rehydrateFor(rec);
  }

  navigate(landingScreen());
  if (!rec) saveCanvasNow();   // render + persist the initial (empty) state

  // After the restore, not before: it re-draws the gauges that show an icon once the
  // Font Awesome face resolves, and on a cold load those gauges don't exist yet when
  // boot starts. Deliberately not awaited — the editor must not wait on a font.
  initIconFont();
}

boot().catch((err) => {
  console.error('Marquee failed to start', err);
  toast('Marquee failed to start — see the console');
});
