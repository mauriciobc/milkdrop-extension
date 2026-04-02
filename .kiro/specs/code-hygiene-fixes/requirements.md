# Requirements Document

## Introduction

This document captures the requirements for a set of targeted code-hygiene fixes across the GNOME Milkdrop extension codebase. The issues span logging discipline, duplicated constants and utility methods, a shadowed variable, inconsistent return types, a partial context mutation, a private-field access violation, a module-level mutable guard, a silent preset fallback, a performance problem with PCM data transport, a broken `import.meta.main` fallback, and missing IPC input validation. None of these are catastrophic individually, but together they represent technical debt that will cause real bugs and maintenance pain as the codebase grows.

## Glossary

- **AudioEngine**: The class in `src/extension/audio.js` responsible for capturing audio via GStreamer and exposing spectrum/PCM features.
- **Evaluator**: The class in `src/extension/evaluator.js` that converts a preset and audio frame into render-control parameters.
- **GlBridge**: The class in `src/renderer/gl-bridge.js` that manages the native GL helper subprocess and IPC.
- **IpcServer**: The class in `src/extension/ipc.js` that serves frame data to the renderer process over a Unix socket.
- **IpcClient**: The class in `src/renderer/ipc-client.js` that connects to the IpcServer and receives frame data.
- **MonitorManager**: The class in `src/extension/monitor.js` that orchestrates renderer processes per monitor.
- **ManagedRendererWindow**: The inner class in `src/extension/monitor.js` that manages window placement for a renderer.
- **PerPixelEvaluator**: The class in `src/extension/expr/per-pixel.js` that evaluates MilkDrop per-pixel expressions at each mesh vertex.
- **PresetStore**: The class in `src/extension/presets.js` that loads and sanitises preset JSON files.
- **RENDER_CONTROL_DEFAULTS**: The ~35-key object of default render-control values in `src/extension/evaluator.js`.
- **FRAME_RENDER_CONTROL_DEFAULTS**: The verbatim duplicate of the above in `src/renderer/gl-bridge.js`.
- **frameCtx**: The per-frame expression context object passed through the expression evaluator pipeline.
- **PCM data**: Raw pulse-code modulation audio samples (up to 576 left + 576 right floats per frame).
- **SHM transport**: The shared-memory file-descriptor mechanism used to transfer rendered pixel data from the GL helper to the extension without copying through JSON.
- **_hasSettingKey pattern**: The set of private methods (`_hasSettingKey`, `_getStringSetting`, `_getIntSetting`, `_getBooleanSetting`, `_getDoubleSetting`) duplicated across AudioEngine, PresetStore, and MonitorManager.
- **BOOTSTRAP_PRESET**: The built-in fallback preset defined in `src/extension/presets.js`.
- **logger**: The logging object injected into each class, expected to expose `.debug()`, `.info()`, `.warn()`, and `.error()` methods.
- **GJS**: GNOME JavaScript runtime used to execute the extension and renderer.
- **import.meta.main**: A GJS-specific boolean that was `true` when a module was the entry point; removed in GJS 1.86 / GNOME 49.

---

## Requirements

### Requirement 1 — Logging Discipline

**User Story:** As a developer, I want log messages to use the correct severity level, so that I can filter logs by severity in production and distinguish routine operational events from genuine warnings.

#### Acceptance Criteria

1. WHEN the AudioEngine starts a pipeline, attaches a bus listener, or receives its first spectrum message, THE AudioEngine SHALL emit those messages at `info` level, not `warn` level.
2. WHEN the MonitorManager spawns a renderer process or enumerates monitors, THE MonitorManager SHALL emit those messages at `info` level, not `warn` level.
3. WHEN any component emits a message that indicates a recoverable degraded state (e.g. falling back to polling, base64 transport fallback, SHM unavailable), THE component SHALL emit that message at `warn` level.
4. WHEN any component emits a message that indicates an unrecoverable failure or unexpected error condition, THE component SHALL emit that message at `warn` or `error` level.
5. THE logging system SHALL reserve `warn` for conditions that represent a deviation from the expected happy path, and SHALL use `info` for routine lifecycle events.

---

### Requirement 2 — Deduplicate Render-Control Defaults

**User Story:** As a developer, I want a single authoritative source for render-control default values, so that adding or changing a render-control variable requires only one edit.

#### Acceptance Criteria

1. THE codebase SHALL contain exactly one definition of the render-control defaults object (the ~35-key set of values such as `cx`, `cy`, `zoom`, `wave_mode`, etc.).
2. WHEN `src/renderer/gl-bridge.js` needs render-control defaults, THE GlBridge SHALL import and use the shared definition rather than maintaining its own copy.
3. WHEN `src/extension/evaluator.js` needs render-control defaults, THE Evaluator SHALL import and use the shared definition rather than maintaining its own copy.
4. IF the shared defaults object is modified, THEN both the Evaluator and GlBridge SHALL automatically reflect the change without any additional edits.

---

### Requirement 3 — Extract Settings Utility

**User Story:** As a developer, I want a shared settings-access utility, so that the `_hasSettingKey` / `_getStringSetting` / `_getIntSetting` / `_getBooleanSetting` / `_getDoubleSetting` pattern is not copy-pasted across multiple classes.

#### Acceptance Criteria

1. THE codebase SHALL contain a single `SettingsAccessor` utility (class or module of functions) that implements `hasKey`, `getString`, `getInt`, `getBoolean`, and `getDouble` with safe fallback behaviour.
2. WHEN AudioEngine, PresetStore, or MonitorManager needs to read a GSettings key, THE class SHALL delegate to the shared `SettingsAccessor` rather than calling its own private copy of those methods.
3. IF the GSettings schema does not contain a requested key, THEN the `SettingsAccessor` SHALL return the caller-supplied fallback value without throwing.
4. THE `SettingsAccessor` SHALL accept a nullable `settings` object and SHALL return the fallback value for all reads when `settings` is null.

---

### Requirement 4 — Fix Shadowed Variable in Evaluator

**User Story:** As a developer, I want the audio object construction in `Evaluator.evaluateFrame()` to be unambiguous, so that the intent is clear and the code is not fragile.

#### Acceptance Criteria

1. WHEN `Evaluator.evaluateFrame()` constructs the normalised `audio` object, THE Evaluator SHALL set `high` exactly once, using the `incomingAudio.high ?? incomingAudio.treb ?? 0` fallback chain, without first spreading a value that is immediately overwritten.
2. THE resulting `audio.high` value SHALL equal `incomingAudio.high` when that field is a finite number, and SHALL equal `incomingAudio.treb` when `incomingAudio.high` is absent, and SHALL equal `0` when both are absent.

---

### Requirement 6 — Restore Full Per-Pixel Context After Evaluation

**User Story:** As a developer, I want `PerPixelEvaluator.evaluate()` to fully restore the shared `frameCtx` after each vertex evaluation, so that per-pixel side effects do not leak into subsequent vertices or per-frame state.

#### Acceptance Criteria

1. WHEN `PerPixelEvaluator.evaluate()` sets `x`, `y`, `rad`, and `ang` on `frameCtx`, THE PerPixelEvaluator SHALL save the previous values of those fields before setting them and SHALL restore them after the per-pixel closure runs.
2. THE `frameCtx` object SHALL have the same values for `x`, `y`, `rad`, and `ang` after `evaluate()` returns as it had before `evaluate()` was called.

---

### Requirement 8 — Replace Module-Level Guard with Instance State

**User Story:** As a developer, I want the re-entrancy guard in `monitor.js` to be instance state rather than a module-level variable, so that the guard's scope is visible and the code does not silently prevent multiple instances.

#### Acceptance Criteria

1. THE `_windowRefreshActive` guard SHALL be stored as an instance property on `ManagedRendererWindow` rather than as a module-level variable.
2. WHEN `_scheduleRefresh()` sets or clears the guard, THE ManagedRendererWindow SHALL read and write its own instance property.
3. THE module scope of `monitor.js` SHALL NOT contain any mutable state that affects the behaviour of `ManagedRendererWindow` instances.

---

### Requirement 9 — Explicit Error on Missing Preset Frame Data

**User Story:** As a developer, I want preset loading to signal clearly when a user's JSON file is missing required fields, so that misconfigured presets produce a diagnostic message rather than silently inheriting bootstrap values.

#### Acceptance Criteria

1. WHEN `sanitisePreset()` in `src/extension/presets.js` encounters a non-expression preset JSON object that is missing the `frame` key, THE PresetStore SHALL log a `debug`-level message identifying the file and the missing field.
2. WHEN a non-expression preset JSON object is missing the `frame` key, THE sanitisePreset function SHALL use a neutral default frame (all zeros / identity values) rather than silently copying `BOOTSTRAP_PRESET.frame`.
3. THE neutral default frame SHALL produce no visible motion (zoom=1, rot=0, dx=0, dy=0, decay=0.98) so that a misconfigured preset renders as a static image rather than inheriting the demo-wave animation.

---

### Requirement 10 — Efficient PCM Data Transport

**User Story:** As a developer, I want PCM audio data to be transported to the GL helper without serialising it as a JSON array, so that the per-frame IPC overhead is not dominated by encoding and decoding ~10 KB of floating-point text at 60 fps.

#### Acceptance Criteria

1. WHEN `GlBridge.submitFrame()` sends a frame message to the GL helper, THE GlBridge SHALL NOT include `pcmLeft`, `pcmRight`, or `wave_data` as JSON arrays in the frame message payload.
2. THE GlBridge SHALL transport PCM data using a binary encoding (e.g. Base64-encoded typed array, or a separate binary channel) that avoids per-sample JSON number serialisation.
3. WHEN the GL helper receives a frame message, THE helper SHALL be able to reconstruct the PCM arrays from the binary encoding with no loss of precision beyond the original `Float32` representation.
4. WHERE the binary PCM transport is unavailable or disabled, THE GlBridge SHALL fall back to omitting PCM data from the frame message rather than falling back to JSON arrays.

---

### Requirement 11 — Fix import.meta.main Fallback

**User Story:** As a developer, I want `renderer.js` to correctly detect whether it is the entry point, so that it does not attempt to run as an application when imported as a module dependency.

#### Acceptance Criteria

1. WHEN `renderer.js` is executed directly by GJS as the entry point, THE renderer SHALL initialise and run the application.
2. WHEN `renderer.js` is imported as a module by another script that was itself invoked with command-line arguments, THE renderer SHALL NOT attempt to run as an application.
3. THE entry-point detection logic SHALL NOT rely solely on `ARGV.length > 0` as a fallback, because `ARGV` is non-empty in imported modules when the parent was invoked with arguments.
4. IF `import.meta.main` is `undefined` (GJS >= 1.86), THEN THE renderer SHALL use an alternative detection mechanism that is not susceptible to the `ARGV` false-positive (e.g. checking a module-specific marker or using `import.meta.url`).

---

### Requirement 12 — IPC Input Validation

**User Story:** As a developer, I want IPC message handlers to validate input size before parsing, so that a misbehaving or malicious peer cannot cause unbounded memory allocation by sending an oversized line.

#### Acceptance Criteria

1. WHEN `IpcServer._handleLine()` receives a line, THE IpcServer SHALL reject lines whose byte length exceeds a defined maximum (e.g. 2 MB) and SHALL log a `warn`-level message identifying the monitor index and the received length.
2. WHEN `IpcClient._handleLine()` receives a line, THE IpcClient SHALL reject lines whose byte length exceeds the same defined maximum and SHALL log a `warn`-level message.
3. WHEN a line is rejected due to exceeding the maximum length, THE IpcServer or IpcClient SHALL NOT call `JSON.parse()` on that line.
4. THE maximum line length constant SHALL be defined in a single location and SHALL be shared by both IpcServer and IpcClient.
5. WHEN a line is rejected, THE IpcServer SHALL close the current connection and wait for a new one, and THE IpcClient SHALL disconnect and schedule a reconnect.
