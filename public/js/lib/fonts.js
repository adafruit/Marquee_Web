/**
 * The typefaces elements draw in, bundled so the editor and a server render draw the same
 * glyphs: IBM Plex Mono, Sans and Serif (SIL Open Font License), regular and bold. The files
 * are in public/fonts/; each host loads them its own way (a FontFace in the browser,
 * skia-canvas's FontLibrary on a server).
 */

export const FONT_MONO = 'IBM Plex Mono';
export const FONT_SANS = 'IBM Plex Sans';
export const FONT_SERIF = 'IBM Plex Serif';

/** The choices the inspector offers, in its order. */
export const FONTS = [
  { family: FONT_MONO, label: 'Mono' },
  { family: FONT_SANS, label: 'Sans' },
  { family: FONT_SERIF, label: 'Serif' },
];

/** Every face to load, relative to public/fonts/. Chart titles are bold. */
export const FONT_FILES = [
  { family: FONT_MONO, weight: '400', file: 'IBMPlexMono-Regular.woff2' },
  { family: FONT_MONO, weight: '700', file: 'IBMPlexMono-Bold.woff2' },
  { family: FONT_SANS, weight: '400', file: 'IBMPlexSans-Regular.woff2' },
  { family: FONT_SANS, weight: '700', file: 'IBMPlexSans-Bold.woff2' },
  { family: FONT_SERIF, weight: '400', file: 'IBMPlexSerif-Regular.woff2' },
  { family: FONT_SERIF, weight: '700', file: 'IBMPlexSerif-Bold.woff2' },
];

// Documents saved before the fonts were bundled name the browser's generic families, which
// drew differently on every machine. Each loads as its Plex equivalent.
const LEGACY = { monospace: FONT_MONO, 'sans-serif': FONT_SANS, serif: FONT_SERIF };

/** A bundled family for any saved name: itself, its Plex equivalent, or Plex Mono. */
export function normalizeFontFamily(family) {
  if (FONTS.some((f) => f.family === family)) return family;
  return LEGACY[family] || FONT_MONO;
}
