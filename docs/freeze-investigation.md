# Renderer Freeze Investigation

## Session context

Extension: `milkdrop@mauriciobc.github.io`  
GNOME Shell 49.4 / Mutter 49.4 / Wayland  
Branch: `feat/expression-engine`

---

## Previously fixed (AGENTS.md)

1. `src/extension/evaluator.js` — `incomingAudio.spectrum` → `pcmLeft`/`pcmRight`
2. `src/extension/wallpaper.js` — race condition in destroy handler (captured `destroyedWallpaper`)
3. `src/extension/audio.js` — GJS `get_int` tuple return for `GstStructure` fields

## Fixed in this session (before this document)

4. `src/renderer/gl-bridge.js` — replaced per-frame `map/filter/slice` with `_copyAudioSamples()`; fixed `audio.spectrum` → `audio.pcmLeft`/`pcmRight` fallback
5. `src/extension/audio.js` — added `reason` param to `_startPipeline()`; all callers updated
6. `src/extension/monitor.js` — `_scheduleRestart` log promoted from `debug` → `warn`

---

## Log timeline (session pid=25553, monotonic seconds)

| Time   | Event |
|--------|-------|
| 4025   | `enable()` → audio starts + renderer spawns → helper ready ×2 |
| 4034–4038 | `helper ready ok=true` fires every ~2s (helper crash loop, 3 restarts) |
| 4094   | `enable()` again → audio restarts + renderer respawns → helper ready ×2 |
| 4104   | `enable()` again (+10s) |
| 4112   | `enable()` again (+8s) |
| 4112–4130 | `helper ready ok=true` every ~2s again (crash loop) |
| 5478   | New install — stable run, no restarts observed |

The restarts at 4094/4104/4112 used the **old code** (no `_startPipeline reason=` log, no
`scheduling renderer restart` log). The current run from 5478 is stable.

---

## Bug 1 — Repeated `enable()` calls (~10s apart)

### Symptoms
- Audio pipeline + renderer both restart together (same synchronous call stack)
- No `scheduling renderer restart` log before the restart
- No `milkdrop audio disabling after N spectrum messages` log before the restart
- Pattern exactly matches `MonitorManager.enable()` idle callback:
  `_audioEngine.enable()` then `_spawnForCurrentMonitors()`

### Root cause (confirmed)
`MonitorManager.enable()` is being called again while already enabled.
This happens because GNOME Shell calls `extension.disable()` + `extension.enable()` in
response to certain events (session mode change, screen lock/unlock, another extension
crashing, or `monitors-changed` during startup).

The `_startPipeline reason=` log was absent because those restarts happened with the
**old code** before the `reason` parameter was added. The current install has not
reproduced this pattern yet.

### What was ruled out
- Not `_scheduleRestart` / `_restartAll` (those don't restart audio)
- Not `_schedulePipelineRestart` (no bus error messages)
- Not the reprobe timer (only fires for stub source)
- Not the watchdog (no watchdog timeout messages)

### Next step
Wait for the current stable run to reproduce. If `reason=enable` appears in logs,
it confirms `MonitorManager.enable()` is being called again → investigate GNOME Shell
extension lifecycle trigger.

---

## Bug 2 — `helper ready` firing every ~2s in a loop

### Symptoms
- After the 3rd renderer spawn, `helper ready monitor=0 ok=true` fires every ~2s
- Always `ok=true` — helper starts successfully, compiles shaders, then crashes
- No `helper-crashed` telemetry, no watchdog message, no `ok=false` in logs
- Loop runs for ~18s (4122–4130), more than `MAX_RESTARTS=3` would allow

### Root cause (identified, not yet fixed)

**Two `_readOutput` loops running simultaneously.**

In `gl-bridge.js`, `_handleHelperExit` sets `this._stdout = null` then calls
`_tryRestart()` → `start()` which creates a new `_stdout` and calls `_readOutput()`.

However, the old `read_line_async` callback captures `stream` (the old
`Gio.DataInputStream`) by closure — not `this._stdout`. The guard at the top of
`_readOutput` checks `if (!this._stdout) return` but this only prevents *new* recursive
calls; the already-in-flight async callback on the old stream fires independently.

Result: two concurrent `_readOutput` loops on different streams. When the new helper
exits, `_handleHelperExit` is called **twice** (once from each loop's
`helper_stdout_closed` path), which:
- Doubles the effective restart count, exhausting `MAX_RESTARTS` faster than expected
- Causes the double `helper ready` log seen in every spawn (both loops receive the
  `program_ready` line and both emit `helper-ready`)

### Secondary issue in `_handleLine`

When `message.type === 'telemetry' && message.stage === 'program_ready'`:
1. Emits `{type: 'helper-ready', ok: true}` explicitly ✓
2. Falls through to `this._emit(message)` — emits the raw telemetry too

This is not the direct cause of the double log (the telemetry type doesn't trigger the
"helper ready" log in the extension), but it is a logic error: the `program_ready` block
should `return` after emitting `helper-ready` to avoid the redundant raw emit.

### Fix plan

In `_readOutput`, capture the current `_stdout` and `_cancellable` at call time and
guard the callback against stale instances:

```js
_readOutput() {
    const stdout = this._stdout;
    const cancellable = this._cancellable;
    if (!stdout) return;

    stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
        // Stale loop — a restart replaced _stdout
        if (this._stdout !== stdout) return;
        ...
    });
}
```

Also add `return` after the `helper-ready` emit in the `program_ready` block of
`_handleLine` to prevent the redundant raw telemetry emit.

---

## Current status

- Current run (pid=25553, from 5478s) is **stable** — no restarts, no crash loop
- Both bugs are from the previous install session
- Bug 2 fix is ready to implement
- Bug 1 needs more log data to confirm trigger; may not reproduce with current fixes

---

## New session (2026-03-15, renderer PID 17686)

### Live state
- Renderer PID 17686: alive, 487 MB RSS, 4 GB VM peak, State: S (sleeping)
- C helper PID 17713: alive, 253 MB RSS, State: S (sleeping)
- IPC socket: ESTAB with **213 KB backed up** (renderer not draining):
  ```
  u_str ESTAB 0 213248 /run/user/1000/gnome-milkdrop-0.sock
  ```
- No SHM socket present → nenhum frame pode ser entregue (SHM/FD é obrigatório)

### Log sequence for the freezing session
```
IPC client connected
renderer IPC ready
helper ready ok=true (1st)   ← compile-default
helper ready ok=true (2nd)   ← compile-shaders for initial preset
(esperado) telemetry `readback` warn indicando falha de entrega via SHM/FD
frame=1  time=2866.038
frame=300 time=2871.154
helper ready ok=true (3rd)   ← compile-shaders for second preset (~5s after start)
frame=600 time=2876.275
[SILENCE — nothing more, ever]
```

### What the 3rd `program_ready` is
NOT a watchdog restart (frame counter continued from 300→600, not reset to 1).
It is a second preset's `compile-shaders` being processed. The preset rotation timer
fires ~5 s into a session in this environment.

### Why frames stop after 600

**Nota:** o caminho legado de transporte **base64** foi removido; o renderer strict-only entrega pixels apenas via **SHM/FD**.

Se frames pararem após N frames, as hipóteses principais agora são:
- Falha de entrega/recebimento de FD no socket SHM (ex.: `receive_fd_async`/fallback sync não drenando)
- Falha de leitura dos bytes do frame (SHM) no `GlBridge` (timeout/retries)
- Helper travado/sem `frame-stat` (watchdog deve reiniciar e emitir telemetria)

O sintoma esperado quando SHM/FD falha é telemetria `readback` warn (helper) e ausência de `frame-pixels` no renderer.

### Secondary issue: wallpaper.js disposed-object error loop

Hundreds of repeated stack traces appear in the logs:
```
Object LiveWallpaper, has been already disposed — impossible to access it
#0  wallpaper.js:90   (this._wallpaper === destroyedWallpaper)
#1  wallpaper.js:100  (this._pollSourceId = 0)
```

Line 83 (`this._wallpaperIdleId = 0`) in the idle callback runs **before** the
`_destroyed` guard at line 84, causing access to the already-finalized GObject.
If the error at line 90 is caught by `try/catch`, `_applyWallpaper()` is called at
line 94, scheduling yet another idle that will fail — creating an **error loop**.

### Fixes required

| # | File | Fix |
|---|------|-----|
| A | `wallpaper.js` | Move `this._wallpaperIdleId = 0` inside the try block OR after `_destroyed` check |
| B | `wallpaper.js` | Do NOT call `_applyWallpaper()` inside the idle callback if `this` is disposed |
| C | `gl-bridge.js` | In `_publishFramePixels`, explicitly null `_lastFramePixels` before assigning the new value to hint GC |
| D | `glarea.js` | Null `this._helperTexture` + `this._helperFrame` before assigning new ones |
| E | `gl-bridge.js` | Log watchdog events to `console.warn` directly (not only via IPC) so they appear in shell journal even when IPC is stalled |
| F | `gl-bridge.js` | Call `_startWatchdog()` again when `_ready` transitions false→true (currently the watchdog is cancelled when `_ready` becomes false and never restarted) |
| G | `ipc-client.js` | Add a "stall-detection" heartbeat: if no lines processed for >15 s, log and force-reconnect |
