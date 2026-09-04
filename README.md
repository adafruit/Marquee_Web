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

The server reads four environment variables, all optional:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the editor and backend listen on. |
| `PROTOMQ_URL` | `http://localhost:5173` | ProtoMQ broker's HTTP control API. Only the WipperSnapper endpoints use it; without a broker they answer `502` and the rest of the editor is unaffected. |
| `AIO_USER` | *(unset)* | Adafruit IO username for the optional server-side publish path. |
| `AIO_KEY` | *(unset)* | Adafruit IO key for the same. |

`AIO_USER` / `AIO_KEY` exist so `POST /publish` can render and push in one step
with the key held server-side, out of the browser. Leave them unset — the normal
path — and `/publish` answers `501`; the editor then publishes directly from the
browser with the key you enter in the UI, which is stored in that browser's
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
  index.js         Express app: render, publish, ProtoMQ bridge, canvas persistence
  palettes/        the four -remap PNGs ImageMagick quantizes against
protobufs/         vendored copy of ProtoMQ's protobuf bundle (re-sync if its protos change)
data/              runtime state — canvas.json lands here, gitignored
docs/              the feed and file format specs
public/
  index.html       every screen, mounted at once and shown/hidden by the router
  css/             tokens.css -> base.css -> app.css, in that order
  js/
    main.js        entry point: wires the modules and the screens together
    core/          state, util, router, api, config, doc
    canvas/        stage, elements, selection, palette, render, icons, konva shim
    device/        device, devices, activate, provision, flash, cycle, canvasfeed,
                   feeds, presets
    screens/       a1, a4, a5b, a5c, a6a, a7, a8
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
                                                                       |
                                        A1 <- ALL DISPLAYS <- A7 <-> A8
```

A7 (build) and A8 (show) are the editor proper and loop between themselves; setup
is only re-entered by adding a device.

There are also parked `<section>`s for **A3**, **A5** and **A6** in `index.html`.
They are not routable and have no JavaScript — `router.js` hard-rejects
navigation to them. A5's markup stays because `core/config.js` reads the display
descriptor fields inside its advanced disclosure. See **Known gaps** below.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the editor |
| `GET` | `/health` | ImageMagick + palette check |
| `POST` | `/render` | dither + remap a canvas PNG -> `{ bmp, png, sizes }` |
| `POST` | `/publish` | render, then push to Adafruit IO with the server's key |
| `GET` `POST` | `/canvas` | read / persist the canvas layout to `data/canvas.json` |
| `POST` | `/display/add` | build a `display.Add` descriptor -> ProtoMQ echo |
| `POST` | `/display/send-bmp` | chunk a BMP into canvas writes -> ProtoMQ echo |
| `POST` | `/sleep/config` | build a `sleep.SleepConfig` -> ProtoMQ echo |
| `GET` | `/sleep/status` | poll for device events (write-complete, goodnight, checkin) |
| `POST` | `/sleep/wake-response` | re-register the broker's wake response |
| `POST` | `/reset` | clear the watch, the broker's wake response and autoresponders, and the canvas |

The `/display/*` and `/sleep/*` group is the **WipperSnapper** path and needs a
ProtoMQ broker at `PROTOMQ_URL`. The **CircuitPython** path never touches this
server: the editor talks to Adafruit IO feeds directly, per the specs in `docs/`.

## Documentation

The wire formats, each one its own contract:

- [`docs/marquee-canvas-state.md`](docs/marquee-canvas-state.md) — the `{group}.canvas-state` feed: the editable scene, parked on Adafruit IO
- [`docs/marquee-sleep.md`](docs/marquee-sleep.md) — the `{group}.sleep` feed: how long to sleep and what to wake on
- [`docs/marquee-status.md`](docs/marquee-status.md) — the `{group}.status` feed: what the board reports back
- [`docs/cfg-marquee.md`](docs/cfg-marquee.md) — the `cfg-marquee.json` display descriptor format

## Known gaps

- **No CircuitPython bundle builder.** Screen A6 downloaded a ZIP of `code.py`,
  `settings.toml` and `cfg-marquee.json`. It was parked before this repo's first
  commit — never initialised, and importing router exports that no longer
  existed — so its two modules were unreachable and were removed rather than
  committed broken. [`docs/cfg-marquee.md`](docs/cfg-marquee.md) is retained as
  the format spec for whoever rebuilds it.
- **`code.py` does not read the sleep feed yet.** The publisher side is
  complete; the round trip is not. See
  [`docs/marquee-sleep.md`](docs/marquee-sleep.md).
- **`protobufs/protomq-bundle.json` is a vendored copy** of ProtoMQ's bundle and
  must be re-synced by hand if those protos change. A missing or malformed
  bundle degrades the `/display/*` and `/sleep/*` endpoints to `501` instead of
  crashing the server.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adafruit Industries.
