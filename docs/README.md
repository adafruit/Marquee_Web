# Marquee format specs

Four contracts between the editor, Adafruit IO and the board. Each is
self-contained; start with whichever side you are writing.

| Spec | Describes |
|---|---|
| [`marquee-canvas-state.md`](marquee-canvas-state.md) | The `{group}.canvas-state` feed — the editable scene, `canvas.json` verbatim, parked on Adafruit IO so a design outlives the browser that drew it. |
| [`marquee-sleep.md`](marquee-sleep.md) | The `{group}.sleep` feed — how the editor tells the board how long to sleep and what to wake on. |
| [`marquee-status.md`](marquee-status.md) | The `{group}.status` feed — how a board reports what it is actually doing. |
| [`cfg-marquee.md`](cfg-marquee.md) | The `cfg-marquee.json` file on the board — account, group key, network, panel and pins, written at flash time. |

The first three are plain Adafruit IO feeds under one group key: the editor publishes
the scene and the sleep window, the board publishes its status, and nothing in
between holds state. The fourth is the file that tells the board which group that is. For how the pieces fit together, see the
[root README](../README.md).
