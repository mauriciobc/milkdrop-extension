# Architecture

gnome-milkdrop is structured as two cooperating processes.

## Processes

### GNOME Shell extension process

The shell-side extension owns lifecycle, monitor orchestration, renderer launch, renderer restart policy, IPC server, audio capture, preset loading, and per-frame evaluation.

### Renderer process

The renderer is a standalone GJS GTK4 application. It owns GtkGLArea, OpenGL state, ping-pong framebuffers, shader compilation, mesh updates, and per-vertex evaluation.

## Why The Split Exists

- The gnome-shell process must stay stable.
- OpenGL work needs a real GTK-side GL context.
- Renderer crashes should not take down the shell.
- Version-sensitive shell integration can evolve independently from the rendering core.

## Initial Module Layout

### Extension

- extension.js: lifecycle entry point
- monitor.js: monitor enumeration and renderer ownership
- ipc.js: socket server and frame delivery
- audio.js: GStreamer spectrum pipeline
- evaluator.js: per-frame evaluation backends
- presets.js: preset indexing and loading
- prefs.js: Adwaita preferences UI

### Renderer

- renderer.js: Gtk.Application entry point
- glarea.js: GtkGLArea and render loop shell
- ipc-client.js: async frame ingestion
- shaders.js: shader source handling and fallback logic
- mesh.js: warp mesh generation
- vertex-eval.js: per-vertex evaluation boundary

## Initial IPC Contract

The first transport is a Unix socket using newline-delimited JSON. The protocol is intentionally simple for the first implementation pass.

### Extension to renderer

- frame-state updates carrying time, frame count, basic motion values, and later audio-derived values
- preset-change notifications once preset loading is added

### Renderer to extension

- ready
- fps
- shader_error
- shutdown_ack

## Compatibility Baseline

- GNOME Shell 47, 48, and 49
- Wayland first
- X11 only as a secondary path
- Graphics offload only when the runtime supports it
