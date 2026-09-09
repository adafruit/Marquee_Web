# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays, plus a
small render backend that turns what you draw into epaper-display-ready bitmaps.

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer |
| **ImageMagick** | **7.x** — the `magick` command must be on your `PATH` |
| **Browser** | Any modern one for the editor. The flash step (A6-A) needs Web Serial and the File System Access API — Chrome or Edge on desktop, over https or localhost. |

ImageMagick 7 or newer is **required**.

```sh
brew install imagemagick        # macOS
sudo apt install imagemagick    # Debian/Ubuntu
```

## Run it

```sh
git clone https://github.com/adafruit/Marquee_Web.git
cd Marquee_Web
npm install
npm start
```

Then open <http://localhost:3000>.

`npm run dev` does the same under `node --watch`, restarting the server when you
edit it. The frontend needs no build step — it is plain ES modules served
straight from `public/`, so a browser reload picks up any change you make.

Check your setup at any time:

```sh
curl -s localhost:3000/health
# {"ok":true,"imagemagick":"Version: ImageMagick 7.1.2-27 ...","palettes":[...]}
```

A non-200 there means ImageMagick isn't installed or isn't on the `PATH`, and
nothing will render until it is.

## Configuration

The server reads three environment variables, all optional:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the editor and backend listen on. |
| `AIO_USER` | *(unset)* | Adafruit IO username for the optional server-side publish path. |
| `AIO_KEY` | *(unset)* | Adafruit IO key for the same. |

`AIO_USER` / `AIO_KEY` exist so `POST /publish` can render and push in one step
with the key held server-side, out of the browser. Leave them unset — the normal
path — and `/publish` answers `501`; the editor then publishes directly from the
browser with the key you connect in A1-C, which is stored in that browser's
localStorage and never sent here. The Wi-Fi credentials from A5-C are stored the same
way, per display, as part of the `cfg-marquee.json` that A6-A shows and writes onto the
board's USB drive — see [`docs/cfg-marquee.md`](docs/cfg-marquee.md).

Note that the server reads `process.env` directly and does **not** load a `.env`
file on its own. Export the values in your shell, or:

```sh
node --env-file=.env server/index.js
```

Treat your Adafruit IO key like a password, and keep `.env` out of git — the
`.gitignore` already does this.

## Layout

```
server/
  index.js         Express app: render, publish, canvas persistence
  palettes/        the four -remap PNGs ImageMagick quantizes against
data/              runtime state — canvas.json lands here, gitignored
docs/              the feed and file format specs
public/
  index.html       every screen, mounted at once and shown/hidden by the router
  css/             tokens.css -> base.css -> app.css, in that order
  js/
    main.js        entry point: wires the modules and the screens together
    core/          state, util, router, api, config, doc
    canvas/        stage, elements, selection, palette, render, icons, konva shim
    device/        device, devices, activate, credentials, provision, flash, drive,
                   cycle, canvasfeed, feeds, presets
    screens/       a1, a1c (a modal, not a route), a4, a5b, a5c, a6a, a7, a8
    vendor/        Konva 10.3.0 and esptool-js 0.6.1 (bundle.js, Apache-2.0), inlined so
                   there is no CDN dependency
```

`server/palettes/` sits deliberately outside `public/`, so `express.static` never
serves it — the remap PNGs are an ImageMagick input, not a web asset. Their
colors are mirrored as `PALETTES` in `public/js/canvas/palette.js`; the two must
stay in sync.

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
the Settings modal rather than on a setup screen, because `core/config.js` reads
those fields from A7 and A8 as well.

## Flashing a board

A6-A does the whole thing from the browser — Chrome or Edge on desktop, no server involved.

1. **Get the image.** Open the
   [Adafruit_Marquee build](https://github.com/adafruit/Adafruit_Marquee/actions/workflows/build.yml),
   pick the latest run, and download the artifact for your board:

   | Display preset | Artifact | Chip |
   |---|---|---|
   | MagTag 2.9" | `marquee-magtag-<sha>` | ESP32-S2 |
   | Any panel on a Feather (tri-color FeatherWing, breakouts, 4.2", 7.5") | `marquee-adafruit_feather_esp32s3-<sha>` | ESP32-S3 |
   | Xteink X4 Pro | `marquee-x4pro-<sha>` | ESP32-S3 |

   Unzip it. The file A6-A wants is `merged-flash.bin` — bootloader, partition table,
   `boot_app0` and the app already laid out at their offsets, written at `0x0` in one go.
2. **Flash.** Hold BOOT, tap RESET, release BOOT. Choose the `.bin` (it is checked for a
   partition table and the right bootloader offset before any port dialog opens), click
   **Connect and flash**, pick the board's port. The chip is read and compared with the
   image before anything is written. Leave "Erase the whole chip first" off — see Known gaps.
3. **Write the config.** Press RESET. The firmware comes up as a USB drive named `MARQUEE`.
   Click **Open MARQUEE and write config…**, choose that drive, and `cfg-marquee.json` is
   written into it and read back. Browsers without a directory picker get a Download button
   and copy the file over by hand.
4. **Eject, then press RESET.** The board reads the file at boot only. Done opens the editor.

Skipping the flash ("my board is already flashed") lands on step 3; skipping that too goes
straight to the editor.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the editor |
| `GET` | `/health` | ImageMagick + palette check |
| `POST` | `/render` | dither + remap a canvas PNG -> `{ bmp, png, sizes }` |
| `POST` | `/publish` | render, then push to Adafruit IO with the server's key |
| `GET` `POST` | `/canvas` | read / persist the canvas layout to `data/canvas.json` |
| `POST` | `/reset` | empty `data/canvas.json`, keeping its display descriptor |

That is the whole surface, and none of it talks to a board. This server renders and
persists; everything that reaches the device goes through Adafruit IO feeds straight
from the browser, per the specs in `docs/`.

## Documentation

The wire formats, each one its own contract:

- [`docs/marquee-canvas-state.md`](docs/marquee-canvas-state.md) — the `{group}.canvas-state` feed: the editable scene, parked on Adafruit IO
- [`docs/marquee-sleep.md`](docs/marquee-sleep.md) — the `{group}.sleep` feed: how long to sleep and what to wake on
- [`docs/marquee-status.md`](docs/marquee-status.md) — the `{group}.status` feed: what the board reports back
- [`docs/cfg-marquee.md`](docs/cfg-marquee.md) — `cfg-marquee.json`: the file written to the board at flash time, assembled during setup and viewable from A6-A

## Known gaps

- **Firmware is picked from disk.** A6-A flashes a `merged-flash.bin` the user has
  downloaded from the Adafruit_Marquee CI run — GitHub Actions artifacts need an
  authenticated download, so the browser cannot fetch them itself. Pulling the image from
  a GitHub Release is the next step; `loadFirmware()` in `device/flash.js` is the seam,
  and nothing else in the app would change.
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
