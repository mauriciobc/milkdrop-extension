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

## Schema Workflow

After changing the schema XML, recompile schemas in the installed extension directory. The install and reinstall flows handle this.

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

## Research Notes

- PipeWire monitor-capture decision and references: docs/pipewire-audio-source-research.md
