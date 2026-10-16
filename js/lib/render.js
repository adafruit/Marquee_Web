/**
 * Pixels to panel: dither + palette-remap a capture into the BMP3 a board draws, and
 * render a whole canvas.json headlessly. The editor encodes its live stage capture
 * with encodeBitmap; renderScene does the same for a document nobody has open, which
 * is what a server keeping a display live needs.
 */

import { PALETTES } from './palette.js';
import { renderIndexedBmp, RENDER_METHOD } from './bitmap.js';
import { buildScene } from './scene.js';

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * RGBA pixels -> the indexed BMP3 for this panel. `display` supplies the palette
 * (`type`) and the dither settings. Returns the BMP bytes and their base64, plus the
 * indexed pixels and colormap for painting a preview.
 */
export function encodeBitmap(rgba, w, h, display) {
  const { bmp, indices, colormap } = renderIndexedBmp(rgba, w, h, PALETTES[display.type] || PALETTES.mono, {
    method: RENDER_METHOD[display.dither] || 'floyd',
    diffusion: display.diffusion,
    orderedMap: display.orderedMap,
  });
  return { bmp, base64: bytesToBase64(bmp), indices, colormap };
}

/**
 * A document straight to its BMP, with no editor or stage. `display` defaults to the
 * document's own; `images` maps element index -> decoded image (see buildScene). The
 * host's Konva must be able to make a canvas: a browser's, or a canvas-backed build
 * on a server. Fonts are the host's too: text draws in whatever the host has loaded.
 */
export function renderScene(Konva, doc, { display = doc.display || {}, images = {} } = {}) {
  const { group, width, height } = buildScene(Konva, doc, { display, images });
  const canvas = group.toCanvas({ x: 0, y: 0, width, height, pixelRatio: 1 });
  group.destroy();
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return { width, height, ...encodeBitmap(rgba, width, height, display) };
}
