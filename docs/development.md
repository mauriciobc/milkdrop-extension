# Development

This repository is currently set up for local, manual installation first. The goal is to validate architecture and runtime behavior before tightening packaging for distribution.

## Logging

By default the journal only shows **warn** and above from GNOME Shell; **info** is hidden unless `G_MESSAGES_DEBUG=GNOME Shell` is set. Diagnostic messages that must appear without env vars use `.warn` (e.g. "bus poll started", "no spectrum after 2s").

## Baseline Commands

- just install
- just reinstall
- just disable
- just enable
- just reload
- just renderer
- just nested
- just logs

## Nested Shell Testing

Use a nested shell for extension lifecycle work whenever possible.

### GNOME 49+

Run:

just nested

This launcher uses an isolated config/keyfile-based GSettings backend for the
nested session. Settings changes then propagate correctly between
`gnome-shell` and extension prefs while keeping your main-session dconf
state untouched, and extension discovery still uses your normal installed
user extension directory.

Inside the nested session, enable the extension through gnome-extensions.

### Settings Validation Checkpoints (Manual)

When validating shell-bound settings behavior, run these pass/fail checks in a nested shell:

1. Toggle `text-overlay-enabled` and verify status text overlay appears/disappears over the visualization immediately.
2. Toggle `pause-when-fullscreen` and verify renderer pauses/resumes immediately when the focused app enters/leaves fullscreen.
3. Change `preset-rotation-mode` between `random` and `sequential`, then verify rotation order changes on the next tick.
4. Change `beat-cut-cooldown-sec` and verify beat-triggered preset cuts respect the new cooldown without extension restart.
5. Change `audio-restart-max-attempts` and `audio-reprobe-delay-ms`, then verify behavior after an audio restart/reprobe cycle.
6. Run disable/enable twice and verify there are no leaked settings signals or timeout sources.

## Schema Workflow

After changing the schema XML, recompile schemas in the installed extension directory. The install and reinstall flows handle this.

`just reload` is not enough after schema XML edits because it does not run `glib-compile-schemas`. Use `just install` or `just reinstall` first, then reload if needed.

### Settings Key Contract

| Key | Type | Owner |
| --- | --- | --- |
| enabled-monitors | as | src/extension/monitor.js |
| text-overlay-enabled | b | src/extension/monitor.js |
| hide-when-maximized | b | src/extension/monitor.js |
| show-on-empty-desktop-only | b | src/extension/monitor.js |
| pause-when-fullscreen | b | src/extension/monitor.js |
| fps-limit | i | src/extension/monitor.js |
| audio-source | s | src/extension/audio.js |
| audio-restart-max-attempts | i | src/extension/audio.js |
| audio-reprobe-delay-ms | i | src/extension/audio.js |
| preset-rotation-interval | i | src/extension/monitor.js |
| preset-rotation-mode | s | src/extension/monitor.js |
| blend-time | d | src/extension/monitor.js |
| beat-cuts-enabled | b | src/extension/monitor.js |
| beat-cut-cooldown-sec | d | src/extension/monitor.js |
| preset-directory | s | src/extension/presets.js |

## Current Implementation Focus

1. Establish a valid extension scaffold
2. Add the standalone renderer entry point
3. Validate shell-side subprocess ownership and z-order behavior
4. Only then add IPC, OpenGL state, and audio

## Local-First Notes

- Companion-process architecture is currently intentional.
- Any helper binary remains a later packaging decision.
- Review-hardening for extensions.gnome.org is not the first milestone.

## Validating audio monitor data (renderer)

If the on-screen audio values (energy, bass, mid, high) stay fixed, use the diagnostic logs to see where the pipeline stops updating.

**IPC/frame-pump diagnostics are off by default** to avoid main-loop load. Enable with `MILKDROP_DEBUG_IPC=1` in the environment where the extension and renderer run (e.g. `MILKDROP_DEBUG_IPC=1 dbus-run-session gnome-shell --wayland` for a nested session, or set in the shell before launching the session).

1. **Extension:** Run `just logs` (or `journalctl -f -o cat /usr/bin/gnome-shell` in a nested session). With `MILKDROP_DEBUG_IPC=1`, about once per second you should see:
   - `milkdrop audio debug: source=... active=... energy=... bass=... mid=... high=...`
   - If these values **never change** while audio is playing → problem is in the extension (pipeline stub or spectrum parsing). If you see `spectrum message ignored: bands.length=0`, the GStreamer spectrum structure is not being parsed.
   - If these values **do change** → extension is sending live data; next check is the renderer.

2. **Renderer:** With the extension running, the renderer process logs once per second to stderr: `milkdrop renderer audio debug: ...`. Compare with the extension log; if extension values change but renderer values stay fixed, the issue is IPC or how the renderer receives frames.

3. **Configuration:** Prefs → Audio source. Use `auto` for default monitor; if no monitor is found, the pipeline falls back to a silent stub and values stay at zero (see docs/pipewire-audio-source-research.md).

## Benchmarking & Profiling

### Micro-benchmarks

Run shell-side micro-benchmarks (evaluator, audio, IPC serialization, presets):

    just bench

JSON output for CI or regression tracking:

    just bench-json

Or directly:

    gjs -m tests/bench/run.js
    gjs -m tests/bench/run.js -- --json
    gjs -m tests/bench/run.js -- --iterations 50000 --warmup 500

### Renderer benchmark

Run the GL renderer in benchmark mode (renders N frames with synthetic data, prints timing stats):

    gjs -m src/renderer/renderer.js --benchmark --standalone --width 1280 --height 720
    gjs -m src/renderer/renderer.js --benchmark --benchmark-frames 600 --standalone --width 1920 --height 1080

Requires GL helper to be built (`ninja` in build/). Output includes per-frame render and readback times with min/median/p95/p99/max in microseconds.

### End-to-end benchmark

Launches the renderer in benchmark mode as a subprocess and collects results:

    gjs -m tests/bench/e2e.js --frames 300 --width 1280 --height 720

### Regression detection

1. Establish a baseline: `gjs -m tests/bench/run.js -- --json > tests/bench/baseline.json`
2. After changes, run and compare: `gjs -m tests/bench/run.js -- --json > /tmp/current.json && gjs -m tests/bench/check-regression.js /tmp/current.json`
3. Flag regressions above 10% median increase (configurable with `--threshold`).

### Meson benchmark target

From the build directory:

    meson test --benchmark

### Sysprof profiling

The extension and GL helper emit performance marks when Sysprof is active.

**Shell-side marks:** Enabled when `SYSPROF_TRACE_FD` is set (automatic under Sysprof) or `MILKDROP_PERF_MARKS=1`. Marks: `frame-pump`, `evaluator`.

**GL helper marks:** Enabled when built with `sysprof-capture-4` (automatic if available). Marks: `draw_pass`, `warp_pass`, `composite_pass`.

**Quick profile with Sysprof CLI:**

    just profile

This launches a nested GNOME Shell under `sysprof-cli` and writes a `.syscap` file. Open in Sysprof UI to see:
- CPU usage per process (gnome-shell, gjs renderer, milkdrop-gl-helper)
- Frame timing marks in the timeline
- Per-pass GPU cost breakdown (draw/warp/composite)

**Manual Sysprof session:**

    sysprof-cli --session -- dbus-run-session gnome-shell --devkit --wayland

Then enable the extension and interact normally. Stop with Ctrl+C. The `.syscap` file is written to the current directory.

### Frame-stat telemetry

The GL helper emits per-frame timing on stdout as JSON:

    {"type":"frame-stat","frame_count":1234,"time":20.500000,"render_us":450,"readback_us":1200}

- `render_us`: time for draw+warp+composite passes (after `glFinish`)
- `readback_us`: tempo de `glReadPixels` + entrega via SHM/FD

The renderer's `PerfCollector` (in `src/renderer/gl-bridge.js`) aggregates these into rolling percentile statistics accessible via `GlBridge.getPerfStats()`.

### Debugging system hang

If the system hangs after the extension has been running for a while, the cause is usually the **main loop of gnome-shell** being blocked (the extension runs inside it). Less often it is a GPU/driver or kernel issue.

**1. Reproduce in a nested session (recommended)**

So that a hang doesn’t freeze your real session:

```bash
dbus-run-session gnome-shell --devkit --wayland
```

Enable the extension inside the nested session and use it until the hang occurs. When the nested shell hangs, your main session stays usable and you can inspect processes and logs.

**2. See where it stops**

- **Logs:** Before reproducing, enable debug logs and follow them in another terminal:

  ```bash
  G_MESSAGES_DEBUG=all journalctl -f -o cat /usr/bin/gnome-shell
  ```

  When the hang happens, the last repeated line often points at the component that’s stuck (e.g. frame-pump, IPC, audio).

- **Slow-frame warning:** Run with `MILKDROP_DEBUG_HANG=1`. The extension will log a warning whenever a single frame pump or the evaluator takes longer than 50 ms. If you see these warnings increasing in frequency before a hang, the main loop is being blocked by the frame path (evaluator or IPC/serialization).

**3. Profile with Sysprof**

Capture a session that includes the hang (or the slowdown that precedes it):

```bash
just profile
# or:
sysprof-cli --session -- dbus-run-session gnome-shell --devkit --wayland
```

Enable the extension, use it until it hangs or slows down, then stop with Ctrl+C. Open the generated `.syscap` in Sysprof and check:

- **gnome-shell:** Where CPU time is spent (e.g. `frame-pump`, `evaluator`, JSON, GStreamer). Long blocks on one callback = main loop blocked.
- **Renderer / gl-helper:** If the renderer or C helper is stuck, the shell may still be responsive; the gl-bridge watchdog will restart the helper after ~25 s. If the whole system freezes, focus on the shell or the driver.

**4. Likely causes and what to check**

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Last log line is frame-pump / evaluator | Evaluator or preset too heavy; main loop blocked every frame | Preset complexity, `evaluateFrame()` duration in Sysprof, try disabling preset rotation or switching to a simpler preset |
| Last log is IPC or socket write | Renderer not reading; socket buffer full; write path blocking | Renderer process state (`pgrep -a gjs`), IPC queue (extension drops frames when queue is full; see `MILKDROP_DEBUG_IPC=1`) |
| Last log is audio / GStreamer | Audio pipeline or D-Bus blocking | `MILKDROP_DEBUG_IPC=1`, audio source, PulseAudio/PipeWire |
| Visualization freezes but shell still responds | Renderer or GL helper stuck | Renderer watchdog (restart after 25 s), `gl-helper` stdout, GPU driver |

**5. Isolate components**

- **Without audio:** Disable or close audio source; if the hang stops, the problem is likely in the audio pipeline or in code that runs only when audio is active.
- **Without preset rotation:** Set preset rotation interval to 0; if the hang stops, suspect preset loading/indexing or evaluator preset switch.
- **Renderer only:** Run `just renderer` (standalone renderer, no extension). If the system never hangs, the cause is probably in the extension (shell) side.

### Environment variables

| Variable | Effect |
| --- | --- |
| `MILKDROP_DEBUG_IPC=1` | Log frame writes and audio data every ~1s |
| `MILKDROP_DEBUG_HANG=1` | Warn when a frame pump or evaluator run exceeds 50 ms (main-loop blocking) |
| `MILKDROP_PERF_MARKS=1` | Enable shell-side perf marks without Sysprof |
| `SYSPROF_TRACE_FD` | Set automatically by Sysprof; enables mark emission |

## Research Notes

- PipeWire monitor-capture decision and references: docs/pipewire-audio-source-research.md
