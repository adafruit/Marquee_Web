# Where the firmware comes from — the `firmware` branch

What A6-A downloads when it flashes a board: the latest release's `merged-flash.bin` for the
display's board, from an orphan branch of
[adafruit/Adafruit_Marquee](https://github.com/adafruit/Adafruit_Marquee) called `firmware`,
via `raw.githubusercontent.com`.

- **Producer:** the `publish` job in Adafruit_Marquee's `.github/workflows/build.yml`, which
  runs on every published GitHub Release.
- **Consumer:** `public/js/device/firmware.js` in the editor.

## Why not the Release page

A web page may only read a cross-origin download when the server sends
`Access-Control-Allow-Origin`. GitHub's release-asset CDN
(`release-assets.githubusercontent.com`) does not, and neither does the
`github.com/…/releases/download/…` redirect in front of it. The request succeeds on the wire
and the browser discards the bytes. `raw.githubusercontent.com` sends the header for any file
committed to any branch, so the publish job commits the binaries there. The Release page still
gets zips of the same directories, for people.

`raw.githubusercontent.com` caches for five minutes. The editor fetches `manifest.json` with
`cache: 'no-store'` so the browser adds no layer of its own; the worst case is seeing the
previous release for a few minutes, whose files still exist at their tag-scoped paths.

## Layout

```
manifest.json                                    the LATEST release — overwritten each publish
<tag>/manifest.json                              the same, kept per tag
<tag>/marquee-<env>/merged-flash.bin             what the editor downloads; written in pieces (see below)
<tag>/marquee-<env>/bootloader.bin
<tag>/marquee-<env>/partitions.bin
<tag>/marquee-<env>/boot_app0.bin
<tag>/marquee-<env>/firmware.bin
<tag>/marquee-<env>/build.json                   {"env","chip","flash_size","bootloader_offset"}
```

`<env>` is the PlatformIO environment: `magtag`, `adafruit_feather_esp32s3`, `x4pro`. The
editor maps a display preset onto one of these in `firmwareFor()` (`public/js/device/flash.js`):
MagTag → `magtag`, X4 Pro → `x4pro`, every bare panel → `adafruit_feather_esp32s3`.

## `manifest.json` (schema 1)

```json
{
  "schema": 1,
  "tag": "v1.0.0-alpha",
  "version": "1.0.0-alpha",
  "prerelease": true,
  "published_at": "2026-09-09T19:11:43Z",
  "commit": "2897961d…",
  "boards": {
    "magtag": {
      "bin": "v1.0.0-alpha/marquee-magtag/merged-flash.bin",
      "size": 1265344,
      "sha256": "d470a71f…",
      "chip": "ESP32-S2",
      "bootloader_offset": "0x1000"
    },
    "adafruit_feather_esp32s3": { "...": "..." },
    "x4pro": { "...": "..." }
  }
}
```

| key | notes |
|---|---|
| `schema` | always `1`. Bump when a consumer would have to change to read the file |
| `tag`, `version` | the release tag and the tag without its leading `v` — the version A6-A shows |
| `prerelease` | from the GitHub Release; A6-A labels it |
| `boards.<env>.bin` | path relative to the branch root |
| `boards.<env>.size`, `sha256` | of `merged-flash.bin`. The editor refuses a download that differs in either |
| `boards.<env>.chip`, `bootloader_offset` | informational; the editor's own board table is what gates the flash |

## What the editor does with it

1. `GET manifest.json` (`no-store`). 404 → "no release published yet"; wrong schema → error.
2. Look up `boards[<env>]`. Missing → the row switches to "Use a file instead…" with a hint.
3. `GET` the `bin`, streaming, with progress against `size`.
4. Compare the byte count and SHA-256 with the manifest. A mismatch is refused, never flashed.
5. The same `validateFirmware()` checks a file from disk gets (partition table at `0x8000`,
   `0xE9` header at the board's bootloader offset), then the chip check before the write.
6. The image is written in pieces, the way `pio run -t upload` writes bootloader, partition
   table, `boot_app0` and app separately. A write erases every sector it covers, so writing the
   raw file straight through would also erase the blank stretches in it — including `nvs` at
   `0x9000`. `imageToWrite()` reads the image's own partition table and leaves out every data
   partition whose bytes in the file are all `0xFF`; the rest goes to its own address. On the
   X4 Pro `nvs` is where the factory stores the panel calibration, and that is why the "erase
   the whole chip" option is hidden for that board (`allowErase: false` in the board table in
   `public/js/device/flash.js`) and refused by `flashDevice()`.
7. `validateFirmware()` also compares the flash size stamped in the bootloader header with the
   board's: the two ESP32-S3 builds (4 MB Feather, 16 MB X4 Pro) pass every other check
   for each other's board and would not boot.

The X4 Pro used to get only the app, at `0x10000`, Xteink style, so the chip's own bootloader
and partition table survived. That is wrong for this firmware: it needs the table above (its
`ffat` partition is where the `MARQUEE` drive lives) and `ota_0` selected in `otadata`, and a
chip carrying the OEM table, or one that had OTA'd to `ota_1`, came up without a drive or kept
running the old app. Writing all four pieces is what makes a flash from the editor and a
PlatformIO upload leave the chip in the same state.

Developers can point the editor at a local copy of this layout with
`localStorage.setItem('marquee.firmwareBase', 'http://localhost:3000/__fixture/')`
(`public/__fixture/` is gitignored).
