# gnome-milkdrop

gnome-milkdrop is a GNOME Shell extension plus a companion renderer process for MilkDrop-style desktop visualizations.

The project targets GNOME Shell 47, 48, and 49 on Wayland. It uses a split-process architecture: the shell extension handles lifecycle and orchestration, while a standalone GTK4 renderer process owns OpenGL work.

## Current State (March 2026)

Implemented and working:

- Shell-side extension lifecycle, monitor ownership, preferences, and settings schema
- Standalone GTK4 renderer process with GL bridge and native helper path
- Unix socket IPC with newline-delimited JSON protocol
- Reliable async write queues for shell/renderer IPC streams
- Audio capture pipeline (monitor-first policy) with hardened restart behavior
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

Current unit/integration test status:

- 702 passed, 0 failed via gjs -m tests/run.js

## Architecture

Two cooperating processes:

1. GNOME Shell extension process
- Owns lifecycle, monitor orchestration, renderer launch/restart, audio capture, preset loading, and per-frame evaluation.

2. Renderer process (GTK4)
- Owns GL area, mesh updates, shader pipeline, frame ingestion, and final rendering.

This separation keeps shell stability high and isolates GL crashes from GNOME Shell.

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
- tests: unit and benchmark suites
- docs: architecture and implementation notes

## Roadmap (Next)

Near-term remaining work includes:

1. Motion vectors expression module and tests
2. Full renderer drawing integration for custom shapes and custom waves
3. End-to-end expression preset parity checks against reference behavior
4. Additional visual compliance and performance tuning passes

## Project Metadata

- UUID: milkdrop@mauriciobc.github.io
- Schema ID: org.gnome.shell.extensions.milkdrop
- Shell target: GNOME 47/48/49