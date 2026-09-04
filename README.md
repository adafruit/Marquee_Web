# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays, plus a
small render backend that turns what you draw into epaper-display-ready bitmaps.

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer |
| **ImageMagick** | **7.x** — the `magick` command must be on your `PATH` |
| **Browser** | Any modern one. The flash step (A6-A) additionally needs Web Serial, so Chrome or Edge. |

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
localStorage and never sent here.

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
    device/        device, devices, activate, credentials, provision, flash, cycle,
                   canvasfeed, feeds, presets
    screens/       a1, a1c (a modal, not a route), a4, a5b, a5c, a6a, a7, a8
    vendor/        Konva 10.3.0, inlined so there is no CDN dependency
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
