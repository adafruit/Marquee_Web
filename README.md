# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays. It turns
what you draw into epaper-ready bitmaps entirely in the browser and publishes them
to Adafruit IO feeds. It is a static site: no server, no build step, and everything
it remembers lives in your browser's localStorage.

## Requirements

| | |
|---|---|
| **Browser** | Any modern one for the editor. The flash step (A6-A) needs Web Serial and the File System Access API — Chrome or Edge on desktop, over https or localhost. |
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

`npm test` runs the `node --test` suite — the render regression (see below) and the
firmware tests. There is nothing to install first: the repo has no runtime or dev
dependencies.


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

## Credentials

The Adafruit IO key you connect in A1-C is stored in that browser's localStorage and
sent only to Adafruit IO, straight from the browser. The Wi-Fi credentials from A5-C are
stored the same way, per display, as part of the `cfg-marquee.json` that A6-A shows and
writes onto the board's USB drive — see [`docs/cfg-marquee.md`](docs/cfg-marquee.md).

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
    device/        device, devices, activate, credentials, provision, firmware, flash,
                   drive, cycle, canvasfeed, feeds, presets
    screens/       a1, a1c (a modal, not a route), a4, a5b, a5c, a6a, a7, a8
    vendor/        Konva 10.3.0 and esptool-js 0.6.1 (bundle.js, Apache-2.0), inlined so
                   there is no CDN dependency
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

## Flashing a board

A6-A does the whole thing from the browser — Chrome or Edge on desktop, no server involved.

1. **The image downloads itself.** A6-A fetches the latest
   [Adafruit_Marquee release](https://github.com/adafruit/Adafruit_Marquee/releases) for the
   display's board, shows its version next to the board name, and verifies the download
   against the release's SHA-256 before using it. The file is `merged-flash.bin` — bootloader,
   partition table, `boot_app0` and the app already laid out at their offsets, written at
   `0x0` in one go. See [`docs/firmware-branch.md`](docs/firmware-branch.md) for where it is
   fetched from and why that is not the Release page itself.

   **Use a file instead…** takes a `merged-flash.bin` you downloaded yourself — from a
   [CI build](https://github.com/adafruit/Adafruit_Marquee/actions/workflows/build.yml)
   artifact, an older release, or for a panel set up by hand:

   | Display preset | Artifact | Chip |
   |---|---|---|
   | MagTag 2.9" | `marquee-magtag-<sha>` | ESP32-S2 |
   | Any panel on a Feather (tri-color FeatherWing, breakouts, 4.2", 7.5") | `marquee-adafruit_feather_esp32s3-<sha>` | ESP32-S3 |
   | Xteink X4 Pro | `marquee-x4pro-<sha>` | ESP32-S3 |

2. **Flash.** Hold BOOT, tap RESET, release BOOT. Once the row reads "ready", click
   **Connect and flash** and pick the board's port. The image is checked for a partition
   table and the right bootloader offset before any port dialog opens, and the chip is read
   and compared with the image before anything is written. Leave "Erase the whole chip first"
   off — see Known gaps.
3. **Write the config.** Press RESET. The firmware comes up as a USB drive named `MARQUEE`.
   Click **Open MARQUEE and write config…**, choose that drive, and `cfg-marquee.json` is
   written into it and read back. Browsers without a directory picker get a Download button
   and copy the file over by hand.
4. **Eject, then press RESET.** The board reads the file at boot only. Done opens the editor.

Skipping the flash ("my board is already flashed") lands on step 3; skipping that too goes
straight to the editor.


## Documentation

The wire formats, each one its own contract:

- [`docs/marquee-canvas-state.md`](docs/marquee-canvas-state.md) — the `{group}.canvas-state` feed: the editable scene, parked on Adafruit IO
- [`docs/marquee-sleep.md`](docs/marquee-sleep.md) — the `{group}.sleep` feed: how long to sleep and what to wake on
- [`docs/marquee-status.md`](docs/marquee-status.md) — the `{group}.status` feed: what the board reports back
- [`docs/cfg-marquee.md`](docs/cfg-marquee.md) — `cfg-marquee.json`: the file written to the board at flash time, assembled during setup and viewable from A6-A
- [`docs/firmware-branch.md`](docs/firmware-branch.md) — where A6-A fetches firmware from: the `firmware` branch of Adafruit_Marquee and its `manifest.json`

## Known gaps

- **Latest release only.** A6-A offers whatever `manifest.json` on Adafruit_Marquee's
  `firmware` branch says is newest, pre-releases included (and labelled). There is no
  version picker; an older release or a CI artifact goes through "Use a file instead…".
  Per-tag manifests are committed, so a picker is a small change when wanted.
- **Not the Release assets.** GitHub's release-asset CDN sends no CORS header, so a browser
  cannot read those files. The firmware repo's publish job therefore writes the binaries to
  the `firmware` branch as well as attaching zips to the release — see
  [`docs/firmware-branch.md`](docs/firmware-branch.md).
- **A full chip erase leaves the drive unformatted.** The firmware never formats its FAT
  partition, so ticking "Erase the whole chip first" means formatting the `MARQUEE`
  volume by hand before the config can be written. The box is off by default and says so.
- **The firmware does not read the sleep feed yet, and publishes no status.** The
  editor's publisher side is complete; the round trip is not. Until a board reports
  on `{group}.status`, Act III models the cycle and says so. See
  [`docs/marquee-sleep.md`](docs/marquee-sleep.md) and
  [`docs/marquee-status.md`](docs/marquee-status.md).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adafruit Industries.
