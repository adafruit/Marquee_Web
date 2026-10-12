/**
 * A canvas.json to the panel's BMP, on a server: the editor's own lib/ (scene, renderer,
 * dither) drawn by Konva on skia-canvas, which is Skia like Chrome, with the same bundled
 * fonts. The host (Adafruit IO) bakes feed readings into the document before calling; this
 * module fills in the time, decodes images, and renders.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Konva from 'konva';
import 'konva/skia-backend';
import { FontLibrary, loadImage } from 'skia-canvas';

import { renderScene } from '../public/js/lib/render.js';
import { FONT_FILES } from '../public/js/lib/fonts.js';
import { FA_FAMILY } from '../public/js/lib/icons.js';
import { normalizeDatetimeAttrs, strftime } from '../public/js/lib/timefmt.js';

// Konva warns about attrs it would type differently (a feed reading in `value` is a string),
// which the editor tolerates on purpose; on a server it would only fill the logs.
Konva.showWarnings = false;

const fontPath = (file) => fileURLToPath(new URL(`../public/fonts/${file}`, import.meta.url));

let fontsLoaded = false;

/** The faces canvas text draws in, registered once per process. */
export function loadFonts() {
  if (fontsLoaded) return;
  const byFamily = Object.groupBy(FONT_FILES, (f) => f.family);
  for (const [family, files] of Object.entries(byFamily)) FontLibrary.use(family, files.map((f) => fontPath(f.file)));
  FontLibrary.use(FA_FAMILY, [fontPath('fa-solid-900.woff2')]);
  fontsLoaded = true;
}

/**
 * The document as it should draw at `now`: each date & time element showing that instant in
 * its own zone, or `timeZone` (the account's) when it names none, or UTC when that is unknown.
 */
export function atTime(doc, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const elements = (doc.elements || []).map((el) => {
    if (el.etype !== 'datetime') return el;
    const { timeFmt, timeTz } = normalizeDatetimeAttrs(el);
    const timeValue = strftime(now, timeFmt, timeTz || timeZone) ?? strftime(now, timeFmt, 'UTC');
    return timeValue === null ? el : { ...el, timeValue };
  });
  return { ...doc, elements };
}

/** Images arrive as data URLs inside the document; decoded here, by element index. */
async function decodeImages(doc) {
  const images = {};
  await Promise.all((doc.elements || []).map(async (el, i) => {
    if (el.etype !== 'image' || !el.src) return;
    try {
      images[i] = await loadImage(el.src);
    } catch {
      // an undecodable image is left out, as it is in the editor
    }
  }));
  return images;
}

/**
 * Render a document.
 *
 *   doc        canvas.json, readings already baked in
 *   display    the panel ({ width, height, rotation, panel, type, dither, diffusion,
 *              orderedMap }); defaults to the document's own
 *   now        epoch ms for date & time elements
 *   timeZone   the zone a date & time element with none uses
 *
 *   -> { base64, sha, bytes, width, height }
 */
export async function render({ doc, display = doc?.display, now, timeZone } = {}) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.elements)) throw new Error('expected a version 1 canvas document');
  if (!display?.width || !display?.height || !display?.type) throw new Error('expected a display with width, height and type');

  loadFonts();
  const timed = atTime(doc, { now, timeZone });
  const out = renderScene(Konva, timed, { display, images: await decodeImages(timed) });

  return {
    base64: out.base64,
    sha: createHash('sha256').update(out.base64).digest('hex'),
    bytes: out.bmp.length,
    width: out.width,
    height: out.height,
  };
}
