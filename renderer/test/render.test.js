/**
 * The server renderer — renderer/render.js, on the real Konva and skia-canvas.
 *
 * The snapshot pins one scene's exact bytes, so a change to lib/, the fonts, Konva or
 * skia-canvas that moves a pixel shows up here. Whether those pixels match the editor's is a
 * browser question this suite can't answer; compare "See it dithered" with a render by eye
 * when any of those change. Update the snapshot with `npm run test:update`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FontLibrary } from 'skia-canvas';

import { render, atTime, plan, MAX_SIDE } from '../render.js';
import { handler } from '../lambda.js';
import { FONT_FILES } from '../../public/js/lib/fonts.js';

const INK = '#2F2429', RED = '#D72627';
const display = { width: 128, height: 296, rotation: 0, panel: 'magtag', type: 'tricolor', dither: 'none', background: '#F2F4EF' };
// 2×2 red PNG, made by skia-canvas
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAsSAAALEgHS3X78AAAAAXNSR0IArs4c6QAAAARzQklUCAgICHwIZIgAAAAUSURBVAiZY7yupv6fgYGBgYkBCgAhGAInj0C5pwAAAABJRU5ErkJggg==';

const scene = (elements, extra = {}) => ({ version: 1, display: { background: '#F2F4EF' }, elements, ...extra });

const EVERYTHING = scene([
  { etype: 'label', x: 4, y: 4, text: '21.5C', fontSize: 16, fontFamily: 'IBM Plex Mono', fill: INK, feedKey: 'temp', feedValue: '21.47', feedDecimals: 1, feedSuffix: 'C' },
  { etype: 'datetime', x: 4, y: 26, timeFmt: '%H:%M', timeTz: 'UTC', fill: INK, fontSize: 12, fontFamily: 'IBM Plex Sans' },
  { etype: 'divider', x: 4, y: 44, width: 120, height: 2, fill: RED },
  { etype: 'linechart', x: 100, y: 50, w: 180, h: 60, ink: INK, title: 'Temp', data: [64, 63, 60, 64, 67, 71, 72, 75, 80, 80, 82, 78], axisFontFamily: 'IBM Plex Serif' },
  { etype: 'gauge', x: 4, y: 50, w: 80, ink: INK, gaugeValue: '42', gaugeLabel: 'mph', showIcon: true, icon: 'wind' },
  { etype: 'indicator', x: 260, y: 4, w: 16, ink: INK, onColor: RED, offColor: '#F2F4EF', op: 'gt', cmp: '1', value: '2' },
  { etype: 'battery', x: 230, y: 30, w: 40, ink: INK, showPct: true, feedValue: '80' },
  { etype: 'image', x: 240, y: 90, w: 20, h: 20, natW: 2, natH: 2, src: PIXEL },
]);
const NOON = Date.UTC(2026, 9, 12, 12, 0);

const header = (base64) => {
  const bmp = Buffer.from(base64, 'base64');
  return { magic: bmp.subarray(0, 2).toString(), width: bmp.readInt32LE(18), height: bmp.readInt32LE(22), bpp: bmp.readUInt16LE(28) };
};

/** How many pixels of a rendered BMP are each colour, as '#RRGGBB' keys. Palette BMPs only. */
const countColors = ({ base64 }) => {
  const bmp = Buffer.from(base64, 'base64');
  const width = bmp.readInt32LE(18), height = Math.abs(bmp.readInt32LE(22));
  const bpp = bmp.readUInt16LE(28), dataAt = bmp.readUInt32LE(10);
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  const palette = [];
  for (let o = 14 + bmp.readUInt32LE(14); o < dataAt; o += 4) {   // B, G, R, 0
    palette.push(`#${hex(bmp[o + 2])}${hex(bmp[o + 1])}${hex(bmp[o])}`);
  }
  const rowBytes = Math.ceil((width * bpp) / 32) * 4;
  const counts = {};
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * bpp;
      const byte = bmp[dataAt + y * rowBytes + (bit >> 3)];
      const index = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
      counts[palette[index]] = (counts[palette[index]] || 0) + 1;
    }
  }
  return counts;
};

test('every element type renders to a BMP the size of the panel', async () => {
  const out = await render({ doc: EVERYTHING, display, now: NOON });
  // a MagTag at rotation 0 is landscape
  assert.deepEqual([out.width, out.height], [296, 128]);
  assert.deepEqual(header(out.base64), { magic: 'BM', width: 296, height: 128, bpp: 4 });
  assert.equal(out.bytes, Buffer.from(out.base64, 'base64').length);
  assert.match(out.sha, /^[0-9a-f]{64}$/);
});

test('the same document renders to the same bytes', async (t) => {
  const a = await render({ doc: EVERYTHING, display, now: NOON });
  const b = await render({ doc: EVERYTHING, display, now: NOON });
  assert.equal(a.sha, b.sha);
  t.assert.snapshot(a.sha);
});

test('date & time: the element\'s zone, else the account\'s, else UTC', () => {
  const doc = scene([
    { etype: 'datetime', timeFmt: '%H:%M', timeTz: 'Asia/Tokyo' },
    { etype: 'datetime', timeFmt: '%H:%M', timeTz: '' },
    { etype: 'label', text: 'untouched' },
  ]);
  const at = (timeZone) => atTime(doc, { now: NOON, timeZone }).elements.map((el) => el.timeValue ?? el.text);
  assert.deepEqual(at('America/New_York'), ['21:00', '08:00', 'untouched']);
  assert.deepEqual(at('Not/AZone'), ['21:00', '12:00', 'untouched']);
});

test('the bundled faces are registered, and a picture changes with the font', async () => {
  const label = (fontFamily) => scene([{ etype: 'label', x: 4, y: 4, text: 'Hello 123', fontSize: 24, fontFamily, fill: INK }]);
  const mono = await render({ doc: label('IBM Plex Mono'), display });
  const serif = await render({ doc: label('IBM Plex Serif'), display });
  for (const { family } of FONT_FILES) assert.ok(FontLibrary.has(family), family);
  assert.notEqual(mono.sha, serif.sha);
});

test('an image is decoded from its data URL; an undecodable one is left out', async () => {
  const image = (src) => scene([{ etype: 'image', x: 0, y: 0, w: 40, h: 40, natW: 2, natH: 2, src }]);
  const blank = await render({ doc: scene([]), display });
  const drawn = await render({ doc: image(PIXEL), display });
  const broken = await render({ doc: image('data:image/png;base64,bm90IGFuIGltYWdl'), display });
  assert.notEqual(drawn.sha, blank.sha);
  assert.equal(broken.sha, blank.sha);
});

test('a feed image draws the picture read from its feed, and its placeholder without one (#36)', async () => {
  const frame = scene([{ etype: 'feedimage', x: 0, y: 0, w: 40, h: 40, fit: 'stretch', feedKey: 'cam', src: 'feed:cam' }]);
  const b64 = PIXEL.slice(PIXEL.indexOf(',') + 1);
  assert.deepEqual(plan({ doc: frame }).reads, [{ id: 'cam', feed: 'cam', kind: 'last' }]);
  const blank = await render({ doc: scene([]), display });
  const empty = await render({ doc: frame, display });
  const notAPicture = await render({ doc: frame, readings: { last: { cam: '21.5' } }, display });
  const drawn = await render({ doc: frame, readings: { last: { cam: b64 } }, display });
  assert.notEqual(empty.sha, blank.sha, 'an empty frame is drawn, not left out');
  assert.equal(notAPicture.sha, empty.sha);
  assert.notEqual(drawn.sha, empty.sha);
  // The reference is never fetched, whatever it says.
  const hostile = scene([{ etype: 'feedimage', x: 0, y: 0, w: 40, h: 40, feedKey: '', src: 'http://169.254.169.254/' }]);
  assert.equal((await render({ doc: hostile, display })).sha, empty.sha);
});

test('a linked label with no reading draws its no-data state, even black on a black page (#24)', async () => {
  // The request's display is the panel, with no page colour: the page is the document's.
  const { background, ...panel } = { ...display, type: 'mono' };
  const BLACK = INK;   // the mono panel's black
  const onBlack = (elements) => scene(elements, { display: { background: BLACK } });
  const label = { etype: 'label', x: 4, y: 4, fontSize: 24, fill: BLACK, feedKey: 'temp', feedValue: null };
  const blank = await render({ doc: onBlack([]), display: panel });
  const empty = await render({ doc: onBlack([label]), display: panel });
  // Black text on a black page would leave the page as it was. The no-data state does not.
  assert.notEqual(empty.sha, blank.sha, 'the empty label shows on a black page');
  const read = await render({ doc: onBlack([label]), readings: { last: { temp: '21' } }, display: panel });
  assert.notEqual(read.sha, empty.sha);
  // With a reading, black on black is what the user drew, and the page is all there is.
  assert.equal(read.sha, blank.sha);
  // A plain label with the same text is not a placeholder: '?' alone, with no outline.
  const plain = await render({ doc: onBlack([{ ...label, feedKey: '', text: '?' }]), display: panel });
  assert.equal(plain.sha, blank.sha);
});

test('a linked label with no reading is marked in red on a tricolor panel', async () => {
  const label = { etype: 'label', x: 4, y: 4, fontSize: 24, fill: INK, feedKey: 'temp', feedValue: null };
  const count = async (el) => countColors(await render({ doc: scene([el]), display }));
  const empty = await count(label);
  // The same '?' unlinked, in ink and in red. Antialiased edges snap to the nearest panel
  // colour, so a few pixels of the other colour turn up in either; the margins allow that.
  const inInk = await count({ ...label, feedKey: '', text: '?' });
  const inRed = await count({ ...label, feedKey: '', text: '?', fill: RED });
  assert.ok(empty[RED] > 5 * (inInk[RED] ?? 0), `the mark is red: ${empty[RED]} red px vs ${inInk[RED]}`);
  assert.ok(empty[INK] > (inRed[INK] ?? 0) + 15, `and outlined in ink: ${empty[INK]} ink px vs ${inRed[INK]}`);
});

test('the display decides the palette: mono comes out 1 bit per pixel', async () => {
  const out = await render({ doc: EVERYTHING, display: { ...display, type: 'mono' }, now: NOON });
  assert.equal(header(out.base64).bpp, 1);
});

test('a bad request is an error, and the Lambda handler returns it rather than throwing', async () => {
  await assert.rejects(render({ doc: { elements: [] }, display }), /version 1/);
  await assert.rejects(render({ doc: scene([]), display: { width: 10 } }), /display/);
  assert.match((await handler({ doc: null })).error, /version 1/);
  assert.equal((await handler(JSON.stringify({ doc: scene([]), display }))).width, 296);
});

test('readings are written in before rendering; a missing one keeps the saved value', async () => {
  const doc = scene([
    { etype: 'label', x: 4, y: 4, fontSize: 24, fill: INK, feedKey: 'temp', feedValue: '20' },
    { etype: 'linechart', x: 4, y: 40, w: 200, h: 80, ink: INK, feeds: [{ key: 'temp' }], hours: 6, series: {} },
  ]);
  const saved = await render({ doc, display });
  assert.equal((await render({ doc, readings: {}, display })).sha, saved.sha);
  assert.equal((await render({ doc, readings: { last: { temp: null } }, display })).sha, saved.sha);

  const fresh = await render({ doc, readings: { last: { temp: '99' } }, display });
  assert.notEqual(fresh.sha, saved.sha);
  // The same reading baked into the document by hand draws the same picture.
  const baked = await render({ doc: { ...doc, elements: [{ ...doc.elements[0], feedValue: '99' }, doc.elements[1]] }, display });
  assert.equal(fresh.sha, baked.sha);

  const chart = { columns: ['date', 'value'], data: [['2026-10-12T10:00:00Z', '1'], ['2026-10-12T11:00:00Z', '5']] };
  const charted = await render({ doc, readings: { chart: { 'temp@6h': chart } }, display });
  assert.notEqual(charted.sha, saved.sha);
});

test('plan: what a document reads, through the handler too', async () => {
  const doc = scene([
    { etype: 'gauge', feedKey: 'wind' },
    { etype: 'linechart', feeds: [{ key: 'alice/hum' }], rawOnly: true },
    { etype: 'datetime' },
  ]);
  const expected = {
    reads: [
      { id: 'wind', feed: 'wind', kind: 'last' },
      { id: 'alice/hum@24h/raw', feed: 'alice/hum', kind: 'chart', hours: 24, raw: true, limit: 640 },
    ],
    datetime: true,
  };
  assert.deepEqual(plan({ doc }), expected);
  assert.deepEqual(await handler({ op: 'plan', doc }), expected);
  assert.match((await handler({ op: 'plan', doc: {} })).error, /version 1/);
  assert.match((await handler({ op: 'nope', doc })).error, /unknown op/);
});

test('hostile input: only data: images, and only panels the editor could make', async () => {
  const image = (src) => scene([{ etype: 'image', x: 0, y: 0, w: 40, h: 40, natW: 2, natH: 2, src }]);
  const blank = await render({ doc: scene([]), display });
  for (const src of ['http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', '/etc/passwd']) {
    assert.equal((await render({ doc: image(src), display })).sha, blank.sha, src);
  }
  await assert.rejects(render({ doc: scene([]), display: { ...display, width: MAX_SIDE + 1 } }), /pixels a side/);
  await assert.rejects(render({ doc: scene([]), display: { ...display, height: 4.5 } }), /pixels a side/);
  await assert.rejects(render({ doc: scene([]), display: { ...display, type: 'rainbow' } }), /unknown display type/);
});

test('a chart\'s time axis reads in the account\'s zone, never the server\'s', async () => {
  const doc = scene([{ etype: 'linechart', x: 4, y: 4, w: 280, h: 110, ink: INK, feeds: [{ key: 't' }], hours: 6,
    series: { t: [{ t: '2026-10-12T10:00:00Z', v: 1 }, { t: '2026-10-12T14:00:00Z', v: 5 }] } }]);
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'America/Chicago';
    const a = await render({ doc, display, timeZone: 'Europe/Berlin' });
    process.env.TZ = 'Asia/Tokyo';
    const b = await render({ doc, display, timeZone: 'Europe/Berlin' });
    const c = await render({ doc, display, timeZone: 'America/New_York' });
    assert.equal(a.sha, b.sha);
    assert.notEqual(b.sha, c.sha);
    // An unknown zone is UTC, not an error.
    assert.equal((await render({ doc, display, timeZone: 'Mars/Olympus' })).sha, (await render({ doc, display, timeZone: 'UTC' })).sha);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
