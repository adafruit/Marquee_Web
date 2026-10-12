# Marquee renderer

Renders a canvas.json to the panel's BMP on a server, with the editor's own `lib/`
(`../public/js/lib`): Konva on [skia-canvas](https://skia-canvas.org), which is Skia like
Chrome, with the same bundled IBM Plex and Font Awesome faces. Adafruit IO calls it to keep a
display current while nobody has the editor open.

## Input and output

```json
{ "doc": { "version": 1, "display": { "background": "#F2F4EF" }, "elements": [ ] },
  "display": { "width": 128, "height": 296, "rotation": 0, "panel": "magtag", "type": "mono",
               "dither": "FloydSteinberg", "diffusion": 85, "orderedMap": 8 },
  "now": 1792000000000,
  "timeZone": "America/New_York" }
```

- `doc`: canvas.json with feed readings already baked in (`feedValue`, `gaugeValue`, `value`,
  `series`; the keys `lib/samples.js` names). The caller reads the feeds; the renderer never does.
- `display`: the panel. Defaults to the document's own `display`.
- `now`: epoch ms. Date & time elements show this instant.
- `timeZone`: the zone a date & time element with none set uses (the account's). An unknown
  zone falls back to UTC.

Returns `{ base64, sha, bytes, width, height }`: the base64 BMP3 to publish to `{group}.bitmap`,
its sha256 (to skip publishing an unchanged picture), and its size. A bad request returns
`{ error }`.

## Running it

```sh
npm install
npm test              # npm run test:update after a change that moves pixels on purpose
npm start             # POST /render on :3080 (PORT to change), GET /health
```

`lambda.js` exports `handler` for AWS Lambda (Node.js 22 or later). The deployed package needs
`renderer/` plus `../public/js/lib` and `../public/fonts`, which it imports by relative path, and
a skia-canvas native binary built for the Lambda's platform: install on (or for) Linux on the
function's architecture, not on a Mac.
