// flash.js's board table, validation and write-slice logic. Nothing here touches a serial port:
// flashDevice() is not exercised (it needs navigator.serial and the esptool bundle), the pure
// parts around it are. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firmwareFor, validateFirmware, imageToWrite, findPartitionAt, describeFlashError, FIRMWARE_ARTIFACT,
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
];

/**
 * A merged image: 0xE9 at `bootloaderOffset`, the table at 0x8000, an app (0xE9 then a byte
 * pattern) from 0x10000 to the end.
 */
function mergedImage({ bootloaderOffset = 0, table = X4_TABLE, appBytes = 4096 } = {}) {
  const b = new Uint8Array(APP_OFFSET + appBytes).fill(0xff);
  b[bootloaderOffset] = 0xe9;
  table.forEach((e, i) => b.set(e, 0x8000 + i * 32));
  b[APP_OFFSET] = 0xe9;
  for (let i = APP_OFFSET + 1; i < b.length; i++) b[i] = i & 0xff;
  return b;
}

const fw = (bytes, name = FIRMWARE_ARTIFACT) => ({ name, size: bytes.length, bytes });
const x4 = () => firmwareFor({ flow: { selectedPanel: 'x4pro' } });
const magtag = () => firmwareFor({ flow: { selectedPanel: 'magtag' } });

test('firmwareFor: only the X4 Pro is written at an offset', () => {
  assert.equal(x4().writeOffset, APP_OFFSET);
  assert.equal(x4().chip, 'ESP32-S3');
  assert.equal(magtag().writeOffset, 0);
  assert.equal(firmwareFor({ flow: { selectedPanel: 'tricolorFW' } }).writeOffset, 0);
  assert.equal(firmwareFor({ flow: { selectedPanel: 'tricolorFW' } }).board, 'adafruit_feather_esp32s3');
  assert.equal(firmwareFor({}), null);
});

test('imageToWrite: whole image at 0 for the MagTag, the tail at 0x10000 for the X4 Pro', () => {
  const bytes = mergedImage({ bootloaderOffset: 0x1000 });
  const whole = imageToWrite(fw(bytes), magtag());
  assert.equal(whole.address, 0);
  assert.equal(whole.data, bytes);

  const bytes2 = mergedImage();
  const slice = imageToWrite(fw(bytes2), x4());
  assert.equal(slice.address, APP_OFFSET);
  assert.equal(slice.data.length, bytes2.length - APP_OFFSET);
  assert.deepEqual(slice.data, bytes2.subarray(APP_OFFSET));
  assert.equal(slice.data[0], 0xe9);

  assert.equal(imageToWrite(fw(bytes2), null).address, 0);
  assert.equal(imageToWrite({ bytes: null }, x4()).data, null);
});

test('findPartitionAt: reads the entry back out of the image', () => {
  const b = mergedImage();
  const p = findPartitionAt(b, APP_OFFSET);
  assert.deepEqual(p, { type: 0, subtype: 0x10, offset: APP_OFFSET, size: 0x400000, label: 'ota_0' });
  assert.equal(findPartitionAt(b, 0x9000).label, 'nvs');
  assert.equal(findPartitionAt(b, 0x12345), null);
});

test('validateFirmware: accepts the X4 Pro merged image and the app slice within it', () => {
  // MIN_MERGED_BYTES is 256 KB, so give the app enough room.
  const res = validateFirmware(fw(mergedImage({ appBytes: 300 * 1024 })), x4());
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
});

test('validateFirmware: X4 Pro rejects an image with no app header at 0x10000', () => {
  const b = mergedImage({ appBytes: 300 * 1024 });
  b[APP_OFFSET] = 0x00;
  const res = validateFirmware(fw(b), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /No app image at 0x10000/);
});

test('validateFirmware: X4 Pro rejects a table that does not call 0x10000 an app partition', () => {
  const noEntry = mergedImage({ appBytes: 300 * 1024, table: X4_TABLE.filter((e) => !e.subarray(12).includes(0x5f)) }); // drop ota_*
  let res = validateFirmware(fw(noEntry), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /nothing starting at 0x10000/);

  const dataThere = mergedImage({ appBytes: 300 * 1024, table: [partition(0x01, 0x81, 0x10000, 0x400000, 'ffat')] });
  res = validateFirmware(fw(dataThere), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /"ffat", not an app partition/);

  const tooSmall = mergedImage({ appBytes: 300 * 1024, table: [partition(0x00, 0x10, 0x10000, 0x1000, 'ota_0')] });
  res = validateFirmware(fw(tooSmall), x4());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /larger than the "ota_0" partition/);
});

test('validateFirmware: the MagTag path is unchanged by writeOffset', () => {
  const b = mergedImage({ bootloaderOffset: 0x1000, appBytes: 300 * 1024 });
  assert.equal(validateFirmware(fw(b), magtag()).ok, true);
  const s3 = mergedImage({ appBytes: 300 * 1024 });
  const res = validateFirmware(fw(s3), magtag());
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /not the MagTag build/);
});

test('describeFlashError: erase-unsafe has a sentence', () => {
  assert.ok(describeFlashError({ error: 'erase-unsafe' }).length > 0);
});
