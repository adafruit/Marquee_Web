# Marquee format specs

Four contracts between the editor, Adafruit IO and the board. Each is
self-contained; start with whichever side you are writing.

| Spec | Describes |
|---|---|
| [`marquee-canvas-state.md`](marquee-canvas-state.md) | The `{group}.canvas-state` feed — the editable scene, `canvas.json` verbatim, parked on Adafruit IO so a design outlives the browser that drew it. |
| [`marquee-sleep.md`](marquee-sleep.md) | The `{group}.sleep` feed — how the editor tells a CircuitPython board how long to sleep and what to wake on. |
| [`marquee-status.md`](marquee-status.md) | The `{group}.status` feed — how a board reports what it is actually doing. |
| [`cfg-marquee.md`](cfg-marquee.md) | The `cfg-marquee.json` display descriptor — what it takes to bring the panel up, and nothing else. |

`cfg-marquee.md` currently has **no producer in this repo**; it is kept as the
format spec. See the status note at the top of that file, and *Known gaps* in the
[root README](../README.md).

For how the pieces fit together — the WipperSnapper/ProtoMQ path versus the
CircuitPython path — see the [root README](../README.md).
