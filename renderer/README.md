# Marquee renderer

Renders a canvas.json to the panel's BMP on a server, with the editor's own `lib/`
(`../public/js/lib`): Konva on [skia-canvas](https://skia-canvas.org), which is Skia like
Chrome, with the same bundled IBM Plex and Font Awesome faces. Adafruit IO calls it to keep a
display current while nobody has the editor open — see
[`docs/server-live-take.md`](../docs/server-live-take.md) for the whole design.

It is a pure function. It holds no credentials, reads no feeds and publishes nothing: the host
asks what a document reads (`plan`), fetches that, and passes the results in (`render`).

## Operations

### `plan` — what a document reads

```json
{ "op": "plan", "doc": { "version": 1, "elements": [ ] } }
```

```json
{ "reads": [ { "id": "temp", "feed": "temp", "kind": "last" },
             { "id": "alice/hum@6h", "feed": "alice/hum", "kind": "chart", "hours": 6, "raw": false },
             { "id": "temp@24h/raw", "feed": "temp", "kind": "chart", "hours": 24, "raw": true, "limit": 640 } ],
  "datetime": true }
```

- `kind: "last"`: the feed's last value. `kind: "chart"`: a history window, the same query as
  `/data/chart?hours=…[&raw=true&limit=…]`.
- `feed` is a plain key, a group-qualified `group.key`, or `owner/key` for a feed shared with
  the display's owner. The host must check the owner may read it.
- `id` is where the result goes in `readings`. Reads are de-duplicated: two widgets on one
  feed are one read.
- `datetime: true` means the scene shows the time, so it changes on every take even when no
  feed does. No reads and no datetime means nothing can change: skip the take.
- The answer depends only on the design, so cache it until `canvas-state` changes.

### `render` — the picture

```json
{ "doc": { "version": 1, "display": { "background": "#F2F4EF" }, "elements": [ ] },
  "readings": { "last":  { "temp": "21.4" },
                "chart": { "alice/hum@6h": { "columns": ["date", "value"], "data": [["2026-10-12T10:00:00Z", "41"]] } } },
  "display": { "width": 128, "height": 296, "rotation": 0, "panel": "magtag", "type": "mono",
               "dither": "FloydSteinberg", "diffusion": 85, "orderedMap": 8 },
  "now": 1792000000000,
  "timeZone": "America/New_York" }
```

`op` is optional here (`"render"`).

- `doc`: canvas.json — `{group}.canvas-state` as-is.
- `readings`: optional, filed under the ids `plan` handed out. Chart readings are IO's
  `/data/chart` body (the value column is found by name, so aggregated bodies work too) or
  `[{ t, v }]`. A missing or `null` reading keeps the value saved in the document, as a failed
  read does in the editor; with no readings at all the document renders as saved.
- `display`: the panel. Defaults to the document's own `display`, which the editor saves in
  full.
- `now`: epoch ms. Date & time elements show this instant.
- `timeZone`: the account's zone. Date & time elements with no zone of their own use it, and
  so do chart time axes — a server's own zone (UTC on Lambda) means nothing to the user. An
  unknown zone falls back to UTC.

Returns `{ base64, sha, bytes, width, height }`: the base64 BMP3 to publish to `{group}.bitmap`,
its sha256 (to skip publishing an unchanged picture), and its size.

A bad request — not a version 1 document, a display without width/height/type, a side outside
8–4096 px (the editor's own bounds), an unknown display type, an unknown `op` — returns
`{ error }` rather than throwing.

## Untrusted input

The document is user-authored. Images are decoded only from `data:image/…` URLs; any other
`src` (an `http(s)` URL, a file path) is left out rather than fetched or read, and so is an
image over 4096 × 4096 decoded. Panel sides are capped as above.

## Determinism

Every canvas is pinned to skia-canvas's CPU rasterizer. skia-canvas uses a GPU when the
machine has one, and a GPU does not produce the CPU's bytes; Lambda has none. With the CPU
pinned, a laptop, CI and Lambda render the same sha (checked against the container through the
Lambda runtime emulator).

## Running it

```sh
npm install
npm test              # npm run test:update after a change that moves pixels on purpose
npm start             # POST /render or /plan on :3080 (PORT to change), GET /health
```

## The Lambda image

`lambda.js` exports `handler` (Node.js 22). It ships as a container image so skia-canvas's
native binary and the fonts travel together. Build from the **repo root** — the renderer
imports `public/js/lib` and `public/fonts` by relative path and the image keeps that layout:

```sh
docker build -f renderer/Dockerfile --platform linux/amd64 -t marquee-renderer .
```

Build for the function's architecture: skia-canvas installs a binary for the platform it is
installed on. Use **x86_64** (`linux/amd64`): that is where the container's output has been
checked byte-for-byte against a local render. arm64 is cheaper, but Skia's CPU rasterizer is
not guaranteed to produce the same bytes there, so prove it against the snapshot before
switching. With Docker rather than Podman, add `--provenance=false`, or the push can carry a
multi-platform index Lambda rejects.

To try it locally, the base image includes the Lambda runtime emulator:

```sh
docker run --rm -p 9000:8080 marquee-renderer
curl -s localhost:9000/2015-03-31/functions/function/invocations -d '{"op":"plan","doc":{"version":1,"elements":[]}}'
```

## Deploying

The function is `io-marquee-renderer`. Adafruit IO invokes it the way it invokes
`io-image-formatter` (`app/services/marquee/renderer.rb` in io-rails): staging calls the bare
name, which runs `$LATEST`, and production calls the `PRODUCTION` alias. So a new image is
live on staging as soon as the function's code is updated, and on production only when the
alias moves. CI builds the image but never pushes it; deploys are deliberate.

Run from the repo root, with `ACCOUNT` and `REGION` filled in (the region io-rails uses):

```sh
REPO=ACCOUNT.dkr.ecr.REGION.amazonaws.com/io-marquee-renderer
TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password | podman login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
podman build --platform linux/amd64 -f renderer/Dockerfile -t $REPO:$TAG .
podman push $REPO:$TAG
```

### The first time

```sh
aws ecr create-repository --repository-name io-marquee-renderer

# The role needs only AWSLambdaBasicExecutionRole: the renderer makes no AWS calls.
aws lambda create-function --function-name io-marquee-renderer \
  --package-type Image --code ImageUri=$REPO:$TAG \
  --architectures x86_64 --memory-size 1024 --timeout 15 \
  --role arn:aws:iam::ACCOUNT:role/YOUR_LAMBDA_ROLE

VERSION=$(aws lambda publish-version --function-name io-marquee-renderer --query Version --output text)
aws lambda create-alias --function-name io-marquee-renderer --name PRODUCTION --function-version $VERSION
```

- **Memory 1024 MB or more**: Lambda's CPU scales with memory, and a render is CPU-bound.
- **Timeout 15 s**: a take renders in about a second; the rest is cold-start headroom.
- **Invoke permission**: the AWS credentials io-rails runs with need `lambda:InvokeFunction` on
  `arn:aws:lambda:REGION:ACCOUNT:function:io-marquee-renderer` and on the same ARN with
  `:PRODUCTION` appended. The policy that already allows `io-image-formatter` is the place.

### Every time after

```sh
aws lambda update-function-code --function-name io-marquee-renderer --image-uri $REPO:$TAG
# staging runs it now; when it looks right there, move production:
VERSION=$(aws lambda publish-version --function-name io-marquee-renderer --query Version --output text)
aws lambda update-alias --function-name io-marquee-renderer --name PRODUCTION --function-version $VERSION
```

Rolling back is `update-alias` to the previous version number.

### Checking it

```sh
aws lambda invoke --function-name io-marquee-renderer:PRODUCTION --cli-binary-format raw-in-base64-out \
  --payload '{"op":"plan","doc":{"version":1,"elements":[{"etype":"gauge","feedKey":"wind"}]}}' out.json && cat out.json
# {"reads":[{"id":"wind","feed":"wind","kind":"last"}],"datetime":false}
```
