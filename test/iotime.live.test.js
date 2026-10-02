/**
 * The Adafruit IO Time API, for real — public/js/device/iotime.js against io.adafruit.com.
 *
 * Needs the network but no credentials (/time/millis is unauthenticated), so it is
 * opt-in to keep `npm test` offline by default:
 *
 *   IO_LIVE=1 npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIME_PRESETS, strftime } from '../public/js/core/timefmt.js';
import { readIoMillis, readIoTime } from '../public/js/device/iotime.js';

const skip = !process.env.IO_LIVE && 'set IO_LIVE=1 to run';

// iotime logs one line per request; keep the test output readable.
const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

test('IO answers /time/millis with a sane epoch', { skip }, async () => {
  const ms = await quiet(readIoMillis);
  assert.ok(Number.isFinite(ms), String(ms));
  // Within a few minutes of this machine — catches seconds-vs-millis mixups.
  assert.ok(Math.abs(ms - Date.now()) < 5 * 60e3, `IO ${ms} vs local ${Date.now()}`);
});

test('the browser can read it: CORS is open on /time/millis', { skip }, async () => {
  const res = await fetch('https://io.adafruit.com/api/v2/time/millis', { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('every preset renders from IO time, in every zone', { skip }, async () => {
  const ms = await quiet(readIoMillis);
  for (const tz of ['', 'UTC', 'America/New_York', 'Asia/Tokyo']) {
    for (const p of TIME_PRESETS) {
      const s = strftime(ms, p.fmt, tz);
      assert.ok(typeof s === 'string' && s.length > 0 && !s.includes('%'), `${p.id} in ${tz || 'auto'} → ${s}`);
    }
  }
  const s = await quiet(() => readIoTime({ fmt: TIME_PRESETS.find((p) => p.id === 'updated').fmt }));
  assert.match(s, /^Last Updated: \d{1,2}:\d{2} (AM|PM)$/);
  const f = await quiet(() => readIoTime({ fmt: TIME_PRESETS.find((p) => p.id === 'updatedfull').fmt }));
  assert.match(f, /^Last Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
