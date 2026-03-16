# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Build
```bash
meson setup build        # Configure (first time)
meson compile -C build   # Build C native helper
```

### Test
```bash
gjs -m tests/run.js                        # All unit tests
gjs -m tests/bench/run.js                  # All benchmarks (run from repo root)
gjs -m tests/bench/run.js -- --json        # Benchmark JSON output (for regression checks)
gjs -m tests/run-parity.js                 # Parity tests vs projectM (expression engine, parser, golden frame, visual)
just golden-frames                         # Generate per-frame golden JSONs (from projectM test presets)
```

**Benchmarks and parity:** Always run `tests/bench/run.js` and `tests/run-parity.js` from the **repository root**; parser-parity and preset-loading use paths relative to cwd (e.g. `tests/bench/data/PresetFileParser/`).

There is no way to run a single test file in isolation — the runner in `tests/run.js` imports all test modules. To focus on a subsystem, check the relevant `tests/extension/` or `tests/renderer/` file and run the full suite.

### Development (via `just`)
```bash
just install      # Build + install extension to ~/.local/share/gnome-shell/extensions/
just reinstall    # Clean install + reload
just nested       # Launch nested GNOME Shell for live testing
just renderer     # Launch standalone renderer (without shell)
just logs         # Follow GNOME Shell journal
just bench        # All benchmarks
just profile      # Launch under Sysprof
```

### Debug environment variables
```bash
MILKDROP_DEBUG_IPC=1   # Log IPC messages
MILKDROP_DEBUG_BEAT=1  # Log beat detection decisions
MILKDROP_PERF_MARKS=1  # Enable Sysprof performance marks without attaching Sysprof
```

## Architecture

The extension uses a **split-process architecture** — two cooperating JavaScript processes:

### Process 1: Shell Extension (`src/extension/`)
Runs inside the gnome-shell process (GJS). Owns:
- Monitor enumeration and renderer lifecycle (`monitor.js`)
- GStreamer audio pipeline, spectrum analysis, beat detection (`audio.js`)
- MilkDrop expression engine (`expr/`) — lexer → parser → AST → closure compiler (no `eval`)
- Per-frame equation evaluation (`evaluator.js`)
- Preset loading and indexing (`presets.js`)
- Unix socket IPC server (`ipc.js`) — sends `frame-state` JSON to renderer every ~50ms
- Wallpaper clone management and GNOME Shell overrides (`wallpaper.js`, `gnomeShellOverride.js`)

### Process 2: GTK4 Renderer (`src/renderer/`)
A standalone GTK4 application (GJS). Owns:
- GtkGLArea render loop (`glarea.js`, `renderer.js`)
- OpenGL shader pipeline, ping-pong framebuffers, warp mesh (`gl-bridge.js`, `mesh.js`)
- Native C helper for PBO readback, SHM double-buffering, custom draw/warp/composite passes (`gl-helper.c`)
- IPC client that ingests `frame-state` from the extension (`ipc-client.js`)

### IPC Protocol
Transport: Unix sockets with newline-delimited JSON.
- Extension → Renderer: `frame-state` (time, frame count, audio metrics, motion vectors), `preset-change`
- Renderer → Extension: `ready`, `fps`, `shader_error`, `shutdown_ack`
- The extension maintains an async write queue (max 5 frames) to avoid blocking the shell process.

### Expression Engine (`src/extension/expr/`)
Pure JS, no `eval()` or `Function()` constructor:
```
Source → Lexer → Parser (AST) → Compiler (closure tree) → Context (state) → Evaluators
```
- `per-frame.js`: evaluates `init_eqs` / `frame_eqs` each animation frame
- `per-pixel.js`: evaluates `pixel_eqs` (compiled to GLSL for per-vertex use)
- `custom-shapes.js`, `custom-waves.js`: geometry evaluators for overlaid shapes/waveforms
- `functions.js`: 80+ built-in functions (`sin`, `cos`, `pow`, `log`, `abs`, etc.)
- `context.js`: frame/pixel state registers and 1MB `megabuf`/`gmegabuf` arrays

### Audio Pipeline
```
PulseAudio Monitor Source → GStreamer Spectrum (24 bands) → AppSink (576 PCM samples)
→ audio.js (normalization, energy/bass/mid/high extraction, adaptive beat detection)
→ IPC frame-state payload
```

### Renderer Pipeline (OpenGL)
1. Mesh generation — 256×192 warp grid
2. Draw pass — ping-pong framebuffers, motion vectors, composite
3. Warp pass — warp/zoom transformations
4. Post-processing — border, echo, solarize, gamma
5. PBO async readback → SHM double-buffer (via `gl-helper.c`)

## Tech Stack Notes
- **Runtime:** GJS (GNOME JavaScript bindings) — not Node.js. No npm, no webpack, no transpilation.
- **Build:** Meson + Ninja. The C helper (`gl-helper.c`) requires EGL, Epoxy, GLib, JSON-GLib at build time.
- **Tests:** Custom minimal runner (`tests/run.js`). Each test module exports `run(assert)`. No Jest/Mocha.
- **Target:** GNOME Shell 47, 48, 49. Wayland-first.
- **GSettings schema:** `org.gnome.shell.extensions.milkdrop` (19 keys for monitors, audio, presets, rendering).

## Parity vs projectM
- **Parser:** `.milk` preset parser lives in `src/extension/milk-parser.js`; validated by `tests/bench/parser-benchmark.js` (PresetFileParser-style cases) and `tests/parity/expr/preset-parser.test.js`.
- **Golden per-frame:** Goldens in `tests/parity/golden/frame/*.golden.json` store reference inputs/outputs per frame (projectM test presets only). Generate with `just golden-frames` (requires `projectm/presets/tests/` or `tests/parity/golden/frame/presets/`). The parity test compares evaluator output to goldens; see `tests/parity/golden/README.md`.
- **Optional projectM repo:** For full preset comparison, clone [projectM](https://github.com/projectM-visualizer/projectm) (e.g. as `projectm/` in repo root). Then:
  - `projectm/presets/tests/` — parity preset-parser can load these .milk files if present (SKIP when missing).
  - Visual parity (`tests/parity/visual/visual.test.js`) can use projectM SDL test UI if built: `cd projectm/build && cmake .. -DENABLE_SDL_UI=ON && make`.
- Validation is **behavioral parity** (same test cases as projectM); no C++ comparison required for CI.

## Key Constraints
- Expression engine must never use `eval()` or `new Function()` — GNOME Shell CSP prohibits it.
- The shell extension runs in the gnome-shell PID; crashes affect the entire desktop. Keep extension-side code robust.
- IPC write queue has a hard cap of 5 pending frames — don't add blocking operations to the IPC path.
- Renderer can be launched standalone (`just renderer`) for GL development without a full shell session.
