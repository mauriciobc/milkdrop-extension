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

dbus-run-session gnome-shell --devkit --wayland

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
| audio-sensitivity | d | src/extension/audio.js |
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

### Beat detection diagnostics

To tune beat detection against real audio, run with **`MILKDROP_DEBUG_BEAT=1`** in the same environment (e.g. `MILKDROP_DEBUG_BEAT=1 dbus-run-session gnome-shell --wayland`). Then run `just logs` (or `journalctl -f ... | grep milkdrop`).

- **When beat=1:** Every trigger is logged with energy (E), bass (B), rolling averages (avgE, avgB), variance (varE, varB), adaptive thresholds (threshE, threshB), the required level to trigger (needE, needB), and which band fired (E_beat, B_beat).
- **When beat=0:** Every 20th spectrum message is logged with the same numbers so you can see how close you were (e.g. `E=0.42 needE=0.48` means energy was below the line).

Use this to decide whether to lower/raise constants in `src/extension/audio.js` (e.g. `BEAT_THRESHOLD_LOW`, `BEAT_THRESHOLD_HIGH`, `BEAT_THRESHOLD_VARIANCE_SLOPE`, `BEAT_NOISE_FLOOR`) or to change the logic (e.g. use only bass, or a different formula).

**Sampling interval:** The GStreamer spectrum element uses `interval=${SPECTRUM_INTERVAL_NS}` (nanoseconds; default 50 ms). Beat detection uses **time-based** parameters derived from this interval: `BEAT_HISTORY_MS` (e.g. 1000 ms) and `BEAT_COOLDOWN_MS` (e.g. 100 ms) are converted to frame counts. If you change `SPECTRUM_INTERVAL_NS` (e.g. to 25 ms for more updates or 100 ms for less CPU), history length and cooldown in **wall-clock seconds** stay the same.

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
- `readback_us`: time for `glReadPixels` + SHM/base64 transfer

The renderer's `PerfCollector` (in `src/renderer/gl-bridge.js`) aggregates these into rolling percentile statistics accessible via `GlBridge.getPerfStats()`.

### Environment variables

| Variable | Effect |
| --- | --- |
| `MILKDROP_DEBUG_IPC=1` | Log frame writes and audio data every ~1s |
| `MILKDROP_DEBUG_BEAT=1` | Log beat detection decisions |
| `MILKDROP_PERF_MARKS=1` | Enable shell-side perf marks without Sysprof |
| `SYSPROF_TRACE_FD` | Set automatically by Sysprof; enables mark emission |

## Research Notes

- PipeWire monitor-capture decision and references: docs/pipewire-audio-source-research.md
