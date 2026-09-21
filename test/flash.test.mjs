// flash.js's board table, validation and write-piece logic. Nothing here touches a serial port:
// flashDevice() is not exercised (it needs navigator.serial and the esptool bundle), the pure
// parts around it are. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firmwareFor, validateFirmware, imageToWrite, readPartitions, findPartitionAt, headerFlashSize,
  describeFlashError, FIRMWARE_ARTIFACT,
} from '../public/js/device/flash.js';

const APP_OFFSET = 0x10000;

/** One 32-byte ESP-IDF partition entry. */
function partition(type, subtype, offset, size, label) {
  const e = new Uint8Array(32);
  const v = new DataView(e.buffer);
  e[0] = 0xaa; e[1] = 0x50; e[2] = type; e[3] = subtype;
  v.setUint32(4, offset, true); v.setUint32(8, size, true);
  e.set(new TextEncoder().encode(label), 12);
  return e;
}

/** The X4 Pro layout, as partitions.bin on the firmware branch has it. */
const X4_TABLE = [
  partition(0x01, 0x02, 0x9000, 0x5000, 'nvs'),
  partition(0x01, 0x00, 0xe000, 0x2000, 'otadata'),
  partition(0x00, 0x10, 0x10000, 0x400000, 'ota_0'),
  partition(0x00, 0x11, 0x410000, 0x400000, 'ota_1'),
  partition(0x00, 0x00, 0x810000, 0x40000, 'uf2'),
  partition(0x01, 0x81, 0x850000, 0x7b0000, 'ffat'),
];

/**
 * A merged image the way merge-bin lays one down: bootloader header at `bootloaderOffset`
 * (with the flash-size nibble, or none), the table at 0x8000, boot_app0's first bytes at
 * 0xE000, an app (0xE9 then a byte pattern) from 0x10000 to the end, 0xFF everywhere else.
 */
function mergedImage({ bootloaderOffset = 0, table = X4_TABLE, appBytes = 300 * 1024, sizeNibble = null, bootApp0 = true } = {}) {
  const b = new Uint8Array(APP_OFFSET + appBytes).fill(0xff);
  b[bootloaderOffset] = 0xe9;
  if (sizeNibble !== null) b[bootloaderOffset + 3] = (sizeNibble << 4) | 0x0f;
  table.forEach((e, i) => b.set(e, 0x8000 + i * 32));
  if (bootApp0) b.set([0x01, 0x00, 0x00, 0x00], 0xe000);
  b[APP_OFFSET] = 0xe9;
  for (let i = APP_OFFSET + 1; i < b.length; i++) b[i] = i & 0xff;
  return b;
}

const fw = (bytes, name = FIRMWARE_ARTIFACT) => ({ name, size: bytes.length, bytes });
const x4 = () => firmwareFor({ flow: { selectedPanel: 'x4pro' } });
const magtag = () => firmwareFor({ flow: { selectedPanel: 'magtag' } });
const feather = () => firmwareFor({ flow: { selectedPanel: 'tricolorFW' } });

test('firmwareFor: every board gets the whole image; only the X4 Pro forbids the erase', () => {
  assert.equal(x4().allowErase, false);
  assert.equal(x4().chip, 'ESP32-S3');
  assert.equal(x4().flashSize, 16 << 20);
  assert.equal(magtag().allowErase, true);
  assert.equal(feather().allowErase, true);
  assert.equal(feather().board, 'adafruit_feather_esp32s3');
  assert.equal('writeOffset' in x4(), false);
  assert.equal(firmwareFor({}), null);
});

test('readPartitions / findPartitionAt: read the table back out of the image', () => {
  const b = mergedImage();
  assert.equal(readPartitions(b).length, X4_TABLE.length);
  assert.deepEqual(readPartitions(b).map((p) => p.label), ['nvs', 'otadata', 'ota_0', 'ota_1', 'uf2', 'ffat']);
  const p = findPartitionAt(b, APP_OFFSET);
  assert.deepEqual(p, { type: 0, subtype: 0x10, offset: APP_OFFSET, size: 0x400000, label: 'ota_0' });
  assert.equal(findPartitionAt(b, 0x9000).label, 'nvs');
  assert.equal(findPartitionAt(b, 0x12345), null);
});

test('imageToWrite: skips the blank nvs partition and writes everything else at its address', () => {
  const b = mergedImage();
  const { segments, skipped, written } = imageToWrite(fw(b));
  assert.deepEqual(skipped, [{ address: 0x9000, length: 0x5000, label: 'nvs' }]);
  assert.deepEqual(segments.map((s) => [s.address, s.data.length]), [
    [0x0, 0x9000],                // bootloader + table
    [0xe000, b.length - 0xe000],  // boot_app0 + app, contiguous
  ]);
  assert.equal(written, b.length - 0x5000);
  // The bytes are views into the image, not copies.
  assert.equal(segments[1].data[APP_OFFSET - 0xe000], 0xe9);
  assert.equal(segments[1].data.buffer, b.buffer);
});

test('imageToWrite: a blank otadata is skipped too; a blank APP partition is not', () => {
  // No boot_app0: otadata is all 0xFF, so two gaps and three pieces.
  const noOta = mergedImage({ bootApp0: false });
  const r = imageToWrite(fw(noOta));
  assert.deepEqual(r.skipped.map((s) => s.label), ['nvs', 'otadata']);
  assert.deepEqual(r.segments.map((s) => s.address), [0x0, APP_OFFSET]);

  // An app partition that is all 0xFF in the file still gets written (the table says app).
  const table = [partition(0x00, 0x10, 0x9000, 0x5000, 'ota_0'), ...X4_TABLE.slice(1)];
  const appBlank = mergedImage({ table });
  assert.deepEqual(imageToWrite(fw(appBlank)).skipped, []);
  assert.equal(imageToWrite(fw(appBlank)).segments.length, 1);
});

test('imageToWrite: partitions past the end of the file are ignored; no bytes, no pieces', () => {
  const b = mergedImage();                       // ota_1, uf2, ffat all start past the end
  assert.equal(imageToWrite(fw(b)).skipped.length, 1);
  assert.deepEqual(imageToWrite({ bytes: null }), { segments: [], skipped: [], written: 0 });
  assert.deepEqual(imageToWrite(null), { segments: [], skipped: [], written: 0 });
});

test('imageToWrite: a file with no partition table is one piece at 0', () => {
  const b = new Uint8Array(0x20000).fill(0xff);
  b[0] = 0xe9;
  const r = imageToWrite(fw(b));
  assert.deepEqual(r.segments.map((s) => [s.address, s.data.length]), [[0, b.length]]);
  assert.equal(r.written, b.length);
});

test('headerFlashSize: reads the nibble merge-bin stamps, 0 when absent', () => {
  assert.equal(headerFlashSize(mergedImage({ sizeNibble: 0x4 }), 0), 16 << 20);
  assert.equal(headerFlashSize(mergedImage({ sizeNibble: 0x2 }), 0), 4 << 20);
  assert.equal(headerFlashSize(mergedImage(), 0), 0);                     // 0xFF nibble: unknown
  assert.equal(headerFlashSize(mergedImage({ bootloaderOffset: 0x1000, sizeNibble: 0x2 }), 0x1000), 4 << 20);
  assert.equal(headerFlashSize(mergedImage({ bootloaderOffset: 0x1000 }), 0), 0);  // no 0xE9 at 0
});

test('validateFirmware: accepts the X4 Pro merged image', () => {
  const res = validateFirmware(fw(mergedImage({ sizeNibble: 0x4 })), x4());
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
  // An image with no size stamped is not rejected for it.
  assert.equal(validateFirmware(fw(mergedImage()), x4()).ok, true);
});

test('validateFirmware: the 4 MB Feather image is refused for the 16 MB X4 Pro, and the reverse', () => {
  const featherImg = mergedImage({ sizeNibble: 0x2 });
  let res = validateFirmware(fw(featherImg), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /Built for a 4 MB chip; the Xteink X4 Pro has 16 MB/);

  const x4Img = mergedImage({ sizeNibble: 0x4 });
  res = validateFirmware(fw(x4Img), feather());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /Built for a 16 MB chip; the Feather ESP32-S3 has 4 MB/);
  assert.equal(validateFirmware(fw(featherImg), feather()).ok, true);
});

test('validateFirmware: no bootloader header at the board offset is refused', () => {
  const b = mergedImage();
  b[0] = 0xff;
  const res = validateFirmware(fw(b), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /No bootloader at 0x0/);
});

test('validateFirmware: a bare firmware.bin (no table at 0x8000) is refused', () => {
  const app = new Uint8Array(300 * 1024).fill(0x55);
  app[0] = 0xe9;
  const res = validateFirmware(fw(app), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /No partition table at 0x8000/);
});

test('validateFirmware: the MagTag path', () => {
  const b = mergedImage({ bootloaderOffset: 0x1000, sizeNibble: 0x2 });
  assert.equal(validateFirmware(fw(b), magtag()).ok, true);
  const s3 = mergedImage({ sizeNibble: 0x2 });
  const res = validateFirmware(fw(s3), magtag());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /not the MagTag build/);
});

test('describeFlashError: erase-unsafe has a sentence', () => {
  assert.ok(describeFlashError({ error: 'erase-unsafe' }).length > 0);
});
