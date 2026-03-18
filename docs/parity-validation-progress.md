# Parity Validation Plan and Progress: MilkDrop GNOME Extension vs projectM

## Overview
This document tracks the process and progress of validating visual and engine parity between the MilkDrop GNOME Shell extension renderer and the reference projectM renderer.

---

## 1. ProjectM Renderer Architecture Review
- Mapped key subsystems: expression engine, audio pipeline, OpenGL pipeline, custom shapes/waves.
- Identified main files and classes for each subsystem in projectM.

## 2. Preset Selection for Parity Testing
- Selected a representative set of presets covering:
  - Classic (expression engine baseline)
  - Complex custom waves/shapes
  - Heavy shader logic
  - Edge cases (logic stress tests)
  - Interactive/music-reactive scenarios

## 3. Renderer Setup
- Launched the MilkDrop GNOME renderer using `just renderer`.
- Cloned and built the projectM repository (manual build completion may be required).

## 4. Parity Criteria and Test Harness
- Defined criteria:
  - Visual output (screenshots, video)
  - Engine state (registers, variables, audio metrics)
  - Audio response (beat detection, PCM/spectrum mapping)
- Located and reviewed:
  - Preset loading and frame capture logic in both codebases
  - Existing visual parity checks: `tests/parity/visual/visual.test.js`

## 5. Automation: Preset Loading & Frame Capture
- Confirmed automation is possible via test harness and renderer APIs.
- Outlined batch testing for preset loading and frame capture.

## 6. Audio Input Synchronization
- Both renderers support PCM injection or test audio configuration.
- Identified entry points for feeding identical audio to both renderers.

## 7. Per-frame Engine State Logging
- Added per-frame engine state logging to the GNOME extension (`evaluator.js`).
  - Controlled by `MILKDROP_PARITY_LOG` environment variable.
  - Logs frame number, time, preset, registers, audio, custom shapes/waves, and expression context as JSON.
- Identified insertion points for similar logging in projectM (C++).

## 8. Next Steps
- Analyze visual and engine state differences using collected logs and frame captures.
- Use image diff and JSON/CSV diff tools for automated comparison.
- Document findings and actionable gaps for future fixes.

---

## Files and References
- MilkDrop GNOME: `src/extension/evaluator.js`, `src/extension/audio.js`, `src/renderer/glarea.js`, `tests/parity/visual/visual.test.js`
- projectM: `ProjectM.cpp`, `PerFrameContext.cpp`, `audio.h`, `audioCapture.cpp`
- Presets: `presets/se7enslasher-2025/`

---

_Last updated: 2026-03-16_
