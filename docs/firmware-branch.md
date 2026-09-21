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
<tag>/marquee-<env>/merged-flash.bin             what the editor downloads; flashed at 0x0 (X4 Pro: see below)
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
6. **X4 Pro only:** Xteink firmware is flashed as the app alone, the way
   `esptool write_flash 0x10000 firmware.bin` does it, so the stock bootloader, partition table
   and the NVS holding the factory panel calibration survive. The editor still downloads the
   checksummed `merged-flash.bin`, then writes only the bytes from `0x10000` to the end, at
   `0x10000`. Those bytes are `firmware.bin`: the app is the last thing `merge-bin` lays down,
   so the merged image ends where the app ends. Before the write, `validateFirmware()` also
   requires an `0xE9` header at `0x10000` and an app-type entry starting at `0x10000` in the
   image's own partition table (`ota_0`). The "erase the whole chip" option is hidden for this
   board and refused by `flashDevice()`. The board table's `writeOffset` in
   `public/js/device/flash.js` is what selects this; every other board has `0`.

Developers can point the editor at a local copy of this layout with
`localStorage.setItem('marquee.firmwareBase', 'http://localhost:3000/__fixture/')`
(`public/__fixture/` is gitignored).
