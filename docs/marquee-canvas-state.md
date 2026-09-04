# The canvas-state feed — `{group}.canvas-state`

The **editable scene** — `canvas.json`, verbatim — parked on Adafruit IO so that the
design stops living only in the browser that drew it.

- **Producer:** the editor, from `scheduleCanvasStatePublish()` in
  `public/js/device/canvasfeed.js`, called by `saveCanvasNow()` in `public/js/core/doc.js`.
- **Consumer:** the editor, from `readCanvasState()` in the same module, called by
  `hydrateFromCanvasFeed()` in `public/js/device/activate.js`.
- **The board never touches it.** It is not part of anything written to the board.

This is the one feed in the group that is editor-to-editor. Everything else on
`{group}` is a conversation with the hardware: `.bitmap` is what it draws, `.sleep` is
how long it waits, `.status` is what it reports back. Those three describe the panel.
This one describes the *document behind* the panel — the elements, their positions,
their feed bindings — which is the only thing in the system a second machine could not
reconstruct.

## Why it exists

The document had two homes and neither of them travelled:

| where | written by | who can read it |
|---|---|---|
| `marquee.canvas.<id>` in localStorage | `saveCanvas()` in `devices.js`, every 400ms | one browser profile on one machine |
| `canvas.json` on the render backend | `persistCanvas()` in `doc.js` | whoever can `cat` the file on the bench |

So opening a display on a laptop that had never edited it showed an **empty canvas**
for a board that was, at that moment, drawing a dashboard. The bitmap feed had the
picture; nothing anywhere had the scene that made it. Clicking a display on A1 now
fetches this feed, populates the canvas, and caches a render of it as
"On the panel now" — see the sequence below.

## The feed key

`{ADAFRUIT_IO_GROUP}.canvas-state` — `canvasStateFeedKey()` in `public/js/core/api.js`,
derived from the group like every other key here, so renaming a display moves all four
feeds together.

**Keep feed history OFF.** History caps a datum at 1 KB (`IO_MAX_HISTORY`); a scene
with two labels is already past that and one with an embedded image runs to hundreds
of kilobytes. Off, the ceiling is 512 KB (`IO_MAX_NO_HISTORY`), which is what
`flush()` gates on. It is the same reasoning as `.bitmap`, and it has the same
consequence: **the feed holds exactly one datum, the current one.** There is no
history of a design here and there is not meant to be — `/data` returns `[]` and
`/data/last` is the only useful read.

## The payload

The `value` is the `canvas.json` document as a **string**, exactly as `serialize()`
in `doc.js` produced it and exactly as `saveCanvas()` stored it — same convention as
`.sleep` and `.status`, and byte-identical to the localStorage copy on purpose (see
"Who wins"). No wrapper, no envelope, no separate version field: `doc.version` is
already in there, and a second one describing the transport would be a second thing to
keep in step.

```json
{"version":1,"display":{"width":122,"height":250,"rotation":270,"type":"tricolor",…},"elements":[{"etype":"label","x":68,"y":10,…}]}
```

## Cadence — why it is not the autosave

`doc.js` debounces its save at 400ms, which is right for localStorage and would be one
IO datum per keystroke. `canvasfeed.js` adds its own timing on top:

| knob | value | why |
|---|---|---|
| `DEBOUNCE_MS` | 3000 | a drag, a resize, or a sentence typed into a label is **one** datum |
| `MIN_GAP_MS` | 15000 | a floor between publishes however busy the canvas is — IO's rate limit is an account-wide budget shared with every element binding on the canvas |
| de-dupe | exact payload | a save that serializes identically never reaches the network |

A failed publish costs nothing: the document is already in localStorage, `lastPublishedJson`
is dropped, and the next edit carries the whole scene up again. The user is told **once**
per session and never again — this is a background mirror, not an action anyone took.

## Who wins when the two disagree

`hydrateFromCanvasFeed()` in `activate.js`, run on every device activation and *not*
awaited, so a slow or unreachable IO never delays the editor opening.

1. **Nothing on the feed** → keep what is here. Includes the honest case of a display
   that has genuinely never been drawn on.
2. **Same scene both ends** → nothing to decide. Compared on the **bytes**, against the
   stored document rather than a fresh `serialize()` — a round trip through Konva can
   differ in a rounded coordinate and would read as a change that is not one. This is
   the ordinary case (a browser reading back its own publish) and it deliberately does
   not depend on any clock.
3. **Nothing saved here** → the feed wins. The case the feed exists for.
4. **Feed newer than the local save** → the feed wins. Somebody edited elsewhere.
5. **Local newer** → keep it; the publish debounce carries it up on its own.

The stamps in 4 and 5 are `marquee.canvasAt.<id>` (this machine's clock, written by
`saveCanvas()`) against the datum's `created_at` (IO's clock). They are two clocks and
there is no third: a datum is stamped by the server, a localStorage write by the
browser. Rule 2 is what keeps the common path off that comparison entirely.

## What happens after a hydrate

In order, all of it guarded on the active device not having changed underneath:

1. `noteCanvasStateSeen()` — so the save below does not echo the scene straight back up.
2. `cancelCanvasSave()` — the local document's autosave is still pending from the
   deserialize in `rehydrateFor()`, and letting it fire would write the scene being
   replaced back over the record.
3. `deserialize(doc, { keepDisplay: true })` — the panel descriptor is **this** bench's.
   The `display` block inside a document authored elsewhere describes that machine's
   idea of the panel, not the pins in front of the user.
4. `saveCanvasNow()` — localStorage, the `canvas.json` mirror, and the timestamp.
5. `whenCanvasSettled()` — images decode asynchronously, and photographing the canvas
   early caches a panel with holes where the artwork goes.
6. `capturePanelFromCanvas()` in `screens/a8.js` — renders the scene through the
   backend and files the BMP under `marquee.panelNow.<id>`, so the A1 tile shows the
   display instead of "Nothing drawn yet" and A8's left-hand glass is not empty.

Step 6 is the one place that cache is written from something other than a feed datum,
and it is the weaker claim: a real take always outranks it, because `fetchTakes()`
overwrites `lastDrawn` from `.bitmap` on its next pass and only falls back to the cache
when IO has nothing to say.

## Displays that predate this feed

A5b creates the whole set at setup and never runs again for a display that is already
configured, so an existing bench has a group with three feeds in it. The first publish
gets a **404**, and `createMissingFeed()` answers it: create the feed, send again, say
nothing. Once per feed per session, on the 404 rather than speculatively — an account
that is out of feeds, or a key without write access, must not have that retried behind
the user's typing.

## What is deliberately not here

**The rendered picture.** That is `.bitmap`, which the board actually reads. Publishing
a render here would put two representations of one scene on one group and invite them
to disagree.

**Any board-side consumer.** A board parsing a Konva document to redraw
it locally is a different product. The board gets a bitmap.

**A history of designs.** Ruled out by the 1 KB history cap before it was ruled out on
taste, but it would be the wrong shape anyway: version history is a repository's job,
and `Export JSON` in the editor is the manual door out.

**Credentials, pins or identity.** The `display` block is geometry, rotation, colour
mode and dither settings — never a pinout, an Adafruit IO username or a key. That is
what makes the document safe to leave sitting on an account, and the geometry it does
carry is read as advisory anyway: `deserialize(…, { keepDisplay: true })` above keeps
the bench's own descriptor, because a document authored on another machine describes
that machine's idea of the panel.

## Known gaps

- **Last write wins, and nobody is told.** Two browsers editing one display will each
  publish over the other; the loser finds out by watching their canvas change on the
  next activation. There is no merge, no conflict marker and no lock, and for a bench
  tool with one user that is the right amount of machinery.
- **It hydrates on activation only.** Not on a timer and not on a subscription, so a
  scene changed elsewhere while you are sitting in the editor does not arrive until you
  switch displays or reload. Deliberate for now: polling a feed this large on a
  cadence would spend the account's rate limit on a case that almost never happens.
- **A scene over 512 KB is not mirrored.** `elements.js` allows a 25 MB embedded image,
  so this is reachable by an ordinary drag-and-drop. Said once, and the document is
  still saved locally — but that display will not open on another machine.
- **The clock comparison is best-effort.** See "Who wins": a browser clock hours ahead
  of IO's makes rule 5 swallow a genuine remote edit. Rule 2 covers the common case,
  and closing the rest would mean recording the datum's `created_at` at publish time
  and comparing IO's clock against itself.
