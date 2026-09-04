/**
 * Writing firmware to a board over WebSerial.
 *
 * NOT IMPLEMENTED IN THIS BUILD. This file is the seam and the contract, so that A6-A
 * can be built, reviewed and navigated for real while the write path is still open.
 *
 * It does not pretend. There is no simulated chip detection, no timed progress bar and
 * no fake success — a screen that mimes a flash is worse than one that says it cannot
 * do it yet, because the second is obviously incomplete and the first is a bug report
 * about a board that never got written.
 *
 * WHAT AN IMPLEMENTATION NEEDS
 *
 *   1. esptool-js, vendored into js/vendor/ alongside konva.js. There is no build step
 *      here: modules are served straight to the browser, so it has to arrive as
 *      something a <script> or a bare `import` can load.
 *   2. Firmware binaries, which do not exist in this repo. Whatever supplies them —
 *      a manifest URL, a release asset, a checked-in bin — resolves inside
 *      firmwareFor() below, keyed by the board the panel preset implies.
 *   3. The two payloads A6-A's copy promises: the firmware, and the board's
 *      configuration file. The second already exists — `rec.cfg` on the device record,
 *      built by device/cfg.js in the exact shape of cfg-marquee.json (account, group
 *      key, panel, pins, network). See docs/cfg-marquee.md.
 *
 * THE CONTRACT
 *
 *   flashDevice({ device, cfg, onLog, onProgress }) -> Promise<{ ok, chip?, error? }>
 *
 *   device      the record from devices.js — panel, group key, name
 *   cfg         the cfg-marquee.json object to write, freshly synced by the caller.
 *               It carries the Wi-Fi password and the Adafruit IO key: write it to the
 *               board, do not log it, and do not put it in an error message.
 *   onLog       (line: string) => void, one serial log line
 *   onProgress  ({ phase: 'erase'|'write', pct: number }) => void
 *
 * Resolves rather than throws, for the reason provision.js does: the caller has to
 * distinguish "no port chosen" from "wrong chip" from "write failed halfway", and a
 * thrown Error flattens all three into a catch block.
 */

/** Is this browser capable of talking to a serial port at all? */
export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Which firmware image a device needs. Resolves nothing yet — see the note above.
 * Keyed off the panel preset, because that is what tells us the host board.
 */
export function firmwareFor(_device) {
  return null;
}

export async function flashDevice({ onLog } = {}) {
  onLog?.('Flashing is not wired up in this build.');
  onLog?.('The connect, erase and write path needs esptool-js and a firmware image; '
    + 'neither is in this repo yet. See the note at the top of js/device/flash.js.');
  onLog?.('If your board is already running the marquee firmware, use '
    + '"Skip, my board is already flashed" to carry on.');
  return { ok: false, error: 'not-implemented' };
}
