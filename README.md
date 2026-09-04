# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays. It turns
what you draw into epaper-ready bitmaps entirely in the browser and publishes them
to Adafruit IO feeds. It is a static site: no server, no build step, and everything
it remembers lives in your browser's localStorage.

## Requirements

| | |
|---|---|
| **Browser** | Any modern one. The flash step (A6-A) additionally needs Web Serial, so Chrome or Edge. |
| **Node.js** | Optional — 18 or newer, only for the local dev server (`npm start`) and the tests (`npm test`). |

Nothing else. ImageMagick used to be required; it is not any more — see
[Rendering](#rendering).

## Run it

Serve the `public/` folder from any static web server. Browsers refuse to load ES
modules over `file://`, so it does need *some* HTTP server:

```sh
git clone https://github.com/adafruit/Marquee_Web.git
cd Marquee_Web
npm start                       # zero-dependency server, http://localhost:3000
# or, without Node:
python3 -m http.server -d public 8080
```

The same folder can be published as-is to GitHub Pages or any other static host.
All asset paths are relative, so it works from a sub-path too.

`npm test` runs the render regression suite (see below). There is nothing to
install first: the repo has no runtime or dev dependencies.

## Rendering

Everything you draw is captured at 1:1 and dithered + palette-remapped by
`public/js/canvas/bitmap.js`, a pure-JS port of the ImageMagick pipeline the editor
used to shell out to:

```
magick in.png -dither FloydSteinberg -define dither:diffusion-amount=N% \
  -remap eink-<type>.png gif:- | magick gif:- -compress none BMP3:-
```

The port is **byte-identical** to that pipeline — the same indexed BMP3 (1 bpp mono,
4 bpp for the colour and grayscale panels) that the firmware reads, for every dither
setting the UI offers (Floyd–Steinberg at any diffusion, ordered 2×2/4×4/8×8, none).
That claim is enforced by `test/bitmap.test.js`, which renders every raster under
`test/fixtures/inputs/` and compares the bytes with the goldens ImageMagick produced
(`test/fixtures/golden/`, 4 panel types × 7 dither settings each).

Two things worth knowing if you ever regenerate the goldens
(`scripts/regen-goldens.sh`, needs `magick`):

- They were made with ImageMagick 7.1.2-27 Q16-HDRI on macOS. Apple builds use a
  coarser colour cache during dithering (`quantize.c`, `CacheShift 3` vs 2), which
  `bitmap.js` mirrors; a Linux `magick` can differ in a handful of pixels.
- The panel palettes are `PALETTES` in `public/js/canvas/palette.js`. The original
  `-remap` PNGs are kept under `test/fixtures/palettes/` for the regen script only.

## Layout

```
docs/              the feed and file format specs
public/            the site — serve this folder
  index.html       every screen, mounted at once and shown/hidden by the router
  css/             tokens.css -> base.css -> app.css, in that order
  js/
    main.js        entry point: wires the modules and the screens together
    core/          state, util, router, api, config, doc
    canvas/        stage, elements, selection, palette, bitmap, render, icons, konva shim
    device/        device, devices, activate, credentials, provision, flash, cycle,
                   canvasfeed, feeds, presets
    screens/       a1, a1c (a modal, not a route), a4, a5b, a5c, a6a, a7, a8
    vendor/        Konva 10.3.0, inlined so there is no CDN dependency
scripts/
  serve.js         the `npm start` static server
  regen-goldens.sh rebuild the render goldens with real ImageMagick
test/
  bitmap.test.js   byte-identity regression for the renderer
  fixtures/        raw inputs, golden BMPs, the original -remap palette PNGs
```

## How the app is organised

Screens are `<section>`s that all exist in `index.html` from the start; the
router shows and hides them rather than creating and destroying them. They still
carry their working names from the design docs:

```
A1 device list -> A4 pick device -> A5b Adafruit IO -> A5c Wi-Fi -> A6a flash
      |                                                                |
   (A1-C, once)                        A1 <- ALL DISPLAYS <- A7 <-> A8
```

A1-C is the exception to "screens are sections": it is a modal over the display
list, shown the first time a display is added, and it is the only place an Adafruit
IO username and key are ever typed. It checks the key against `/api/v2/user` before
saving, so every screen after it reads an account that is known to work. A5b shows
that account read-only and asks only for a device name.

A7 (build) and A8 (show) are the editor proper and loop between themselves; setup
is only re-entered by adding a device.

That list is the whole set: `router.js`'s `SCREENS` map is the single source of
truth, and `navigate()` hard-rejects anything not in it — which is what keeps a
`lastScreen` remembered by an older build from routing to a screen that no longer
exists.

The display descriptor — geometry, rotation, colour mode and the pinout — lives in
`#settingsModal` rather than on a setup screen, because `core/config.js` reads those
fields from A7 and A8 as well. That modal has no entry point any more: the chrome
button that opened it is gone, so it is now a hidden field bank rather than a dialog.
It stays mounted because those inputs *are* the store — `api.js#ioHost()`,
`device/feeds.js` and `core/config.js` all read straight out of it — and several of
those reads are not optional-chained, so removing the markup would throw during boot.
Panels are chosen from A4's preset picker instead.

## Documentation

The wire formats, each one its own contract:

- [`docs/marquee-canvas-state.md`](docs/marquee-canvas-state.md) — the `{group}.canvas-state` feed: the editable scene, parked on Adafruit IO
- [`docs/marquee-sleep.md`](docs/marquee-sleep.md) — the `{group}.sleep` feed: how long to sleep and what to wake on
- [`docs/marquee-status.md`](docs/marquee-status.md) — the `{group}.status` feed: what the board reports back

## Known gaps

- **Flashing is not wired up.** A6-A is built and navigable, but `device/flash.js`
  is a documented seam: it needs `esptool-js` vendored into `js/vendor/` and a
  firmware image, neither of which is in this repo. "Skip, my board is already
  flashed" is the way through for now, and Connect says so in the log rather than
  miming a result.
- **The firmware does not read the sleep feed yet, and publishes no status.** The
  editor's publisher side is complete; the round trip is not. Until a board reports
  on `{group}.status`, Act III models the cycle and says so. See
  [`docs/marquee-sleep.md`](docs/marquee-sleep.md) and
  [`docs/marquee-status.md`](docs/marquee-status.md).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adafruit Industries.
