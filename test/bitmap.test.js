/**
 * Byte-identity regression for public/js/canvas/bitmap.js.
 *
 * Every golden in test/fixtures/golden/ was produced by ImageMagick 7.1.2-27 Q16-HDRI
 * (macOS build) with the pipeline the editor used to shell out to:
 *
 *   magick in.png <dither args> -remap test/fixtures/palettes/eink-<type>.png gif:- \
 *     | magick gif:- -compress none BMP3:-
 *
 * Inputs are the raw RGBA bytes of the same PNGs (`magick in.png -depth 8 rgba:-`).
 * File names encode the case: <input>_<w>x<h>__<display>__<mode>.bmp.gz where mode is
 * floyd<N> (diffusion N%), none, or o2/o4/o8 (ordered map). Regenerate with
 * scripts/regen-goldens.sh on a machine that has `magick`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { renderIndexedBmp } from '../public/js/canvas/bitmap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INPUTS = path.join(here, 'fixtures', 'inputs');
const GOLDEN = path.join(here, 'fixtures', 'golden');

// Must match PALETTES in public/js/canvas/palette.js (the test imports nothing from
// the browser-only modules so it can run under plain node).
const PALETTES = {
  mono:      ['#2F2429', '#F2F4EF'],
  gray4:     ['#2F2429', '#70696B', '#B1AFAD', '#F2F4EF'],
  tricolor:  ['#2F2429', '#F2F4EF', '#D72627'],
  quadcolor: ['#2F2429', '#F2F4EF', '#FD2A00', '#FFFF03'],
};

function modeOpts(tag) {
  if (tag === 'none') return { method: 'none' };
  if (tag.startsWith('o')) return { method: 'ordered', orderedMap: Number(tag.slice(1)) };
  return { method: 'floyd', diffusion: Number(tag.replace('floyd', '')) };
}

const inputs = new Map();
for (const f of fs.readdirSync(INPUTS)) {
  const base = f.replace(/\.rgba\.gz$/, '');
  const [w, h] = base.match(/(\d+)x(\d+)$/).slice(1).map(Number);
  inputs.set(base, { w, h, rgba: new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(INPUTS, f)))) });
}

const goldens = fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.bmp.gz')).sort();
assert.ok(goldens.length > 0, 'no goldens found');

for (const f of goldens) {
  const [input, display, tag] = f.replace(/\.bmp\.gz$/, '').split('__');
  test(`${input} ${display} ${tag} is byte-identical to ImageMagick`, () => {
    const { w, h, rgba } = inputs.get(input);
    const want = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(GOLDEN, f))));
    const { bmp } = renderIndexedBmp(rgba, w, h, PALETTES[display], modeOpts(tag));
    assert.equal(bmp.length, want.length, 'BMP size');
    assert.ok(Buffer.compare(Buffer.from(bmp), Buffer.from(want)) === 0, 'BMP bytes differ');
  });
}

test('BMP3 header: mono is 1 bpp with a 2-entry palette', () => {
  const { w, h, rgba } = inputs.get('t1_text_296x128');
  const { bmp } = renderIndexedBmp(rgba, w, h, PALETTES.mono, { method: 'floyd', diffusion: 85 });
  const dv = new DataView(bmp.buffer);
  assert.equal(dv.getUint16(28, true), 1, 'bpp');
  assert.equal(dv.getUint32(30, true), 0, 'BI_RGB');
  assert.equal(dv.getUint32(10, true), 14 + 40 + 4 * 2, 'pixel offset');
  assert.equal(dv.getUint32(46, true), 2, 'biClrUsed');
  assert.equal(dv.getUint32(38, true), 0, 'x pels/m');
  assert.equal(dv.getUint32(2, true), bmp.length, 'file size');
});

test('BMP3 header: colour modes are 4 bpp with a 16-entry palette', () => {
  const { w, h, rgba } = inputs.get('t1_text_296x128');
  const { bmp, colormap } = renderIndexedBmp(rgba, w, h, PALETTES.tricolor, { method: 'none' });
  const dv = new DataView(bmp.buffer);
  assert.equal(dv.getUint16(28, true), 4, 'bpp');
  assert.equal(dv.getUint32(10, true), 14 + 40 + 4 * 16, 'pixel offset');
  assert.equal(dv.getUint32(46, true), 16, 'biClrUsed');
  // Palette order is the octree walk, not PALETTES order.
  assert.deepEqual(colormap, [[0x2F, 0x24, 0x29], [0xD7, 0x26, 0x27], [0xF2, 0xF4, 0xEF]]);
});

test('rejects rasters that do not match the stated size', () => {
  assert.throws(() => renderIndexedBmp(new Uint8Array(4), 2, 2, PALETTES.mono));
});
