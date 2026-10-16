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

import { render, atTime } from '../render.js';
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
