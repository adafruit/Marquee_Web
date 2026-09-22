# Adding a platform
LLM Note: This document provides guidance for adding a new platform to the Marquee Web project, including firmware, catalog entries, board tables, and settings form updates. You should follow each step carefully to ensure proper integration.

## What's a Platform?

Everything that is not mapped to a product board in `flash.js` is assumed to be a panel connected to a Feather. For example,

| Kind | Examples | Firmware build | Steps |
|---|---|---|---|
| **A whole product** — the panel is soldered to its own board | MagTag, Xteink X4 Pro | Its own PlatformIO env, its own `merged-flash.bin` | all of the below |
| **A bare panel** wired to a Feather ESP32-S3 | 2.13" Tri-Color FeatherWing, 7.5" breakout | Reuses `adafruit_feather_esp32s3` | 1, 2, 5, 6, 7 |


## 1. But First - Firmware

The editor cannot flash a board that has no build on the `firmware` [branch of the Adafruit_Marquee firmware repository](https://github.com/adafruit/Adafruit_Marquee/tree/firmware). Hardware support must be added here, and a new release created before making changes to the editor.

## 2. Add a Catalog Entry — `public/js/device/presets.js`

Add an object to `DISPLAY_PRESETS`, keyed by a short preset key (i.e: `magtag2`). Copy the nearest
existing entry and change every field:

| Field | What it is |
|---|---|
| `label` | The name in Settings' preset chips and the "Loaded the … preset" toast |
| `spec` | The line under the label: `296×128 · mono · SSD1680` — what the descriptor drives |
| `cardLabel`, `cardMeta` | What the A4 product card says instead, when the buyer's name differs from the panel's (the X4 Pro card says `4.3" · grayscale`) |
| `terms` | Extra words the A4 search box matches on: chip names, product ids, colloquial names |
| `photo` | A product shot, `img/panels/<name>.jpg`, added under `public/img/panels/`. Optional — a card without one shows a grey placeholder |
| `preset` | The **unrotated** frame-buffer as the driver is constructed — `128x296` for a portrait-scanning 2.9", not `296x128`. Storing the rotated size builds a driver with width and height transposed |
| `rotation` | `'0'`–`'3'`, the clockwise 90° step the firmware applies on top of that buffer |
| `mode` | `mono`, `gray4`, `tricolor`, `quadcolor` — must be a key of `PALETTES` in `palette.js` |
| `name`, `driver`, `panel` | Display name (`epd0`), driver IC, and the firmware panel id from step 1 |
| `pins` | `busy`, `dc`, `rst`, `cs`, `sramCs`, `mosi`, `sck`, `bus`. Spelled `D<n>` (the only form the firmware's `parsePin()` accepts) or `'-1'` for "not used" — including MOSI/SCK when the panel sits on a bus the firmware already knows |

Then decide whether it goes on the menu. `FEATURED_KEYS` is the shortlist screen A4 offers as cards;
everything else in the catalog stays reachable by preset key but is not shown to a first-time
user.

## 3. Edit the Board Table — `public/js/device/flash.js` (Products Only)

Make 2 edits here:

- Add an entry to `BOARDS`, keyed by the env name from step 1, with `board`, `label`, `chip`,
  `bootloaderOffset`, `flashSize` and `allowErase`. Take `chip`, `bootloaderOffset` and
  `flashSize` from the firmware's `build.json` (found [here](https://github.com/adafruit/Adafruit_Marquee/tree/firmware)), not from memory. This check is what stops a MagTag image from bricking an ESP32-S3, and the flash-size check is the only thing that can tell two ESP32-S3 builds apart.
- Map the preset key onto it in `PRESET_BOARD` (i.e: `magtag2: 'magtag2'`). Without this line the preset silently resolves to the Feather build.

`allowErase` determines whether the option "erase the whole chip first" is offered to the user. If there is anything in NVS the board requires (like panel calibration), explicitly set it `false`.

`label` is the user-facing label copy. For example, on screen A6-A's "drive" step fill it into a sentences on the UX like "reset the MagTag".

## 4. Edit the Settings form — `public/index.html`

`applyDisplayPreset()` in `config.js` assigns the form's `<select>`s **by value**. A value that
is not an `<option>` does not error; the select keeps its previous value and the preset appears
to load with the wrong resolution or driver. Check both:

- `#preset` — The resolution list. Add an option here if the `preset` string from step 2
  (`800x400`, say) does not already exist.
- `#pmDriver` — The driver list. Add the chip if it does not already exist.

Rotation and mode selects already cover every legal value.

## 5. Testing

- `test/flash.test.mjs` — Ensures the `firmwareFor()` function resolves the
  preset to the right board and that `validateFirmware()` accepts the board's image.
- `test/firmware.test.mjs` - Ensures that manifest handling did not change.

Run the test suite:

```sh
npm test
```

## 7. Full Example: Xteink X4 Pro Pocket eReader 

The `3096201` (board images, A4 cards) and `44c1b0b` (flash table, validator, A6-A copy,
tests, docs) follow this checklist applied to a product. Their diff is the best reference for how much comment each table expects.
