# Debug Log — Renderer Hang Investigation

## Session 1 — 2026-03-16

### Baseline (before any changes)
- Tests: **900 passed, 0 failed**

---

### Fix 1: `src/renderer/ipc-client.js` — stale `_readLoop` on reconnect

**Bug:** `_readLoop()` did not capture `_input` identity. After a reconnect replaced
`this._input` with a new stream, the old pending `read_line_async` callback could still
fire, see the new non-null `this._input`, and call `this._readLoop()` again — registering
a duplicate loop on the new connection's input stream.

**Test added:** `tests/renderer/ipc-client.test.js`
- `ipc-client stale _readLoop callback does not register duplicate read after _input is replaced`
- **Failed before fix, passes after.**

**Fix:** Capture `capturedInput = this._input` at loop start; guard callback with
`if (this._input !== capturedInput) return;`.

- Tests after fix: **903 passed, 0 failed**

---

### Fix 2: `src/renderer/glarea.js` — `_getHelperTexture` does not null old texture before rebuild

**Bug:** When the helper serial changes and a new `Gdk.MemoryTexture` must be built,
`_getHelperTexture()` assigned the new texture directly without first nulling
`this._helperTexture`. SpiderMonkey cannot see the 230+ KB C-heap cost of
`GLib.Bytes`-backed textures, so the old allocation was not GC'd promptly.

**Test added:** `tests/renderer/glarea.test.js`
- `_getHelperTexture nulls stale _helperTexture before allocating new GdkMemoryTexture`
- **Failed before fix, passes after.**

**Fix:** Added `this._helperTexture = null;` immediately before
`this._helperTexture = Gdk.MemoryTexture.new(...)`.

- Tests after fix: **904 passed, 0 failed**

---

### Fix 3: `src/renderer/ipc-client.js` — no heartbeat timeout

**Bug:** `IpcClient` had no self-healing timeout. If the IPC connection stalled (no lines
received), the renderer's read loop silently stopped consuming data. The connection stayed
"alive" with no error, and the renderer froze without any recovery attempt.

**Test added:** `tests/renderer/ipc-client.test.js`
- `ipc-client _readLoop resets heartbeat timer on each received line`
- **Failed before fix, passes after.**

**Fix:** Added `_resetHeartbeat()` / `_clearHeartbeat()` methods. `_resetHeartbeat()` arms
a 15-second `GLib.timeout_add` that calls `_handleDisconnect()` if no lines arrive.
`_resetHeartbeat()` is called after every received line in `_readLoop()`.
`_clearHeartbeat()` is called in `stop()` and `_handleDisconnect()`.

- Tests after fix: **905 passed, 0 failed**

---

### Live run (pending)

Run `just reinstall && just logs` and record:
- Frame count reached before hang/silence (target: >600)
- Absence of repeated `helper ready` loop
- Absence of `disposed object` error spray
- Steady fps telemetry in journal
