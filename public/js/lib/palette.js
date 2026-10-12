/**
 * The panel palettes the renderer quantizes to, and the colour and geometry rules
 * around them. Pure: every function takes the descriptor or palette type it needs.
 * The editor's live descriptor, and helpers bound to it, are in canvas/palette.js.
 */

/** The panel's blank page: what every palette calls white, and the default background. */
export const PAPER = '#F2F4EF';

/**
 * The colours each panel type can show — the single source of truth the renderer
 * (lib/bitmap.js) quantizes to. Originally extracted from the ImageMagick
 * `-remap` PNGs now kept under test/fixtures/palettes/ as provenance.
 *
 * Order here is for the editor's swatches only: the BMP palette that reaches the
 * panel is in the renderer's octree order, exactly as ImageMagick emitted it.
 */
export const PALETTES = {
  mono:      ['#2F2429', '#F2F4EF'],
  gray4:     ['#2F2429', '#70696B', '#B1AFAD', '#F2F4EF'],
  tricolor:  ['#2F2429', '#F2F4EF', '#D72627'],
  // black/white/red/yellow; red+yellow from the product 6373 datasheet
  quadcolor: ['#2F2429', '#F2F4EF', '#FD2A00', '#FFFF03'],
};

export const MODE_LABELS = {
  mono: 'mono',
  gray4: '4 grays',
  tricolor: 'black/white/red',
  quadcolor: 'black/white/red/yellow',
};

/**
 * Panels whose firmware entry already turns the portrait scan buffer on its side, so
 * rotation 0 is LANDSCAPE on the glass. The MagTag's 128×296 buffer is presented as
 * 296×128 at rotation 0; the editor's canvas has to agree or the bitmap it ships is
 * the wrong way round. Every other catalogued panel shows its buffer as-is at 0.
 * 'magtag-2025' is the MagTag's old id, kept so a canvas.json saved under it still
 * imports landscape.
 */
export const LANDSCAPE_AT_ZERO_PANELS = new Set(['magtag', 'magtag-2025']);

export function landscapeAtZero(panel) {
  return LANDSCAPE_AT_ZERO_PANELS.has(String(panel || '').trim());
}

/**
 * The same answer for any descriptor, not just the live one — an imported document
 * carries the display it was authored on, and fitting it means knowing how big THAT
 * canvas was.
 */
export function logicalDimsOf(d) {
  const swap = ((d.rotation || 0) % 180 !== 0) !== landscapeAtZero(d.panel || '');
  return {
    w: swap ? d.height : d.width,
    h: swap ? d.width : d.height,
  };
}

export function hexToRGB(hex) {
  if (typeof hex !== 'string') return [0, 0, 0]; // elements without a fill (e.g. images)
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** The entry of `palHex` nearest to `hex`, by straight RGB distance. */
export function nearestColor(hex, palHex) {
  const c = hexToRGB(hex);
  let best = palHex[0], bestD = Infinity;
  for (const p of palHex) {
    const [r, g, b] = hexToRGB(p);
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

export const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * The display background a document asks for, as a colour this panel can show.
 *
 * Restricted to the palette, like every ink: anything else would only dither into a
 * speckle of the colours either side of it. A document saved before the field existed
 * has none and gets PAPER, which is what its canvas always was, so an old layout loads
 * exactly as it looked. PAPER is in every palette, so the fallback never needs snapping.
 */
export function paletteBackground(bg, type) {
  if (!isHexColor(bg)) return PAPER;
  return nearestColor(bg, PALETTES[type] || PALETTES.mono);
}

/**
 * A palette entry is "neutral" when its channels are near-equal. Derived rather
 * than hardcoded so a new palette gets the right behaviour for free. The
 * paper/ink hexes aren't pure greys (#2F2429, #F2F4EF), hence the tolerance
 * rather than r === g === b.
 *   mono / tricolor / quadcolor -> [ink, paper];  gray4 -> all four shades.
 */
export function isNeutralHex(hex) {
  const [r, g, b] = hexToRGB(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

export function neutralShadesOf(type) {
  return (PALETTES[type] || PALETTES.mono).filter(isNeutralHex);
}
