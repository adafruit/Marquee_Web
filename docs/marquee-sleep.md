# The sleep feed — `{group}.sleep`

How the editor tells the board how long to sleep and what to wake on. Three fields
on an Adafruit IO feed, and nothing else.

- **Producer:** `pushToDisplay()` in `public/js/device/device.js`, via
  `currentSleepPayload()`. Fired by "Push to display" in Act II.
- **Consumer:** the board's firmware. **Not yet implemented** — see Known gaps.

A feed rather than a field in the panel descriptor: timing is not a property of the
panel, and nothing about changing the interval should require reconfiguring the
board. Before this feed, the editor's "Wake and redraw" control had no route to the
board at all — the sleep window was a constant compiled into the firmware.

## The feed key

`{ADAFRUIT_IO_GROUP}.sleep` — the `sleep` feed inside the device's Adafruit IO
group, in IO's group-qualified form. With the default group `marquee`, that is
`marquee.sleep`.

Derived, not configured (`sleepFeedKey()` in `public/js/core/api.js`). Two independently
settable keys is two ways for a board to end up reading one feed and not the
other, and the pairing is not a decision anyone needs to make. Renaming the group
to `kitchen` moves the sleep window to `kitchen.sleep` with it, along with
`kitchen.bitmap` and `kitchen.status`.

**Both feeds must already exist on the account.** The IO data API 404s on an
unknown feed key; it does not create one for you. A5b (`public/js/screens/a5b.js`)
is what creates them, which is why it runs before the board is flashed.

## Worked example

```json
{"alarm_type": "timer+pin", "sleep_mode": "deep", "sleep_time": 900}
```

Published as the feed's `value`, so the consumer reads a **string** and parses it:

```python
resp = session.get(".../feeds/marquee.sleep/data/last", headers={"X-AIO-Key": key})
cfg = json.loads(resp.json()["value"])
```

## Fields

### `alarm_type` — `"timer"` | `"pin"` | `"timer+pin"`

What the board arms before it sleeps.

| value | arm |
|---|---|
| `timer` | one time alarm at `sleep_time` seconds |
| `pin` | one pin alarm |
| `timer+pin` | one of each — whichever fires first wakes the board |

**At most one alarm of each kind.** The combination is deliberately not a list:
one timer and one pin covers "redraw on a schedule, but let me force it", and
anything richer is a config format nobody asked for.

`pin` also fixes `sleep_mode` at `deep`, because it is the one value with no timer
to derive a mode from — see below.

Comes from the "Wake on" select in A7's inspector.

### `sleep_mode` — `"light"` | `"deep"`

**Derived from `sleep_time`, not chosen.** There is no sleep-mode control in the
editor: the interval already determines the right answer, and a second author for
one decision is how the editor and the board end up disagreeing — a 15-second
refresh set to Deep paid a full boot, re-provision and redraw every fifteen
seconds, and nothing in the UI said so.

| `sleep_time` | `sleep_mode` | why |
|---|---|---|
| < 60 s | `light` | under the MQTT keepalive the connection survives the nap outright — free |
| 60 s – 300 s | `light` | the reconnect is MQTT-only, still cheaper than boot + re-provision + redraw |
| ≥ 300 s | `deep` | past here the boot stops dominating, and holding RAM and a radio that long is the worse trade |

The first two rows agree, so the implementation is a single comparison at 300 s —
`sleepModeFor()` in `public/js/core/config.js`, which returns these two spellings
directly so the label a user sees and the value the board gets cannot drift. The
60 s row is the reasoning, not a value read from anywhere: nothing in the editor
reads a keepalive off the board.

**`alarm_type: "pin"` is the one exception, and is always `deep`.** A pin-only alarm
ignores `sleep_time` (see below), so there is nothing to derive from and it keeps the
default it always had. `timer+pin` has a time alarm making exactly the same trade as
a bare timer, so it follows the table.

That exception is worth knowing about rather than trusting: deep-sleep pin alarms
need an RTC-capable GPIO (see Known gaps), and pin-only has no timer to recover with.
The answer is the fallback this file already specifies — drop the pin and arm a
timer alarm at the firmware's own default interval, never deep-sleep with no alarm.

The two are not interchangeable for the consumer: a deep sleep never returns, while
a light sleep resumes in place — so firmware that supports `light` needs its take
wrapped in a loop. Both spellings are reachable from the
editor's own interval picker, so a consumer has to implement both rather than
treating `light` as an exotic case.

### `sleep_time` — integer seconds

The timer duration. Same value as the editor's refresh interval — the
`#sleepDuration` field, surfaced as "Wake and redraw" in A7 and read through
`refreshInterval()`.

**Always present, and ignored when `alarm_type` is `"pin"`.** Sending it
unconditionally keeps the payload one shape, and a pin-only alarm has no duration
to express. `0` means a time alarm in the past, so a consumer should treat it as
"do not sleep on the timer" rather than passing it through.

It now carries two facts rather than one — the duration *and*, through the table
above, the mode. `0` lands in the light band, which is the harmless answer for a
timer that is not going to be slept on anyway.

## What is deliberately not here

**The wake pin.** A pin alarm needs to know which pin, and that is a fact about
how the board is wired rather than about this take — so it belongs on the board
with the rest of its configuration. Re-sending it with every push would also mean
the editor had to know each board's button pins, which the panel catalog does not
carry.

The practical consequence: `alarm_type` can ask for a pin the board has no pin
for. That is the consumer's call to make, and the answer is to say so and fall
back to the timer, not to refuse to sleep.

**Credentials and the group key itself** — written to the board at flash time
(A1-C collects the account, A5b the group, A5C the network, A6-A writes them), as with the image feed.

**Anything about the panel** — the display descriptor, which this file does not
touch. It travels with the layout in `canvas.json`; see
[`marquee-canvas-state.md`](marquee-canvas-state.md).

## Fallbacks — what an absent feed means

A first boot, a feed that was never created, a malformed value, an offline radio:
all of these are the normal state of affairs at some point, and none of them is
an error worth bricking a take over.

- No value, or one that will not parse → fall back to the firmware's own default
  interval and a plain timer.
- `alarm_type` asks for a pin the board does not define → drop the pin, keep
  whatever else was asked for.
- Nothing left to arm → arm a timer alarm at the default interval anyway. **Never
  deep-sleep with no alarm**; a board with no way back is a board that needs a
  USB cable.

## The editor's side of the push

`pushToDisplay()`, in order:

1. Render in the browser (`render.js` -> `bitmap.js`, the only render path).
2. Publish the base64 BMP to the image feed. **The dashboard goes first:** if only
   one of the two writes lands, a board holding a new image and an old sleep
   window still shows the right thing.
3. Publish this JSON to the sleep feed.
4. Navigate to Act III.

It does not wait for anything, and there is nothing it could wait for — this feed
carries no acknowledgement. Act III's countdown is therefore a client-side estimate
of the window that was published, not a report of the board's state, until the
sibling `{group}.status` feed says otherwise. When `alarm_type` is `pin` there is no
wake time to estimate, so A8 says "sleeping until the button is pressed" and runs no
clock (`wakeSource` in `state.js`).

## Known gaps

- **The firmware does not read this feed yet.** It still sleeps on its own default
  interval and ignores `alarm_type` and `sleep_mode` entirely, so the publisher side
  is complete and the round trip is not. This spec is the only copy of the contract
  for whoever writes the consumer.
- **Nothing configures a sleep-feed key on the board.** Whether the consumer wants
  the key from its own configuration or derived from the group key is its call.
- **Deep-sleep pin alarms are not available on every pin.** On the ESP32-S2/S3
  only RTC-capable GPIOs survive deep sleep. A board whose only button is on a
  non-RTC pin can honour `pin` under `light` but not under `deep`.

  The editor leans on this: `alarm_type: "pin"` is sent as `deep`, so such a board
  has to take the documented fallback and arm a time alarm instead of the pin. Under
  `timer+pin` the same mistake degrades to timer-only and recovers on the next
  interval rather than hanging.
- **Nothing reports the board's real state — yet.** `deviceState` goes to `asleep`
  because we published a sleep window, not because a board said so. The answer is
  the sibling `{group}.status` feed (`docs/marquee-status.md`), which the editor
  already reads and no firmware publishes yet. Until one does, Act III models the
  cycle and says so.

  Note what the round trip is worth once it exists: `sleep_time` coming back on
  `.status` is the same field, in the same units, as the one sent here — so a board
  that ignores this feed and sleeps on its own default stops being invisible and
  becomes a one-line diff.
