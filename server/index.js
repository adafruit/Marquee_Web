'use strict';

/**
 * Adafruit IO Marquee — render backend.
 *
 * A thin Express server whose one real job is to run the exact ImageMagick
 * pipeline the editor was designed around — dither+remap once through a
 * palettized GIF, then transcode to an indexed BMP for the panel:
 *
 *   magick in.png -dither FloydSteinberg -define dither:diffusion-amount=N% \
 *     -remap server/palettes/eink-<type>.png gif:- \
 *     | magick gif:- -compress none BMP3:out.bmp
 *
 * The browser editor sends a PNG snapshot of the canvas plus the display
 * settings; the server dithers + remaps with real ImageMagick and returns an
 * indexed BMP3 (1bpp mono / 4bpp color, validated) plus a truecolor PNG of the
 * identical pixels for the on-screen preview. This is the *only* render path —
 * the editor no longer falls back to a client-side JS dither. See README.md.
 */

const express = require('express');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Where the -remap palette PNGs live. Server-side only — they sit outside
// public/, so express.static never serves them. Must stay in sync with the
// editor's PALETTES / REMAP_FILES tables (public/js/canvas/palette.js).
const PALETTE_DIR = path.join(__dirname, 'palettes');

// display type -> remap PNG filename (the backend contract).
const REMAP_FILES = {
  mono: 'eink-2color.png',       // black & white
  gray4: 'eink-4gray.png',       // 4-level grayscale
  tricolor: 'eink-3color.png',   // black / white / red
  quadcolor: 'eink-4color.png',  // black / white / red / yellow (product 6373)
};

// Adafruit IO datum ceilings (bytes of base64 payload).
const IO_MAX_HISTORY = 1024;         // feed history ON
const IO_MAX_NO_HISTORY = 512 * 1024; // feed history OFF (the real per-datum limit)

app.use(express.json({ limit: '32mb' })); // canvas PNGs are small, but be generous
app.use(express.static(path.join(__dirname, '..', 'public'))); // optionally serve the editor

// ---- helpers ---------------------------------------------------------------

// Build the ImageMagick dither arguments from the request. Everything here is
// a fixed flag or a bounded number — no user string reaches the shell, and we
// use execFile (no shell) so there is nothing to inject into.
function ditherArgs({ method, diffusion, orderedMap }) {
  if (method === 'none') return ['-dither', 'None'];
  if (method === 'ordered') {
    const size = [2, 4, 8].includes(Number(orderedMap)) ? Number(orderedMap) : 8;
    return ['-ordered-dither', `o${size}x${size}`];
  }
  // default: Floyd–Steinberg with a clamped diffusion amount
  const amt = Math.max(0, Math.min(100, Number(diffusion)));
  return ['-dither', 'FloydSteinberg', '-define', `dither:diffusion-amount=${amt}%`];
}

// Run ImageMagick (v7 `magick`) with no shell. Returns stdout as a Buffer so a
// stage can emit an image to stdout (e.g. `gif:-`) and we pipe it onward.
function runConvert(args) {
  return new Promise((resolve, reject) => {
    execFile('magick', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr ? stderr.toString() : err.message));
        resolve(stdout);
      });
  });
}

// Same as runConvert but feeds `input` to the child's stdin — the second half
// of the `stage1 | stage2` pipe, done without a shell.
function runConvertStdin(args, input) {
  return new Promise((resolve, reject) => {
    const cp = execFile('magick', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr ? stderr.toString() : err.message));
        resolve(stdout);
      });
    cp.stdin.on('error', reject);
    cp.stdin.end(input);
  });
}

// The indexed bit depth each display type must encode at: mono is 2 colors -> 1
// bit/px, every other palette is <=4 colors -> 4 bit/px. This mirrors the
// editor's PALETTES sizes and is what the firmware's BMP reader expects.
function expectedBpp(display) {
  return display === 'mono' ? 1 : 4;
}

// Guard: the pipeline must produce an *indexed, uncompressed* BMP at the depth
// above. Reject anything else (esp. 24-bit truecolor) so a wrong BMP can never
// be returned or published. Reads the BITMAPINFOHEADER: biBitCount @28 (u16 LE),
// biCompression @30 (u32 LE, must be 0 = BI_RGB).
function assertIndexedBmp(buf, wantBpp) {
  if (!buf || buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error('not a BMP');
  }
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== wantBpp) {
    throw new Error(`expected ${wantBpp}-bit indexed BMP, got ${bpp}-bit`);
  }
  if (compression !== 0) {
    throw new Error(`expected uncompressed BMP (BI_RGB), got compression ${compression}`);
  }
}

// Dither + remap once into a palettized GIF, then transcode that GIF into both
// the indexed BMP (for the panel) and a truecolor PNG (identical pixels, for the
// browser preview). Routing through GIF forces the image to stay palettized so
// the BMP lands at 1-/4-bit instead of 24-bit. Returns { bmp, png } Buffers.
async function renderIndexed({ display, dither, inPath }) {
  const palette = path.join(PALETTE_DIR, REMAP_FILES[display]);
  const gif = await runConvert([inPath, ...dither, '-remap', palette, 'gif:-']);
  const bmp = await runConvertStdin(['gif:-', '-compress', 'none', 'BMP3:-'], gif);
  assertIndexedBmp(bmp, expectedBpp(display));
  const png = await runConvertStdin(['gif:-', 'PNG24:-'], gif);
  return { bmp, png };
}

// ---- /render ---------------------------------------------------------------

/**
 * POST /render
 * body: {
 *   png:       base64 PNG of the canvas (required),
 *   display:   'mono' | 'gray4' | 'tricolor' | 'quadcolor',
 *   method:    'floyd' | 'ordered' | 'none',
 *   diffusion: 0..100   (floyd only),
 *   orderedMap: 2 | 4 | 8 (ordered only)
 * }
 * returns: {
 *   bmp:        base64 indexed BMP3 (what ships to the panel),
 *   png:        base64 PNG of the dithered result (for on-screen preview),
 *   bmpBytes:   raw BMP size,
 *   base64Bytes: size once base64-encoded (the number IO actually limits),
 *   fitsNoHistory: boolean (<= 512 KB),
 *   fitsHistory:   boolean (<= 1 KB)
 * }
 */
app.post('/render', async (req, res) => {
  const { png, display = 'mono' } = req.body || {};
  if (!png) return res.status(400).json({ error: 'missing png' });
  const remap = REMAP_FILES[display];
  if (!remap) return res.status(400).json({ error: `unknown display type: ${display}` });

  const tmp = os.tmpdir();
  const id = randomUUID();
  const inPath = path.join(tmp, `marquee-${id}-in.png`);

  try {
    const raw = Buffer.from(String(png).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fs.writeFile(inPath, raw);

    // Dither+remap once, then emit a validated 4bpp (1bpp mono) indexed BMP for
    // the panel and a truecolor PNG of the identical pixels for preview.
    const { bmp, png: pngOut } = await renderIndexed({ display, dither: ditherArgs(req.body), inPath });
    const base64Bytes = Math.ceil(bmp.length / 3) * 4;

    res.json({
      bmp: bmp.toString('base64'),
      png: pngOut.toString('base64'),
      bmpBytes: bmp.length,
      base64Bytes,
      fitsNoHistory: base64Bytes <= IO_MAX_NO_HISTORY,
      fitsHistory: base64Bytes <= IO_MAX_HISTORY,
    });
  } catch (e) {
    res.status(500).json({ error: 'render failed', detail: String(e.message || e) });
  } finally {
    // best-effort cleanup
    Promise.allSettled([fs.unlink(inPath)]);
  }
});

// ---- /publish (optional; keeps the AIO key server-side) --------------------

/**
 * POST /publish
 * Renders (same as /render) then forwards the base64 BMP to Adafruit IO using
 * a key held in the server environment (AIO_KEY / AIO_USER), so the browser
 * never sees it. If the env key is absent, the client may still publish
 * directly from the browser as before — this endpoint is purely optional.
 *
 * body: { ...same as /render, plus: feed }
 */
app.post('/publish', async (req, res) => {
  const user = process.env.AIO_USER;
  const key = process.env.AIO_KEY;
  if (!user || !key) {
    return res.status(501).json({ error: 'server has no AIO credentials; publish from the client instead' });
  }
  const { png, display = 'mono', feed, dev } = req.body || {};
  if (!png) return res.status(400).json({ error: 'missing png' });
  if (!feed) return res.status(400).json({ error: 'missing feed key' });
  const remap = REMAP_FILES[display];
  if (!remap) return res.status(400).json({ error: `unknown display type: ${display}` });

  const tmp = os.tmpdir();
  const id = randomUUID();
  const inPath = path.join(tmp, `marquee-${id}-in.png`);

  try {
    const raw = Buffer.from(String(png).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fs.writeFile(inPath, raw);
    // Same validated indexed pipeline as /render (BMP only is used here).
    const { bmp } = await renderIndexed({ display, dither: ditherArgs(req.body), inPath });
    const value = bmp.toString('base64');
    const base64Bytes = value.length;

    if (base64Bytes > IO_MAX_NO_HISTORY) {
      return res.status(413).json({ error: `payload ${base64Bytes} B exceeds IO ${IO_MAX_NO_HISTORY} B ceiling` });
    }

    // Same default as the browser's ioHost(): io.adafruit.com, with dev=true
    // opting into the .us staging environment. The two have to agree, or a publish
    // routed through here would land on a different account than every read.
    const host = dev ? 'io.adafruit.us' : 'io.adafruit.com';
    const url = `https://${host}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feed)}/data`;
    const io = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIO-Key': key },
      body: JSON.stringify({ value }),
    });
    if (!io.ok) {
      const body = await io.text();
      return res.status(io.status).json({ error: 'IO rejected', status: io.status, detail: body.slice(0, 500) });
    }
    res.json({ ok: true, base64Bytes });
  } catch (e) {
    res.status(500).json({ error: 'publish failed', detail: String(e.message || e) });
  } finally {
    Promise.allSettled([fs.unlink(inPath)]);
  }
});

// ---- /reset ----------------------------------------------------------------

/**
 * POST /reset
 * Empty the persisted layout so the next action starts from a known-empty world.
 *
 * canvas.json keeps its `display` block: the panel geometry the editor is
 * configured for is bench setup, not session state, and dropping it would leave the
 * next render with no descriptor to size itself against.
 *
 * Best-effort and never fatal, so the response is always 200 with a breakdown —
 * the caller's own teardown has already happened by the time it asks.
 *
 * body: { clearCanvas? }
 * returns: { ok, canvas }
 */
app.post('/reset', async (req, res) => {
  const { clearCanvas = true } = req.body || {};
  const out = { canvas: {} };

  if (clearCanvas) {
    try {
      let doc = { version: 1 };
      try {
        const prev = JSON.parse(await fs.readFile(CANVAS_FILE, 'utf8'));
        if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
          doc = { ...prev, version: prev.version || 1 };
        }
      } catch { /* missing or corrupt — start from a bare document */ }
      doc.elements = [];
      await fs.writeFile(CANVAS_FILE, JSON.stringify(doc, null, 2));
      out.canvas = { cleared: true, file: path.basename(CANVAS_FILE) };
    } catch (e) {
      out.canvas = { cleared: false, error: String(e.message || e) };
    }
  } else {
    out.canvas = { cleared: false, skipped: true };
  }

  console.log(`[reset] canvas=${out.canvas.cleared ? 'cleared' : (out.canvas.skipped ? 'skipped' : 'FAILED')}`);

  res.json({ ok: true, ...out });
});

// ---- health ----------------------------------------------------------------

// ---- Canvas autosave ---------------------------------------------------------
// The editor persists the whole canvas layout (the serialize() document from the
// browser) to a JSON file on every edit, so the current design is the internal
// source of truth on disk and can be inspected/round-tripped. This is separate
// from the browser localStorage that holds display/sleep/IO config.
//
// It lives in data/ and is gitignored: it is per-bench runtime state, not source.
// A fresh clone has no data/canvas.json, which GET /canvas answers as null — the
// editor treats that as "nothing saved yet" and the first edit writes the file.
const CANVAS_FILE = path.join(__dirname, '..', 'data', 'canvas.json');

app.get('/canvas', async (_req, res) => {
  try {
    const raw = await fs.readFile(CANVAS_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return res.json(null); // nothing saved yet
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/canvas', async (req, res) => {
  // Accept either { doc: {...} } or a bare document object.
  const doc = req.body && typeof req.body.doc === 'object' && req.body.doc !== null
    ? req.body.doc : req.body;
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return res.status(400).json({ ok: false, error: 'expected a canvas document object' });
  }
  try {
    await fs.writeFile(CANVAS_FILE, JSON.stringify(doc, null, 2));
    res.json({ ok: true, file: path.basename(CANVAS_FILE) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/health', async (_req, res) => {
  try {
    const out = await runConvert(['-version']);
    const line = out.toString().split('\n')[0];
    res.json({ ok: true, imagemagick: line, palettes: Object.values(REMAP_FILES) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'ImageMagick not found on PATH', detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`marquee editor + render backend on http://localhost:${PORT}`);
  console.log(`  GET  /          the editor (served from public/index.html)`);
  console.log(`  POST /render    dither + remap -> { bmp, png, sizes }`);
  console.log(`  POST /publish   render + push to Adafruit IO (needs AIO_USER/AIO_KEY)`);
  console.log(`  POST /reset     empty canvas.json, keeping its display descriptor`);
  console.log(`  GET  /canvas    read the persisted canvas.json layout`);
  console.log(`  POST /canvas    persist the canvas layout to canvas.json`);
  console.log(`  GET  /health    ImageMagick + palette check`);
});
