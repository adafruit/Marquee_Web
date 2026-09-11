/**
 * Writing firmware to a board over WebSerial — the esptool-js path behind A6-A.
 *
 * Browser-side end to end: `js/vendor/esptool-js.js` is the upstream bundle (esptool-js
 * 0.6.1, Apache-2.0, pako inlined) loaded with a dynamic import() the first time someone
 * clicks Connect, so the 218 KB never ships to a user who only edits. No server is involved,
 * which is what lets the whole flow work from a static host.
 *
 * WHAT GETS WRITTEN. One file, `merged-flash.bin`, at address 0x0. The Adafruit_Marquee CI
 * produces it with `esptool merge-bin --format raw`: bootloader, partition table, boot_app0
 * and the app laid out at their real offsets with 0xFF in the gaps, so a single write at 0
 * is the whole flash image. The MagTag's bootloader sits at 0x1000, so its image starts with
 * 0x1000 bytes of padding; the two ESP32-S3 boards start with the bootloader itself.
 *
 * WHERE IT COMES FROM. The latest release, by default: firmware.js fetches the manifest CI
 * commits to the `firmware` branch of Adafruit_Marquee and downloads the board's merged image
 * from it, sha256-checked. (Not the Release page's assets — GitHub's asset CDN sends no CORS
 * header, so a browser cannot read them; see firmware.js.) A file the user picked is the
 * fallback, for a CI artifact, an older release, or a panel set up by hand. loadFirmware() is
 * where the two meet: both return the same shape, and nothing downstream knows which it was.
 *
 * WHAT IS NOT HERE. The config file. The firmware reads `cfg-marquee.json` from the FAT
 * volume it exposes over USB, not from anything written over serial, so that step lives in
 * drive.js and this module never sees a credential. Nothing it logs can leak one.
 *
 * THE CONTRACT
 *
 *   flashDevice({ firmware, expect, eraseAll, onLog, onProgress })
 *     -> Promise<{ ok: true, chip, chipDesc } | { ok: false, error, message, chip? }>
 *
 * Resolves rather than throws, for the reason provision.js does: the caller has to tell "no
 * port chosen" from "wrong chip" from "write failed halfway", because each wants a different
 * sentence on screen, and a thrown Error flattens all three into one catch block.
 * describeFlashError() holds those sentences.
 *
 * `onProgress({ phase: 'erase' | 'write', state, pct })` — state is one of
 * idle | skipped | busy | active | done. `busy` exists because a full-chip erase reports no
 * progress at all: esptool-js sends one command and waits up to the chip-erase timeout, so the
 * honest thing to show is "erasing…" and not a number.
 */

import { fetchManifest, fetchReleaseFirmware } from './firmware.js';

/** Is this browser capable of talking to a serial port at all? */
export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export const FIRMWARE_ARTIFACT = 'merged-flash.bin';

/**
 * The three boards the firmware is built for, keyed as the CI matrix names them.
 *
 * `chip` is compared against what esptool reads out of the ROM before anything is written —
 * a MagTag image on a Feather would brick the Feather, and the chip is the one thing the two
 * disagree on that we can check. `bootloaderOffset` is where the 0xE9 image header has to be;
 * `flashSize` bounds the file. The partition table is at 0x8000 on every layout.
 */
const BOARDS = {
  magtag: {
    board: 'magtag', label: 'MagTag', chip: 'ESP32-S2', bootloaderOffset: 0x1000, flashSize: 4 << 20,
  },
  adafruit_feather_esp32s3: {
    board: 'adafruit_feather_esp32s3', label: 'Feather ESP32-S3', chip: 'ESP32-S3', bootloaderOffset: 0x0, flashSize: 4 << 20,
  },
  x4pro: {
    board: 'x4pro', label: 'Xteink X4 Pro', chip: 'ESP32-S3', bootloaderOffset: 0x0, flashSize: 16 << 20,
  },
};

/** Preset keys that name a whole product. Every other preset is a panel wired to a Feather. */
const PRESET_BOARD = { magtag: 'magtag', x4pro: 'x4pro' };

/**
 * Which firmware build a device needs, or null for a panel set up by hand.
 *
 * Keyed off the panel preset, because that is what tells us the host board: the preset carries
 * the Feather's SPI pins for every bare panel, so anything that is not a MagTag or an X4 Pro is
 * a Feather ESP32-S3. Reads `flow.selectedPanel` off the record — the same field cfg.js reads.
 */
export function firmwareFor(device) {
  const preset = device?.flow?.selectedPanel;
  if (!preset) return null;
  const key = PRESET_BOARD[preset] || 'adafruit_feather_esp32s3';
  return { ...BOARDS[key], artifactName: FIRMWARE_ARTIFACT };
}

/**
 * Get the bytes of a firmware image from wherever it lives.
 *
 * The source seam. Two kinds:
 *
 *   { kind: 'release', board, manifest?, signal?, onProgress? }
 *       the latest published release, from the firmware branch (firmware.js). The manifest is
 *       fetched here when the caller has not already got one. Failures carry firmware.js's
 *       error codes so the screen can pick its sentence and its button.
 *   { kind: 'file', file }
 *       a File the user chose.
 *
 * Both resolve to `{ ok, name, size, bytes, source }` — validateFirmware() and flashDevice()
 * take that and never learn which it was.
 */
export async function loadFirmware(source) {
  try {
    if (source?.kind === 'release') {
      let { manifest } = source;
      if (!manifest) {
        const m = await fetchManifest({ signal: source.signal });
        if (!m.ok) return m;
        manifest = m.manifest;
      }
      return fetchReleaseFirmware({ manifest, board: source.board, signal: source.signal, onProgress: source.onProgress });
    }
    if (source?.kind === 'file' && source.file) {
      const buf = await source.file.arrayBuffer();
      return { ok: true, name: source.file.name, size: buf.byteLength, bytes: new Uint8Array(buf), source: 'file' };
    }
    return { ok: false, error: 'load-failed', message: `Unsupported firmware source: ${source?.kind ?? 'none'}` };
  } catch (err) {
    return { ok: false, error: 'load-failed', message: err?.message || String(err) };
  }
}

const ESP_IMAGE_MAGIC = 0xe9;
/** The two bytes every ESP-IDF partition table starts with, at 0x8000 on every layout here. */
const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_MAGIC = [0xaa, 0x50];
/** A merged image is at least bootloader + table + boot_app0 + an app; a bare app is smaller. */
const MIN_MERGED_BYTES = 256 * 1024;

/**
 * Is this file the merged image for this board? Run before any port dialog, so a wrong file
 * never costs the user a connect.
 *
 * The partition-table check is the load-bearing one: `firmware.bin` ALSO starts with 0xE9, and
 * writing it at 0x0 would "succeed" and leave a board with no bootloader. Only the merged image
 * has a table at 0x8000. The MagTag gets one more: its image starts with padding, so an 0xE9 at
 * byte 0 means a Feather or X4 build was picked.
 */
export function validateFirmware(fw, expect) {
  const problems = [];
  const warnings = [];
  const b = fw?.bytes;
  if (!b) return { ok: false, problems: ['No file loaded.'], warnings };

  if (b.length < MIN_MERGED_BYTES) {
    problems.push(`Too small to be a merged image (${b.length} bytes) — was this firmware.bin or partitions.bin instead of ${FIRMWARE_ARTIFACT}?`);
  }
  if (expect && b.length > expect.flashSize) {
    problems.push(`Larger than the ${expect.label}'s ${expect.flashSize >> 20} MB flash.`);
  }
  if (b.length > PARTITION_TABLE_OFFSET + 2
    && !(b[PARTITION_TABLE_OFFSET] === PARTITION_MAGIC[0] && b[PARTITION_TABLE_OFFSET + 1] === PARTITION_MAGIC[1])) {
    problems.push(`No partition table at 0x8000 — this is not ${FIRMWARE_ARTIFACT}.`);
  }
  if (expect) {
    if (b[expect.bootloaderOffset] !== ESP_IMAGE_MAGIC) {
      problems.push(`No bootloader at 0x${expect.bootloaderOffset.toString(16)}, where the ${expect.label} image keeps it.`);
    }
    if (expect.board === 'magtag' && b[0] === ESP_IMAGE_MAGIC) {
      problems.push('This looks like a Feather or X4 Pro image, not the MagTag build.');
    }
  } else if (b[0] !== ESP_IMAGE_MAGIC && b[0x1000] !== ESP_IMAGE_MAGIC) {
    problems.push('No ESP image header at 0x0 or 0x1000.');
  } else {
    warnings.push('Panel set up by hand — the chip will not be checked against the image.');
  }
  if (fw.name && fw.name !== FIRMWARE_ARTIFACT) {
    warnings.push(`Expected a file named ${FIRMWARE_ARTIFACT}; got ${fw.name}.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

// ---------- the write path ---------------------------------------------------

let esptoolModule = null;

/** The bundle, once. Cached as the promise so two clicks do not load it twice. */
function loadEsptool() {
  if (!esptoolModule) {
    esptoolModule = import('../vendor/esptool-js.js').catch((err) => {
      esptoolModule = null;
      throw err;
    });
  }
  return esptoolModule;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * esptool-js's terminal, adapted to a line log.
 *
 * It calls write() with fragments — "Connecting...", then a "." or "_" per retry, then
 * "\n\r" — and writeLine() with whole lines. Fragments are held until a line break so the log
 * does not fill with one-word lines, and the retry spinners are dropped outright.
 */
function makeTerminal(onLog) {
  let partial = '';
  const emit = (s) => {
    const line = s.replace(/\r/g, '').trim();
    if (line && !/^[._]+$/.test(line)) onLog?.(line);
  };
  return {
    clean() {},
    write(s) {
      partial += String(s);
      if (/[\n\r]/.test(partial)) {
        const parts = partial.split(/[\n\r]+/);
        partial = parts.pop();
        parts.forEach(emit);
      }
    },
    writeLine(s) {
      emit(partial + String(s));
      partial = '';
    },
    flush() {
      if (partial.trim()) emit(partial);
      partial = '';
    },
  };
}

/**
 * Release the port without letting it fail the flash.
 *
 * After a hard reset the board re-enumerates as its TinyUSB self and the port we hold is gone:
 * close() rejects, and esptool-js's waitForUnlock() has no ceiling. The write already finished
 * by then, so this is raced against a timer and any error is swallowed.
 */
async function disconnectQuietly(transport) {
  if (!transport) return;
  try {
    await Promise.race([transport.disconnect(), sleep(2000)]);
  } catch { /* port already gone — that is the expected way out */ }
}

/**
 * Sort a thrown error into one of the outcomes describeFlashError() knows.
 *
 * By name and message, never instanceof: the bundle does not export its ESPError class, and
 * the interesting ones are DOMExceptions from Web Serial anyway.
 */
function classify(err, phase) {
  const name = err?.name || '';
  const msg = err?.message || String(err ?? '');
  if (name === 'NotFoundError') return { error: 'cancelled', message: msg };
  if (name === 'NetworkError' || name === 'InvalidStateError' || /failed to open/i.test(msg)) {
    return { error: 'port-busy', message: msg };
  }
  if (/unexpected chip magic/i.test(msg)) return { error: 'unknown-chip', message: msg };
  if (phase === 'connect' && /failed to connect|wrong boot mode|timeout|no sync|timed out/i.test(msg)) {
    return { error: 'no-sync', message: msg };
  }
  if (phase === 'write') return { error: 'write-failed', message: msg };
  if (phase === 'connect') return { error: 'no-sync', message: msg };
  return { error: 'load-failed', message: msg };
}

/** The one sentence A6-A shows for a failed result. */
export function describeFlashError(res) {
  switch (res?.error) {
    case 'unsupported': return 'This browser cannot talk to a serial port.';
    case 'cancelled': return 'No port chosen.';
    case 'port-busy': return 'The port is in use — close the Arduino serial monitor, screen, Mu or Thonny, then try again.';
    case 'no-sync': return 'The board did not answer. Put it in bootloader mode — hold BOOT, tap RESET, release BOOT — then Connect again.';
    case 'unknown-chip': return 'That is not a chip this firmware supports.';
    case 'chip-mismatch': return res.message || 'The board is not the chip this firmware was built for.';
    case 'write-failed': return 'Writing stopped partway — the board is not bootable. Power-cycle it, re-enter bootloader mode and flash again.';
    case 'load-failed': return res?.message ? `Could not start the flasher: ${res.message}` : 'Could not load the flasher module.';
    default: return res?.message || 'Flashing failed.';
  }
}

/**
 * Connect, check the chip, write the image, reset.
 *
 *   firmware   { name, size, bytes } from loadFirmware(), already validated
 *   expect     firmwareFor(device), or null to skip the chip check
 *   eraseAll   full-chip erase before the write. OFF by default and opt-in on screen: the
 *              firmware never formats its FAT partition, so an erase takes the MARQUEE drive
 *              with it, and on the X4 Pro also the factory panel calibration in NVS.
 *   baud       the rate after the stub is running. 460800 rather than 921600 — nominal over
 *              native USB, but the change-baud handshake is where a flaky link shows itself.
 */
export async function flashDevice({
  firmware, expect = null, eraseAll = false, baud = 460800, onLog, onProgress,
} = {}) {
  if (!serialSupported()) return { ok: false, error: 'unsupported' };
  if (!firmware?.bytes) return { ok: false, error: 'load-failed', message: 'No firmware loaded.' };

  let mod;
  try {
    mod = await loadEsptool();
  } catch (err) {
    return { ok: false, error: 'load-failed', message: err?.message || String(err) };
  }

  // Outside the try/finally below: there is no transport to release yet, and a cancelled
  // picker is the one outcome that is not an error.
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    return { ok: false, ...classify(err, 'pick') };
  }

  const terminal = makeTerminal(onLog);
  const transport = new mod.Transport(port, false);
  const loader = new mod.ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal });

  let chip = null;
  let phase = 'connect';
  try {
    onLog?.(`Connecting… (${firmware.name}, ${firmware.size} bytes)`);
    const chipDesc = await loader.main();
    terminal.flush();
    chip = loader.chip?.CHIP_NAME || chipDesc;

    if (expect && chip !== expect.chip) {
      return {
        ok: false,
        error: 'chip-mismatch',
        chip,
        message: `Found an ${chip}, but the ${expect.label} firmware needs an ${expect.chip}. Pick the artifact for this board.`,
      };
    }

    phase = 'write';
    onProgress?.({ phase: 'erase', state: eraseAll ? 'busy' : 'skipped', pct: 0 });
    onProgress?.({ phase: 'write', state: 'idle', pct: 0 });
    if (eraseAll) onLog?.('Erasing the whole chip first — this takes a while and reports nothing until it is done.');

    let first = true;
    await loader.writeFlash({
      fileArray: [{ data: firmware.bytes, address: 0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll,
      compress: true,
      // `written` and `total` count COMPRESSED bytes, so they are only good for a ratio.
      reportProgress(_index, written, total) {
        if (first) {
          first = false;
          if (eraseAll) onProgress?.({ phase: 'erase', state: 'done', pct: 100 });
        }
        const pct = total ? (written / total) * 100 : 0;
        onProgress?.({ phase: 'write', state: pct >= 100 ? 'done' : 'active', pct });
      },
    });
    terminal.flush();
    onProgress?.({ phase: 'write', state: 'done', pct: 100 });
    onLog?.(`Wrote ${firmware.size} bytes at 0x0.`);

    // The S2 ROM talks USB-OTG CDC; the S3 ROM talks USB-Serial/JTAG. Either way the port is
    // about to vanish as the board comes up as its TinyUSB self, so a throw here is news, not
    // failure — the write is already on the chip.
    try {
      await loader.after('hard_reset', chip === 'ESP32-S2');
      onLog?.('Reset sent. If the board does not restart on its own, press RESET.');
    } catch {
      onLog?.('Reset sent; the port closed as the board restarted.');
    }
    return { ok: true, chip, chipDesc };
  } catch (err) {
    terminal.flush();
    const out = classify(err, phase);
    onLog?.(`Error: ${out.message}`);
    return { ok: false, chip, ...out };
  } finally {
    await disconnectQuietly(transport);
  }
}
