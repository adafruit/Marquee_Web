# Server-side live takes — design

How a display stays current with its bound feeds while nobody has the editor open.

- **Status:** proposed. Nothing here is built yet. The renderer half exists on the
  `refactor-modules` branch (`renderer/`, `public/js/lib/`); the IO half does not.
- **Scope:** a stop-gap until Marquee is fully integrated into Adafruit IO / Learn. The
  editor stays a static site on GitHub Pages; only the *live take* moves to a server.

Today the live take ("The live take" in [`marquee-sleep.md`](marquee-sleep.md)) runs in
the browser: `device.js` re-reads every bound element on the board's `sleeping` report,
re-renders, and republishes `{group}.bitmap`. Close the tab — or let the browser put it
to sleep — and the panel freezes on whatever was last pushed. This design moves that
loop into Adafruit IO, with rendering in an AWS Lambda.

## The split

| Component | Runs on | Owns |
|---|---|---|
| **Marquee Web** (editor) | GitHub Pages, static | Designing, binding feeds, manual push, provisioning and flashing, showing status. Mirrors the scene to `canvas-state`. |
| **Board** | Device firmware | Wake, fetch `{group}.bitmap`, draw, report `awake` / `sleeping` on `{group}.status`, sleep. |
| **Adafruit IO** (io-rails) | IO infrastructure | When a take is due (Sidekiq), reading bound feeds, permission checks, invoking the renderer, writing the bitmap. |
| **io-node** | IO infrastructure | MQTT broker; forwards publishes to Rails, fans out what Rails publishes. Unchanged. |
| **Marquee renderer** | AWS Lambda (container image) | A pure function: scene + readings + time → BMP. No credentials, no network calls. |
| **`lib/`** | Inside the editor *and* the Lambda | Scene model, bindings, render, dither, fonts — the one definition of how a design becomes pixels. |

IO is the manager; the Lambda only draws. Keeping the renderer pure is the point: it
holds no AIO keys, needs no access to IO, and cannot publish anything by itself.

## Feeds

One IO group per display, exactly as today. The design adds no storage.

| Feed | Written by | Read by | Holds |
|---|---|---|---|
| `{group}.canvas-state` | editor | editor, Sidekiq | the scene (`canvas.json`), history off, ≤ 512 KB — [`marquee-canvas-state.md`](marquee-canvas-state.md) |
| `{group}.bitmap` | editor (manual push), Sidekiq (live take) | board | base64 indexed BMP3, history off |
| `{group}.status` | board | Sidekiq (trigger), editor | `awake` / `sleeping` — [`marquee-status.md`](marquee-status.md) |
| `{group}.sleep` | editor | board, Sidekiq (fallback sweep) | the sleep window — [`marquee-sleep.md`](marquee-sleep.md) |
| the user's own feeds | sensors, anything | Sidekiq, editor | the readings widgets are bound to |

## Architecture

```
┌────────────────────┐     design / manual push      ┌──────────────────────────────────┐
│  Marquee Web       │ ────────────────────────────► │          Adafruit IO             │
│  (GitHub Pages)    │ ◄──── status, previews ────── │                                  │
│  lib/ in browser   │                               │  feeds: canvas-state, bitmap,    │
└────────────────────┘                               │         status, sleep, user feeds│
                                                     │                                  │
┌────────────────────┐   MQTT / HTTP (io-node)       │  Feed#add_data ──hook──┐         │
│  Board             │ ── status: sleeping ────────► │                        ▼         │
│  (firmware)        │ ◄── bitmap /data/last ─────── │  MarqueeLiveTakeWorker (Sidekiq) │
└────────────────────┘                               │   • lock per group               │
                                                     │   • read canvas-state + feeds    │
                                                     │   • permission checks as owner   │
                                                     │   • invoke Lambda ───────────┐   │
                                                     │   • sha check, add_data ◄─┐  │   │
                                                     └───────────────────────────┼──┼───┘
                                                                                 │  ▼
                                                     ┌───────────────────────────┴──────┐
                                                     │  Marquee renderer (AWS Lambda)   │
                                                     │  lib/ + Konva + skia-canvas      │
                                                     │  + bundled fonts                 │
                                                     └──────────────────────────────────┘
```

## Flows

### Design and manual push — unchanged

1. The user edits in the browser; `lib/` draws the preview.
2. The editor mirrors the scene to `{group}.canvas-state` (debounced; see
   `canvasfeed.js`).
3. **Push** renders in the browser and writes `{group}.bitmap` and `{group}.sleep`.
4. The board shows it on its next wake.

A design change still goes out directly from the editor. The server only keeps an
existing design current.

### The board's cycle — unchanged

Wake → publish `awake` → fetch `{group}.bitmap` (`/data/last`) → draw → publish
`sleeping` with `sleep_time` → sleep.

### The live take — new, server-side

1. **Trigger.** A `sleeping` datum reaches `Feed#add_data`
   (`io-rails/app/models/concerns/feed_data_management.rb`), the one path every datum
   takes — MQTT (io-node enqueues `FeedFromNode` for every publish), REST, webhooks and
   actions. Next to `FeedDataDispatchWorker.dispatch_async`, inside the "newest datum"
   block, a filter that costs no query until it matches:
   1. the feed's key is `status` (string compare);
   2. the value contains `sleeping` (string compare);
   3. one query: does one of the feed's groups also hold a `canvas-state` feed?

   On a match: `MarqueeLiveTakeWorker.perform_in(5.seconds, feed.id, group.id)` — the
   editor's `LIVE_SETTLE_MS`.
2. **Guards.** One take per group (`sidekiq-unique-jobs`, `lock: :until_executed`, as
   the timer workers already use). At least 30s since the last take
   (`LIVE_MIN_GAP_MS`). Skip a group whose `{group}.bitmap` was never pushed.
3. **Plan.** Ask the renderer what the scene reads (`{ op: "plan" }`). Cached per group,
   keyed on `canvas-state`'s `last_value_at`, so it is recomputed only when the design
   changes. An empty plan with no date & time element means nothing can change: stop.
4. **Read.** For each read in the plan: resolve the key (plain, `group.key`, or a shared
   `owner/key`), check `Permission.has_permission?(feed, 'r', owner)`, then read
   `feed.last_value` (Postgres; works with history on or off) or the chart service
   (`{ columns, data }`).
5. **Render.** Invoke the Lambda synchronously with
   `{ doc, readings, now, timeZone: owner.time_zone }` → `{ base64, sha }`.
6. **Publish.** If `sha` differs from the last one stored for the group:
   `bitmap_feed.set_working_key(group)`, then `bitmap_feed.add_data(value: base64)`. That
   sets the last value the board fetches on wake, applies IO's size limits, and fans out
   over MQTT on the grouped topic to any open editor. Without `set_working_key`,
   `publishing_key` falls back to `groups.first`, which need not be the topic the board
   subscribes to.

Why `sleeping` and not a timer: the report means the alarm is armed, so the whole
window is free and nothing races the board's fetch, and every board's cycle is its own
(the sleep interval plus a panel refresh of anywhere from seconds to minutes). A fixed
schedule would land mid-refresh and buy a second redraw. It also costs nothing for a
board that is off: no report, no take. Rendering on every bound-feed update is not
needed either — the board only fetches on wake, so one take per sleep already shows the
newest reading the panel could show.

### Fallback sweep

Boards that never report status (older firmware) get a scheduled take instead.
`rake marquee:sweep`, added to `io-rails/config/schedule.rb` beside the other
`every 1.minute` tasks, enqueues a take for any Marquee group with no recent status
report whose sleep interval (`{group}.sleep`, or a default) has passed since its last
take. This is the server's version of the editor's estimated clock. Once all firmware
reports status, it is a safety net.

## Contracts

### Renderer (Lambda)

```
plan:   { op: "plan", doc }
          → { reads: [{ feed, kind: "last" | "chart", hours, raw }], datetime: bool }

render: { doc, readings, now, timeZone }
          → { base64, sha, bytes, width, height } | { error }

        readings = { last:  { "<feedKey>": "<value>" | null },
                     chart: { "<feedKey>": { columns, data } } }
```

- `doc` is `canvas-state` verbatim. Panel, palette and dither come from `doc.display`,
  which `serialize()` writes in full.
- `readings.chart` is IO's own chart shape — what `/data/chart` returns and what the
  extracted chart service will return — so IO passes it through unconverted. Columns are
  resolved by name, as `readFeedHistory()` does today.
- A missing or `null` reading keeps the value already in the doc: one failed read never
  blanks an element, the rule `refreshFeedElements()` follows today.
- `timeZone` stands in for `timeTz: ""`, which in the browser meant "the pushing
  browser's zone". The editor should use the account's zone too, so a date & time
  element reads the same whoever published last.
- Invoked synchronously (`RequestResponse`); request and response both fit easily inside
  Lambda's 6 MB limit (`canvas-state` is capped at 512 KB).

### Board ↔ IO

Unchanged: [`marquee-status.md`](marquee-status.md), [`marquee-sleep.md`](marquee-sleep.md).

## Shared rendering code

`lib/` runs in two hosts:

- **browser** — the editor's Konva on Chrome's canvas, for preview and manual push;
- **Lambda** — Konva on skia-canvas, with the same bundled IBM Plex and Font Awesome
  files (`lib/fonts.js`).

Three things keep them in step:

- `test/lib-boundary.test.js`: `lib/` imports only `lib/` and never touches the page;
- the renderer's snapshot test, which pins the server's own bytes;
- a browser-vs-server comparison (Puppeteer) on the same scene, passing under a pixel
  difference threshold — Chrome's Skia and skia-canvas anti-alias text slightly
  differently, and dithering amplifies small differences.

Bindings live in `lib/` too (`lib/bindings.js`: `feedReads(doc)`, `bakeReadings(doc,
readings)`), absorbing `feedBoundElements`, `downsample` and the chart row parsing from
`device/feeds.js`. The editor's refresh and the server's take then share one answer to
"what does this scene read, and where does each reading go" — the per-etype value attrs,
chart downsampling, dropping unbound series — instead of IO reimplementing it in Ruby.

## Deployment

- The renderer ships as a **Lambda container image**: skia-canvas's Linux binary and the
  fonts travel together. Built by this repo's CI, pushed to ECR, tagged by commit.
- IO invokes it through a `:PRODUCTION` alias, exactly as `ImageFormatter`
  (`io-rails/app/services/image_formatter.rb`) does for `io-image-formatter`, with the
  existing `$lambda_client`. Moving the alias is the upgrade — a deliberate step, never
  a side effect of a merge here.
- Memory ≥ 1 GB (Lambda CPU scales with memory); timeout around 10s; retries belong to
  Sidekiq.

## Security

- **No user credentials leave IO.** The Lambda receives data only. The editor keeps
  using the user's key in the browser, as today.
- **Every read is authorized as the display's owner.** The scene is user-authored and may
  name `owner/key` shared feeds; each must pass `Permission.has_permission?` before it is
  read.
- **The renderer treats its input as hostile.** Image sources must be
  `data:image/...` URLs (skia-canvas's `loadImage` would otherwise fetch `http(s)` URLs),
  decoded images are size-capped, and the display must be a known panel or under a hard
  size cap.
- **Writes go through `add_data`**, so IO's size limits, disabled-feed checks and plan
  limits all apply.

## Failure behaviour

| Failure | Result |
|---|---|
| a bound feed cannot be read | that element keeps its last value; the take continues |
| Lambda error or timeout | Sidekiq retries once or twice; the board keeps the previous image |
| picture unchanged | not published (sha) |
| board never reports status | the fallback sweep covers it |
| bitmap feed disabled | skipped quietly — no Sentry noise |

## Cost

Per take: one Postgres last-value read per bound element, one chart query per chart
series, one Lambda invocation (about a second), and at most one datum write. A board
that is off or idle costs nothing.

## Work, by codebase

**Marquee Web** (`refactor-modules`, then main)

- `lib/bindings.js`; the editor's `refreshFeedElements` rebuilt on it.
- Renderer: the `readings` input, the `plan` op, input validation.
- Lambda container image and the CI that builds it.
- The browser-vs-server comparison test.
- A config flag that retires the browser live take once IO's is on. Manual push stays.
- Date & time elements default to the account's zone rather than the browser's.

**io-rails**

- A `FeedChart` service extracted from `DataController#aggregation_chart_responder`, and
  a feed-key resolver extracted from the `GroupFeedKeys` controller concern — both
  behaviour-neutral, so the worker can call them.
- `MarqueeRenderer`, modelled on `ImageFormatter`.
- `MarqueeLiveTakeWorker`, on the `default` queue (not `actions`, whose base worker sets
  `retry: 0`).
- The hook in `Feed#add_data`.
- `rake marquee:sweep` in `config/schedule.rb`.

**io-node:** none. **Firmware:** none.

## Rollout

1. Merge `refactor-modules` and the `lib/` work; deploy the Lambda to staging.
2. Ship the io-rails pieces behind a flag, on for a few test accounts.
3. For those displays, compare server takes with browser takes — sha and by eye — then
   turn it on for everyone.
4. Flip the editor flag that retires the browser live take.
5. When Marquee moves fully into IO / Learn, the renderer contract and `lib/` stay as
   they are; only where the editor is hosted changes.

## Open questions

- **How a status feed's key is stored in its group** — `status`, or a prefixed key such
  as `marquee-x-status`. `Feed#group_key` builds `"#{group.key}.#{feed.key}"`, which
  suggests the former, but check a real Marquee group before fixing the hook's filter.
- **Whether `User#time_zone` is an IANA name** (`America/New_York`), as `Intl` and
  `strftime()` need.
- **Who computes the plan.** The Lambda (one definition, an extra call, cached) or Ruby
  (one call fewer, a second definition). Recommended: the Lambda, cached per design.
