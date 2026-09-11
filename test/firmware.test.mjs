// firmware.js against a stubbed fetch. Node 18+ has fetch, Response, ReadableStream and
// crypto.subtle globally, and public/js/package.json marks the tree as ES modules, so the
// browser module loads here unchanged. Run with `npm test`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchManifest, fetchReleaseFirmware, describeFirmwareError, FIRMWARE_BASE } from '../public/js/device/firmware.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

/** A binary that passes for a merged image: 0xE9 at 0x1000, partition magic at 0x8000. */
function fakeImage(size = 0x9000 + 512) {
  const b = new Uint8Array(size).fill(0xff);
  b[0x1000] = 0xe9; b[0x8000] = 0xaa; b[0x8001] = 0x50;
  for (let i = 0x9000; i < size; i++) b[i] = i & 0xff;
  return b;
}

async function manifestFor(image, { board = 'magtag', sha = null, size = null } = {}) {
  return {
    schema: 1, tag: 'v1.0.0-alpha', version: '1.0.0-alpha', prerelease: true,
    published_at: '2026-09-09T19:11:43Z', commit: 'abc',
    boards: { [board]: {
      bin: `v1.0.0-alpha/marquee-${board}/merged-flash.bin`,
      size: size ?? image.length, sha256: sha ?? await sha256(image), chip: 'ESP32-S2', bootloader_offset: '0x1000',
    } },
  };
}

/** Serve `image` in `chunks` pieces through a ReadableStream, like a real network body. */
function streamed(image, chunks = 4) {
  const step = Math.ceil(image.length / chunks);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= image.length) { controller.close(); return; }
      controller.enqueue(image.slice(i, i + step));
      i += step;
    },
  });
}

/** Route by URL suffix; anything unlisted 404s. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const [suffix, make] of Object.entries(routes)) {
      if (String(url).endsWith(suffix)) return make(init);
    }
    return new Response('nope', { status: 404 });
  };
  return calls;
}

test('fetchManifest: parses a good manifest and uses no-store', async () => {
  const m = await manifestFor(fakeImage());
  const calls = stubFetch({ 'manifest.json': () => Response.json(m) });
  const res = await fetchManifest();
  assert.equal(res.ok, true);
  assert.equal(res.manifest.tag, 'v1.0.0-alpha');
  assert.equal(calls[0].url, `${FIRMWARE_BASE}manifest.json`);
  assert.equal(calls[0].init.cache, 'no-store');
});

test('fetchManifest: derives version from the tag when absent', async () => {
  const m = await manifestFor(fakeImage()); delete m.version;
  stubFetch({ 'manifest.json': () => Response.json(m) });
  const res = await fetchManifest();
  assert.equal(res.manifest.version, '1.0.0-alpha');
});

test('fetchManifest: 404 is not-found, bad schema is bad-manifest, network error is offline', async () => {
  stubFetch({});
  assert.equal((await fetchManifest()).error, 'not-found');
  stubFetch({ 'manifest.json': () => Response.json({ schema: 2, tag: 'x', boards: {} }) });
  assert.equal((await fetchManifest()).error, 'bad-manifest');
  stubFetch({ 'manifest.json': () => new Response('<html>', { status: 200 }) });
  assert.equal((await fetchManifest()).error, 'bad-manifest');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await fetchManifest()).error, 'offline');
});

test('fetchReleaseFirmware: streams, reports progress, verifies sha, returns the image', async () => {
  const image = fakeImage();
  const m = await manifestFor(image);
  stubFetch({ 'merged-flash.bin': () => new Response(streamed(image, 5), { status: 200 }) });
  const progress = [];
  const res = await fetchReleaseFirmware({ manifest: m, board: 'magtag', onProgress: (p) => progress.push(p) });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.name, 'merged-flash.bin');
  assert.equal(res.size, image.length);
  assert.deepEqual(res.bytes, image);
  assert.equal(res.source, 'release');
  assert.equal(res.version, '1.0.0-alpha');
  assert.equal(res.prerelease, true);
  assert.equal(res.chip, 'ESP32-S2');
  assert.ok(progress.length >= 2, 'progress reported per chunk');
  assert.equal(progress.at(-1).received, image.length);
  assert.equal(progress.at(-1).total, image.length);
});

test('fetchReleaseFirmware: wrong sha and short body are both sha-mismatch', async () => {
  const image = fakeImage();
  stubFetch({ 'merged-flash.bin': () => new Response(streamed(image), { status: 200 }) });
  const bad = await manifestFor(image, { sha: '00'.repeat(32) });
  assert.equal((await fetchReleaseFirmware({ manifest: bad, board: 'magtag' })).error, 'sha-mismatch');
  const short = await manifestFor(image, { size: image.length + 10 });
  assert.equal((await fetchReleaseFirmware({ manifest: short, board: 'magtag' })).error, 'sha-mismatch');
});

test('fetchReleaseFirmware: missing board, missing file, abort', async () => {
  const image = fakeImage();
  const m = await manifestFor(image);
  stubFetch({});
  assert.equal((await fetchReleaseFirmware({ manifest: m, board: 'x4pro' })).error, 'no-board');
  assert.equal((await fetchReleaseFirmware({ manifest: m, board: 'magtag' })).error, 'bin-not-found');
  const ctrl = new AbortController(); ctrl.abort();
  assert.equal((await fetchReleaseFirmware({ manifest: m, board: 'magtag', signal: ctrl.signal })).error, 'aborted');
});

test('describeFirmwareError: every code has a sentence, aborted has none', () => {
  for (const error of ['offline', 'not-found', 'bad-manifest', 'no-board', 'bin-not-found', 'sha-mismatch', 'insecure']) {
    assert.ok(describeFirmwareError({ error, message: 'm' }).length > 0, error);
  }
  assert.equal(describeFirmwareError({ error: 'aborted' }), '');
});
