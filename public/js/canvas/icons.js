/**
 * The Font Awesome face's load gate. The glyph table itself is lib/icons.js,
 * re-exported here so editor code has one place to import from.
 */

import { FA_FAMILY, FA_WEIGHT } from '../lib/icons.js';

export {
  FA_FAMILY, FA_WEIGHT, FA_LINK, GAUGE_ICONS, DEFAULT_GAUGE_ICON, iconGlyph,
} from '../lib/icons.js';

// ---------- the font-ready gate ---------------------------------------------
//
// Canvas text needs the face actually loaded, and @font-face loading is lazy: the
// first paint after a cold load would draw a substitute glyph, and the dither
// preview would cache that. So icon-bearing widgets are re-built once the face
// resolves.

let readyPromise = null;

export function faReady() {
  if (readyPromise) return readyPromise;
  readyPromise = document.fonts
    ? document.fonts.load(`${FA_WEIGHT} 16px "${FA_FAMILY}"`).then(() => true, () => false)
    : Promise.resolve(false);
  return readyPromise;
}

/**
 * Run `fn` once the face has resolved. Never rejects: a failed load leaves the
 * browser's substitute glyph, which is visible and reportable, rather than
 * throwing from inside a widget rebuild.
 */
export function onFaReady(fn) {
  faReady().then(fn);
}
