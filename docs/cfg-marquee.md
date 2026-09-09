# The device configuration file — `cfg-marquee.json`

What the board reads at boot: which panel it is driving and how it is wired, which
network to join, and which Adafruit IO account and group to fetch from. One JSON file,
written to the board's filesystem at flash time.

- **Producer:** `device/cfg.js` in the editor (`public/js/device/cfg.js`). Every device
  record carries the file as `rec.cfg`, rebuilt from the live settings after each step
  of setup. A6-A shows it under **Show JSON config** and writes it onto the board's USB
  drive (`device/drive.js`), or offers it as a download to copy over by hand.
- **Consumer:** the board's firmware, which reads it from the root of its FAT filesystem
  at boot.

The editor collects these facts on four different screens — A1-C the account, A4 the
panel, A5b the group, A5C the network — and used to keep them in four different
stores. This file is the single assembled form, and the debug view exists so it can be
checked before there is a board to check it on.

## Worked example

A MagTag on the group `kitchen-board`:

```json
{
  "cfg_version": 2,
  "name": "kitchen-board",
  "display": {
    "driver": "SSD1680",
    "panel": "magtag-2025",
    "width": 128,
    "height": 296,
    "rotation": 3,
    "mode": "mono"
  },
  "interface": {
    "type": "spi_epd",
    "spi_bus": 0,
    "pins": { "cs": 8, "dc": 7, "reset": 6, "busy": 5, "sram_cs": -1, "mosi": 35, "sck": 36 }
  },
  "network": { "wifi_ssid": "Transit", "wifi_password": "BigWindows" },
  "adafruit_io": { "username": "brentrubell", "key": "aio_XXXXXXXXXXXXXXXXXXXXXXXXXXXX" }
}
```

## Fields

### `cfg_version` — integer, always `2`

The shape of this document. Bump it when a consumer would have to change to read a
new file; do not bump it for an added optional key.

### `name` — string

**The Adafruit IO group key.** One name, four feeds: the board derives `{name}.bitmap`,
`{name}.sleep`, `{name}.status` and `{name}.canvas-state` from it, exactly as
`public/js/core/api.js` does on the editor side. A5b resolves it, and Adafruit IO gets
the last word — the key IO hands back is the one written here, even when it differs
from the slug of what was typed.

Empty until A5b has run.

### `display` — object, or `null` until A4 has picked a panel

| key | type | source | notes |
|---|---|---|---|
| `driver` | string | `#pmDriver` | the controller, as the datasheet names it: `SSD1680`, `SSD1683`, `JD79661`, `UC8179`, `UC8279`… |
| `panel` | string | `#pmPanel` | `{size}-{resolution}-{color_mode}` for a bare panel, `{vendor}-{product}` for one inside a product |
| `width`, `height` | integer | `#resW`, `#resH` | the **unrotated** framebuffer, as the driver is constructed — `(128, 296)` for a MagTag, not `296×128` |
| `rotation` | integer 0–3 | `#rotSel` | clockwise 90° steps applied on top of the native buffer: `0`→0°, `1`→90°, `2`→180°, `3`→270°. The editor stores degrees; this is `round(deg / 90) mod 4` |
| `mode` | string | `#dtype` | `mono` \| `grayscale4` \| `tricolor` \| `quadcolor`. The editor's own name for the second is `gray4`; it is the one that is renamed |
| `colstart` | integer, **optional** | `#pmColstart` | column offset of the live glass inside the controller's RAM. Present only when non-zero: the FeatherWing tri-color needs `8`, the SSD1680Z breakout `-8`. Absent means no shift |

### `interface` — object, or `null` until A4 has picked a panel

| key | type | notes |
|---|---|---|
| `type` | string | `spi_epd`. The only interface this editor describes |
| `spi_bus` | integer | which hardware SPI bus; `0` on every catalogued board |
| `pins.cs` | integer | EPD chip select |
| `pins.dc` | integer | data/command |
| `pins.reset` | integer | |
| `pins.busy` | integer | |
| `pins.sram_cs` | integer | the frame-buffer SRAM's chip select, if the panel carries one |
| `pins.mosi`, `pins.sck` | integer | the SPI bus pins |

**Pins are bare GPIO numbers.** The editor's form spells them the way the device's
`parsePin()` reads them — `D8` — and this file strips the prefix: `D8` → `8`. A blank
field, `-1`, and anything that is not a pin at all all become **`-1`, "not wired"**. A
typo therefore produces a pin the board refuses rather than one it silently drives.

### `network` — object

| key | type | notes |
|---|---|---|
| `wifi_ssid` | string | empty until A5C has run |
| `wifi_password` | string | may be empty: an open network is a real configuration |

The one block that is *authored* rather than derived. Everything else in this file is
rebuilt from the editor's settings fields on every change; the network has no other
home, so A5C writes it here directly and the rebuild carries it forward.

### `adafruit_io` — object

| key | type | notes |
|---|---|---|
| `username` | string | the account A1-C verified |
| `key` | string | its active key, in plain text |

Account-scoped in the editor — every display in one browser shares them — and copied
into each display's file, because each board is on its own once flashed.

**Not carried:** the host. The editor's Developer-mode toggle moves the whole app to
`io.adafruit.us`, and a board reading this file has no way to know. A board is assumed
to talk to `io.adafruit.com`.

## How it reaches the board

Not over serial. The firmware mounts the FAT partition on its own flash and exposes it over
USB mass storage as a volume named `MARQUEE`, then opens `/cfg-marquee.json` on it. With no
file there, `begin()` returns `ERR_FS_NO_CFG_FILE` and the sketch halts with the drive still
mounted — which is the state A6-A's drive step writes into.

A6-A uses the File System Access API: the user picks the `MARQUEE` volume in a directory
dialog, the editor writes the file at the top level and reads it back to check. Then the user
**ejects the drive and presses RESET**: the file is read at boot only, and ejecting first
flushes the host's write cache. A board sent back through setup to change networks comes back
to this step and overwrites the file; the firmware itself is not re-flashed.

A full chip erase (the opt-in box on A6-A) removes the volume: the firmware does not format
the partition, so the drive comes back unformatted and has to be formatted FAT with the label
`MARQUEE` before the file can be written.

## Where it lives in the editor

`rec.cfg` on the device record, inside the `marquee.devices` localStorage key —
alongside the settings and the panel descriptor it is built from. It is written by
exactly one function, `syncCfg()`, which runs after every descriptor save, every
settings save, on every device switch, and just before A6-A shows or writes the file.

That means the file is never older than the last edit, and a record from a build that
predates it gets one the first time it is opened. It also means a **plain-text Wi-Fi
password and Adafruit IO key sit in localStorage** for every display — acceptable for a
bench tool on your own machine, and said on screen at A5C and A6-A.

## Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/adafruit/Marquee_Web/docs/cfg-marquee.schema.json",
  "title": "cfg-marquee.json",
  "type": "object",
  "required": ["cfg_version", "name", "display", "interface", "network", "adafruit_io"],
  "properties": {
    "cfg_version": { "const": 2 },
    "name": { "type": "string", "pattern": "^[a-z0-9-]*$" },
    "display": {
      "type": ["object", "null"],
      "required": ["driver", "panel", "width", "height", "rotation", "mode"],
      "properties": {
        "driver":   { "type": "string" },
        "panel":    { "type": "string" },
        "width":    { "type": "integer", "minimum": 1 },
        "height":   { "type": "integer", "minimum": 1 },
        "rotation": { "type": "integer", "minimum": 0, "maximum": 3 },
        "mode":     { "enum": ["mono", "grayscale4", "tricolor", "quadcolor"] },
        "colstart": { "type": "integer" }
      }
    },
    "interface": {
      "type": ["object", "null"],
      "required": ["type", "spi_bus", "pins"],
      "properties": {
        "type":    { "const": "spi_epd" },
        "spi_bus": { "type": "integer", "minimum": 0 },
        "pins": {
          "type": "object",
          "required": ["cs", "dc", "reset", "busy", "sram_cs", "mosi", "sck"],
          "additionalProperties": { "type": "integer", "minimum": -1 }
        }
      }
    },
    "network": {
      "type": "object",
      "required": ["wifi_ssid", "wifi_password"],
      "properties": {
        "wifi_ssid":     { "type": "string" },
        "wifi_password": { "type": "string" }
      }
    },
    "adafruit_io": {
      "type": "object",
      "required": ["username", "key"],
      "properties": {
        "username": { "type": "string" },
        "key":      { "type": "string" }
      }
    }
  }
}
```

`display` and `interface` are nullable only in the editor's in-progress copy. A file
written to a board always has both.
