# gnome-milkdrop

gnome-milkdrop is a GNOME Shell extension plus a companion renderer process for MilkDrop-style desktop visualizations.

The project targets GNOME Shell 47, 48, and 49 on Wayland. It uses a split-process architecture: the shell extension handles lifecycle and orchestration, a standalone GTK4 renderer process owns OpenGL scheduling, and a native helper executes the GL workload.

## Current State (March 2026)

Implemented and working:

- Shell-side extension lifecycle, monitor ownership, preferences, and settings schema
- Standalone GTK4 renderer process with GL bridge and native helper path
- Unix socket IPC with newline-delimited JSON; **versioned handshake** (`protocolVersion` on `ready` and control messages) and bounded async write queues with drop accounting
- **Per-frame audio snapshots** without JSON deep-clone on the hot path (`frame-state.js`), feeding evaluation and IPC
- Audio capture pipeline (monitor-first policy) with hardened restart/reprobe behavior; **runtime diagnostics** exposed on D-Bus (see below)
- **D-Bus status** on the session bus: `io.github.mauriciobc.Milkdrop` — `GetWindowStatus()` returns window/overlay flags plus audio pipeline fields (enabled, configured vs active source, signal presence, restart/reprobe counters)
- Presets: **file-based** catalog and rotation; a small **bootstrap** fallback preset when nothing else is available (no bundled built-in preset library)
- Dual evaluator path:
	- Legacy WaveSpec preset evaluation
	- Expression preset evaluation
- MilkDrop expression engine core in pure JS:
	- lexer, parser, compiler, built-in functions
	- frame context (q-vars, t-vars, reg vars)
	- per-frame evaluator
	- per-pixel evaluator
	- custom shapes evaluator
	- custom waves evaluator
- Renderer-side per-vertex dual mode (legacy spec and expression pixel equations)
- Native helper performance improvements:
	- PBO asynchronous readback
	- persistent SHM double buffering

Tests:

- Run from the repo root: `gjs -m tests/run.js` (unit/integration assertions)
- Parity and golden checks: `gjs -m tests/run-parity.js`
- Benchmarks: `gjs -m tests/bench/run.js` (see [CLAUDE.md](CLAUDE.md) for JSON mode)

## Architecture

Three cooperating pieces:

1. **GNOME Shell extension** — lifecycle, monitor orchestration, renderer launch/restart, audio capture, preset loading/indexing, per-frame evaluation, socket IPC server, D-Bus status.
2. **Renderer process (GTK4)** — GtkGLArea loop, IPC client, bridge to the native helper with backpressure handling.
3. **Native GL helper** — shader setup, draw/warp/composite passes, optional SHM transfer.

This separation keeps shell stability high and isolates GL crashes from GNOME Shell. More detail: [docs/architecture.md](docs/architecture.md).

## Build And Run

Prerequisites vary by distro, but you generally need:

- Meson and Ninja
- gjs
- GTK4 development files
- epoxy and EGL/GL dependencies for the native helper

Typical local workflow:

1. Configure
- meson setup build

2. Build
- meson compile -C build

3. Run tests
- gjs -m tests/run.js

4. Optional benchmarks
- gjs -m tests/bench/run.js

Helper scripts:

- tools/install.sh
- tools/uninstall.sh
- tools/reload.sh
- tools/watch.sh

## Repository Layout

- src/extension: shell extension logic (audio, evaluator, IPC, presets, prefs)
- src/extension/expr: expression engine modules
- src/renderer: GTK4 renderer, GL bridge/client, mesh and vertex evaluation
- src/shared: code shared between extension and renderer (e.g. IPC protocol version)
- tests: unit and benchmark suites
- docs: architecture and notes ([architecture](docs/architecture.md), [comparison with related GNOME extensions](docs/extension-benchmark.md), [Hanabi alignment](docs/hanabi-learnings.md), [third-party reference snapshots](docs/reference-codebases/README.md), [v2 architecture spikes](docs/v2-architecture-spikes.md))

## Roadmap (Next)

Near-term technical work includes:

1. Motion vectors expression module and tests
2. Full renderer drawing integration for custom shapes and custom waves
3. End-to-end expression preset parity checks against reference behavior
4. Additional visual compliance and performance tuning passes

Exploratory (see [docs/v2-architecture-spikes.md](docs/v2-architecture-spikes.md)):

- Spike A: optional complementary D-Bus control surface for non-hot-path commands and richer telemetry
- Spike B: optional external analysis mode (e.g. `cava`) behind a flag for difficult environments

## Project Metadata

- UUID: milkdrop@mauriciobc.github.io
- Schema ID: org.gnome.shell.extensions.milkdrop
- Shell target: GNOME 47/48/49
