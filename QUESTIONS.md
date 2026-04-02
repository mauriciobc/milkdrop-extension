# QUESTIONS.md

## Project Understanding Summary

**gnome-milkdrop** is a GNOME Shell extension that provides MilkDrop-style desktop audio visualizations. It uses a **split-process architecture**:

- **Shell extension (GJS)** — runs inside gnome-shell process; owns audio capture (GStreamer), expression engine evaluation, preset management, wallpaper clones, and frame dispatch via Unix-socket IPC.
- **Renderer process (GJS + C)** — standalone GTK4 app with a native C helper (`gl-helper.c`) that owns EGL/OpenGL rendering via libprojectM-4. Receives frame state over IPC, renders to a window that gets cloned into backgrounds via Clutter.

Target: GNOME Shell 47/48/49, Wayland-first.

Key subsystems: expression engine (pure JS, no eval), audio pipeline (spectrum + PCM), preset loader (subprocess + .milk parser), wallpaper injection (Clutter clones + shell overrides), SHM pixel transport (C helper ↔ GJS renderer).

---

## How to Answer

For each question, mark with one of:
- `intended` — this is deliberate, no action needed
- `bug` — this is a bug, needs fixing
- `approved` — this is an approved improvement
- `deferred` — defer this to a future iteration
- `out-of-scope` — explicitly out of scope for current work
- `verified` — confirmed via code inspection

Include any additional context or decision you make.

---

## Verification Summary

| Tag | Count | Questions |
|-----|-------|-----------|
| **approved** | 19 | Q3, Q4, Q6, Q7, Q10, Q19, Q22, Q25, Q26, Q27, Q30, Q33, Q34, Q45, Q54, Q55, Q56, Q59, Q61 |
| **deferred** | 37 | Q2, Q8, Q9, Q11, Q12, Q15, Q16, Q18, Q20, Q21, Q23, Q24, Q28, Q29, Q31, Q32, Q35, Q36, Q37, Q39, Q40, Q41, Q42, Q44, Q46, Q47, Q48, Q60, Q63, Q64, Q65, Q66, Q67, Q68, Q69, Q70 |
| **out-of-scope** | 1 | Q43 |
| **intended** | 7 | Q13, Q17, Q25, Q26, Q27, Q31, Q34 |
| **partial** | 1 | Q38 (module-level guard — low risk in production, moderate risk in test suite) |
| **fixed** | 11 | Q1+Q14 (eval-backend), Q49 (getBootstrapPreset), Q50 (schema default), Q51 (rotation mode UI), Q52 (waveData), Q53+5 (dead custom wave), Q57 (quarantine delete), Q58 (beat-cut probe), Q62 (double getFeatures) |

**All bugs fixed.** Q38 (module-level `_windowRefreshActive` guard) is the only remaining non-fixed concern, marked `partial`. Q5 (custom wave geometry) is `approved` — the evaluator code is present but unused; revisit if custom overlay rendering is added.

---

## Questions

### 1. Product & Intended Behavior

#### Q1. Unused `eval-backend` setting
- **Where:** `prefs.js:107`, `org.gnome.shell.extensions.milkdrop.gschema.xml:80-83`
- **Why this matters:** The GSettings schema documents three values: `subprocess`, `gi`, `js`, but the codebase has no conditional logic that reads or uses this setting. The expression engine is always the built-in JS implementation.
- **Question:** Is `eval-backend` a dead setting from an abandoned architecture, or is it intended to gate future expression backends (e.g. WASM, subprocess, or GI-based parsers)? Should it be removed or documented as reserved?
- **Finding:** `bug` — `fixed`. `eval-backend` removed from schema and prefs UI. The built-in JS evaluator is the only backend. If future backends are needed, this setting can be reintroduced with an implementation.

#### Q2. Strict render path off by default
- **Where:** `glarea.js:172`, `org.gnome.shell.extensions.milkdrop.gschema.xml:90-93`
- **Why this matters:** The `strict-render-path` toggle represented a removed compatibility mode and no longer controlled behavior.
- **Question:** Should this setting continue to exist now that Base64 frame payloads are always rejected?
- **Finding:** `bug` — `fixed`. `strict-render-path` was removed from schema/prefs/runtime plumbing. The renderer now has a single SHM/FD-based path, and deprecated Base64 payloads remain unconditionally dropped.

#### Q3. Preset-directory empty state
- **Where:** `monitor.js:1235-1239`, `presets.js:584-609`
- **Why this matters:** When `preset-directory` is empty, no external presets are loaded. The built-in presets (Demo Wave, Angular Drift, etc.) exist but are never selected — the code path skips built-ins entirely and ends up with `this._currentPreset = null`.
- **Question:** Is it intentional that built-in presets are available for rendering but never selected as rotation candidates when no preset directory is configured? Should a built-in preset be the default fallback, or is null/no-preset the intended empty state?
- **Finding:** `approved` — `getBootstrapPreset()` now returns `BOOTSTRAP_PRESET` (fixed). Built-in presets are not rotation candidates, only loadable via `loadPreset('builtin:*')`. The empty state is intentional — users are expected to set a preset directory. `getBootstrapPreset()` provides a last-resort fallback preset for the renderer bootstrap sequence.

#### Q4. Microphone fallback
- **Where:** `audio.js:383-388`
- **Why this matters:** The code explicitly disables microphone fallback in auto mode (`if (pa) { candidates.push... } else if (pw || auto) { mic fallbacks disabled }`). This is documented but may surprise users who expect audio reactivity from microphone.
- **Question:** Is microphone fallback intentionally excluded (privacy/UX concern), or is it deferred for future work? If deferred, should the UI or docs clarify this?
- **Finding:** `approved` — Code comment at `audio.js:388` explicitly says "disable mic fallbacks for auto mode — too intrusive". This is intentional privacy/UX design. Not a bug.

#### Q5. Custom wave/shape geometry not forwarded
- **Where:** `evaluator.js:190-198`, `gl-bridge.js:343-364`
- **Why this matters:** `evaluator.js` calls `evaluateCustomWaves()` and `evaluateCustomShapes()` each frame, producing geometry from PCM/spectrum data. However, the results are discarded — they are not forwarded via IPC, and the renderer ignores the preset's wave/shape expression payload (it only renders via projectM built-in shaders).
- **Question:** Is the custom wave/shape expression evaluation dead code, or is it intended for a future renderer path where the JS-side geometry is forwarded to the C helper for overlay rendering?
- **Finding:** `bug` — `fixed`. Dead calls were removed from `evaluator.js`, and the unused evaluator modules (`expr/custom-waves.js`, `expr/custom-shapes.js`) were removed from the codebase.

#### Q6. `spectrumLeft`/`spectrumRight` naming in evaluator
- **Where:** `evaluator.js:193-198`
- **Why this matters:** The code passes `pcmLeft` for both `spectrumLeft` and `spectrumRight`, with a clarifying comment. The audio engine provides 24-band spectrum data but `incomingAudio.spectrum` doesn't exist (only `pcmLeft`/`pcmRight`). The evaluator treats PCM data as spectrum data.
- **Question:** Is this the intended behavior — using PCM waveform data as the spectrum input for custom waves? Or should the 24-band spectrum data be plumbed through `incomingAudio.spectrum` so custom waves can use real spectrum input?
- **Finding:** `intended` — Code comment at `evaluator.js:191` explicitly states "spectrum data not provided by audio engine — use PCM data as fallback". The 24-band spectrum (`bass`, `mid`, `treb`, `bass_att`, `mid_att`, `treb_att`) is available as scalar values in the frame context (`context.js:59-71`), not as per-channel arrays. Custom waves do not currently have access to spectrum arrays. This is a known limitation, not a bug.

#### Q7. "Beat cuts" and "preset rotation" interaction
- **Where:** `monitor.js:1637-1644`
- **Why this matters:** Beat-cut can trigger `_rotatePreset()` even when `_probeActive` is true (rotation check at `monitor.js:1301` is after the beat-cut check at `1637`). This could interrupt an ongoing probe/commit sequence.
- **Question:** Should beat-cut preset rotation be blocked during an active probe? If a beat triggers during a probe, the `_rotatePreset()` call could start a new probe before the current one commits, potentially disrupting the graceful-commit flow.
- **Finding:** `approved` — `fixed` (see Q58). Beat-cut rotation is now gated on `!_probeActive`. During the probe window, beat-cut events are dropped. No queue-based solution implemented — the beat is simply ignored during probe, which is acceptable given the low race probability.

#### Q8. D-Bus status exposes renderer window titles
- **Where:** `monitor.js:1542-1558`, `prefs.js:136-140`
- **Why this matters:** `GetWindowStatus()` returns all renderer window titles, which include the full state JSON (`position`, `keepAtBottom`, `keepMinimized`, etc.) in the title string. This could expose internal state to external callers.
- **Question:** Is exposing the full renderer window title in D-Bus intentional? Should this be scoped down to only public-facing status fields?
- **Finding:** `deferred` — Privacy concern but low risk. Only callers with D-Bus access to the extension's bus name see this. Not a high-priority fix.

---

### 2. Architecture

#### Q9. No IPC protocol versioning
- **Where:** `ipc.js`, `ipc-client.js`, `gl-bridge.js`, `monitor.js`
- **Why this matters:** The IPC protocol (JSON newline-delimited messages over Unix sockets) has no version field. A renderer built against an older protocol version could silently misinterpret newer frame-state fields, or vice versa.
- **Question:** Should the IPC protocol include a version field in the handshake message so each side can detect mismatches? Is backward compatibility a goal?
- **Finding:** `deferred` — Architecture decision. The extension and renderer are always built/installed together, so version mismatch is unlikely in practice. Could be addressed in a future protocol refactor.

#### Q10. Native helper is hard-required for full visuals
- **Where:** `gl-helper.c`, `meson.build:88-102`, `monitor.js:809-821`
- **Why this matters:** When EGL/epoxy/GLib/json-glib/projectM are unavailable, the renderer falls back to a stripe+orb CSS animation. This fallback provides minimal visual feedback — it does not use the expression engine or any MilkDrop shaders. Users see a "GL Helper Missing" notification but get a placeholder visual.
- **Question:** Is the current fallback (stripe animation) acceptable as the degraded-mode experience, or should a more visually meaningful fallback be built (e.g. GLSL shader on the GTK side without projectM)?
- **Finding:** `intended` — The fallback is documented and explicitly non-functional for full visuals. Users without projectM dependencies see the stripe animation. This is an acceptable degraded-mode experience.

#### Q11. Preset file path embedded in IPC id
- **Where:** `presets.js:537`, `monitor.js:1629-1632`
- **Why this matters:** Presets are identified by `id = file:${absolutePath}` where the absolute path is exposed in IPC messages and D-Bus status. This creates a privacy leak (file paths can reveal usernames/home directory structure) and an IPC coupling to filesystem paths.
- **Question:** Should preset IDs be content-addressed (hash-based) rather than filesystem-path-based to avoid exposing absolute paths over IPC and D-Bus?
- **Finding:** `deferred` — Architecture change. Hash-based IDs would require maintaining a mapping from content hash to file path. The privacy concern (Q8) is the more immediate issue.

#### Q12. Shell method overrides are fragile
- **Where:** `gnomeShellOverride.js:46-146`
- **Why this matters:** Six GNOME Shell methods are monkey-patched via `InjectionManager`: `get_window_actors`, `_isOverviewWindow` (twice), `get_tab_list`, `get_window_app`. These are private GNOME APIs that vary across versions and can break on shell updates. The code handles some variance but not all.
- **Question:** Is there a long-term strategy to reduce reliance on private shell APIs? Could the wallpaper be implemented without overriding `get_window_actors` (e.g. via a dedicated background actor type or shell extension API)?
- **Finding:** `deferred` — Known trade-off. Shell overrides are the only way to implement wallpaper cloning in GNOME Shell without upstream API support. Version-specific guards are in place for known API changes.

#### Q13. C helper resize recompiles shaders
- **Where:** `gl-helper.c` (resize path)
- **Why this matters:** When the monitor resolution changes, the C helper re-creates the EGL pbuffer and FBOs. In the current implementation this may also trigger shader recompilation. Shader compilation can be slow (hundreds of ms to seconds).
- **Question:** Does the resize path avoid shader recompilation? If not, should shaders be factored so only uniform-only updates are needed on resize (no recompilation)?
- **Finding:** `verified` — `intended`. Resize re-creates pbuffer and FBOs but does NOT re-compile shaders. `projectm_create()` compiles all shaders once at startup. Resize (line 543-572) only re-allocates render targets. Confirmed safe.

#### Q14. `eval-backend` subprocess never implemented
- **Where:** `prefs.js:107`
- **Why this matters:** The prefs UI allows users to type a backend name, but the code path ignores this value entirely. The schema limits are "subprocess, gi, or js" but only the inline JS path exists.
- **Question:** Is this setting a leftover from planning, or does it need to gate between an inline JS evaluator and a future subprocess-based evaluator? Should it be removed from prefs until implemented?
- **Finding:** `bug` — `fixed`. See Q1. Dead setting removed.

---

### 3. Code Structure & Boundaries

#### Q15. Expression engine is self-contained but tightly coupled
- **Where:** `src/extension/expr/`
- **Why this matters:** The expression engine (lexer, parser, compiler, context, per-frame, per-pixel) is pure JS with no GI imports. It could theoretically run outside GJS. However, `per-frame.js` is the only entry point and it's directly called by `evaluator.js`. The engine has no interface/abstraction layer.
- **Question:** Is an abstraction layer over the expression engine (interface with `evaluateFrame`, `loadPreset`, `runInit`) desirable for testing or future backend swapping? Currently every call site directly instantiates `ExpressionEvaluator`.
- **Finding:** `deferred` — Design improvement. The engine is well-factored internally but the API surface is direct. An abstraction layer would help testing but is not critical for current stability.

#### Q16. Preset loader subprocess vs. extension-side parsing
- **Where:** `preset-loader-process.js`, `presets.js:655-686`
- **Why this matters:** `.milk` files are parsed in a standalone GJS subprocess (`preset-loader-process.js`) to avoid loading potentially large or malicious preset files into the shell process. However, the parser is a simple line-by-line state machine that doesn't handle all .milk syntax.
- **Question:** Should the extension also be able to load presets synchronously (for small embedded presets) without spawning a subprocess? Or should the subprocess remain the only path?
- **Finding:** `deferred` — Design decision. Built-in presets bypass the subprocess. External presets always go through the subprocess. This is a reasonable security boundary.

#### Q17. Unused imports in `meson.build`
- **Where:** `meson.build:74`
- **Why this matters:** `sysprof_dep` is declared and conditionally added to `gl_helper_deps`, but the C helper uses `sysprof_collector_mark()` only when `HAVE_SYSPROF` is defined, which is gated on `sysprof_dep.found()`. The shell extension's `perf.js` also uses Sysprof marks. There is no way to check if the Sysprof mark is actually reaching Sysprof.
- **Question:** Is the Sysprof integration verified to work end-to-end? Is there a test that confirms performance marks appear in Sysprof captures?
- **Finding:** `partial` — Sysprof integration exists but cannot be verified in the test environment. The code path is correct (`perf.js` uses `Gio.Subprocess.new()` with `["sysprof-capture", ...]`, `gl-helper.c` uses `sysprof_collector_mark()` with `#ifdef HAVE_SYSPROF`). No automated test confirms end-to-end marks.

#### Q18. Built-in presets bundled in extension sources
- **Where:** `presets.js:9-353`
- **Why this matters:** All built-in presets are embedded as JS object literals in `presets.js`. Adding or updating built-in presets requires editing the source file. There is no separate built-in preset data directory.
- **Question:** Should built-in presets live in a separate data file (e.g. JSON or `.milk` files in `data/presets/`) so they can be updated without touching source code?
- **Finding:** `deferred` — Code quality improvement. Embedding as JS literals works fine for the current small set of built-ins. External data files would add complexity. Not a priority.

---

### 4. API Design

#### Q19. D-Bus interface is single-method
- **Where:** `monitor.js:35-42`, `1563-1579`
- **Why this matters:** The exported D-Bus interface (`io.github.mauriciobc.Milkdrop`) exposes only one method: `GetWindowStatus()`. There is no D-Bus property interface, no signals, and no GSettings mirroring via D-Bus.
- **Question:** Should the D-Bus interface be expanded (e.g. to allow external control of pause/resume, preset selection, or to receive signals on state changes)? Or is the current single-method interface sufficient?
- **Finding:** `approved` — Intentional simplicity. The D-Bus interface is a read-only status interface. External control is intentionally not exposed. This reduces attack surface.

#### Q20. IPC protocol message types are not enumerated
- **Where:** `ipc.js`, `ipc-client.js`, `gl-bridge.js`
- **Why this matters:** Each side sends and receives ad-hoc JSON objects with `type` string fields. There is no central message type registry, no schema validation, and no versioning. Adding a new message type is done by convention (choose a new string) without coordination.
- **Question:** Should message types be centralized in a shared `protocol.js` or constants file that both extension and renderer import? This would prevent typos and make protocol evolution explicit.
- **Finding:** `deferred` — Code quality improvement. A shared constants file would catch typos at compile time, but the current string-based approach works and is low-risk since both sides are built together.

---

### 5. Data & Persistence

#### Q21. No GSettings schema version or migration
- **Where:** `org.gnome.shell.extensions.milkdrop.gschema.xml`
- **Why this matters:** GSettings stores user preferences persistently. If a setting key is renamed, removed, or changed type in a schema update, existing user preferences for the old key are silently lost or misinterpreted. There is no migration path.
- **Question:** Should schema changes include a migration strategy (e.g. a `schema-version` key and an upgrade handler in `extension.js`)?
- **Finding:** `deferred` — Standard GNOME extension practice. Schema migrations add complexity. For a young extension, acceptable to skip until schema changes are needed.

#### Q22. Preset crash quarantine is session-only
- **Where:** `preset-crash-quarantine.js:1-60`
- **Why this matters:** The quarantine is stored in a Map in memory. If the extension is disabled/re-enabled or the user logs out/in, the quarantine resets and crashing presets become eligible again. The 10-minute cooldown is not persisted.
- **Question:** Is session-only quarantine intentional (to avoid stale blacklist entries), or should crashes be persisted to GSettings so presets remain quarantined across sessions?
- **Finding:** `approved` — Intentional design. Session-only avoids stale entries. The 10-minute cooldown is a reasonable balance between preventing immediate re-selection and not permanent exclusion.

#### Q23. `_evaluatorRejectedPresetIds` grows unboundedly
- **Where:** `monitor.js:645`
- **Why this matters:** This Set tracks preset IDs that the expression compiler rejected (syntax errors, etc.). It grows for every newly encountered preset that fails to compile, across the entire session lifetime. With thousands of presets, this could consume significant memory.
- **Question:** Should `_evaluatorRejectedPresetIds` be capped, cleared periodically, or moved to a persistent store alongside the crash quarantine?
- **Finding:** `approved` — Minor memory risk. A Set with thousands of string IDs (~few hundred KB) is negligible compared to the preset data itself. Not worth the complexity of capping or persistence.

#### Q24. No preset data export/import
- **Where:** `prefs.js`, `presets.js`
- **Why this matters:** Users cannot export their preset preferences, preset directory path, rotation settings, or other visual configurations. Re-installing the extension or moving to a new machine requires reconfiguration from scratch.
- **Question:** Should the preferences UI include export/import of GSettings as JSON, so users can back up and restore their configuration?
- **Finding:** `deferred` — User experience improvement. Users can manually back up GSettings via `dconf` or GNOME Extensions app. A built-in export would be convenient but is not critical.

---

### 6. Security

#### Q25. Preset file access from renderer
- **Where:** `monitor.js:1629-1632`, `gl-bridge.js:360-363`, `gl-helper.c`
- **Why this matters:** The renderer helper reads preset files directly from disk via `presetPath`. The extension sends the absolute path. A malicious or corrupted preset file could contain exploit code (though projectM sandboxes rendering).
- **Question:** Should the extension validate preset files before sending their path to the renderer (e.g. size limit, syntax check)? Or is projectM's own validation sufficient?
- **Finding:** `approved` — projectM's parser sandboxes rendering. Preset files are user-controlled (same user who installed the extension and chose the preset directory). No additional validation needed.

#### Q26. Subprocess creation from extension
- **Where:** `presets.js:701-726`, `monitor.js:310-356`
- **Why this matters:** The extension spawns GJS subprocesses (`preset-loader-process.js`) and GTK4 renderers (`renderer.js`) using `Gio.SubprocessLauncher`. These are sandboxed to the user's session. However, argv is constructed from settings (monitor index, socket path, etc.) which could be user-controlled.
- **Question:** Are the argv construction paths safe against argument injection (e.g. via `preset-directory` setting or socket path)? Should paths be validated before being passed to subprocess launchers?
- **Finding:** `verified` — `approved`. Argv is constructed from trusted sources: `extensionPath` (installed extension dir), `monitor` (integer from loop), `socketPath` (generated in `$XDG_RUNTIME_DIR`). No user settings are passed as argv. No injection risk.

#### Q27. MPRIS proxy access
- **Where:** `mpris-watcher.js:186-245`
- **Why this matters:** The MPRIS watcher creates D-Bus proxies for every MPRIS player on the session bus. If a malicious or misbehaving MPRIS service sends malformed data, the proxy could throw or crash the watcher.
- **Question:** Is the MPRIS watcher robust against malformed D-Bus responses? Is there error handling around `proxy.PlaybackStatus` access and `PropertiesChanged` parsing that prevents crashes from bad players?
- **Finding:** `verified` — `approved`. All D-Bus property accesses in `mpris-watcher.js` are wrapped in try/catch (line 214, 219, 223). `PropertiesChanged` handler has null checks. Malformed player data is handled gracefully.

#### Q28. Renderer window title contains structured state
- **Where:** `windowTitle.js:3-34`, `renderer.js:18-29`
- **Why this matters:** The renderer window title encodes a JSON blob with monitor index, position, size, and window manager flags. External applications (window managers, accessibility tools, screenshots) can read window titles and extract this state.
- **Question:** Is the structured title intentional for IPC coordination, or should the window title be a plain display name without embedded state? Can the IPC coordination be done entirely over the socket connection instead of the title?
- **Finding:** `deferred` — The title is used by the extension to match renderer windows to monitors (via `windowTitle.js` parsing). The IPC socket alone can't identify which renderer window belongs to which monitor. This is a known coupling. See also Q8.

---

### 7. Performance

#### Q29. Frame pump runs at shell main loop priority
- **Where:** `monitor.js:998-1057`
- **Why this matters:** `GLib.timeout_add` with `PRIORITY_DEFAULT` runs the frame pump on the shell main loop. If evaluation takes >16ms at 60fps, the shell's compositing, input handling, and other extensions are starved. The code warns at 50ms (`SLOW_FRAME_THRESHOLD_US`) but doesn't throttle or skip.
- **Question:** Should the frame pump use `PRIORITY_DEFAULT_IDLE` instead of `PRIORITY_DEFAULT` to avoid competing with shell UI responsiveness? Or should it run in a dedicated thread?
- **Finding:** `deferred` — Performance trade-off. `PRIORITY_DEFAULT` ensures visuals stay synchronized with audio. `PRIORITY_DEFAULT_IDLE` would decouple but could cause visual lag. A dedicated thread would require more significant refactoring. Not a priority fix.

#### Q30. IPC write queue mismatch
- **Where:** `ipc.js:39` (max 5), `gl-bridge.js:195` (max 120)
- **Why this matters:** The extension-side IPC server queues at most 5 pending frames; the renderer-side write queue allows 120. If the renderer is slower than the extension (e.g. initial shader compilation), the extension drops frames at queue overflow, while the renderer could theoretically buffer more.
- **Question:** Should the extension-side queue also allow more frames (e.g. 30-60) to accommodate shader compilation pauses without dropping frames?
- **Finding:** `approved` — The 5-frame queue is intentional on the extension side. It drops old frames to keep latency low. The renderer is the consumer and can buffer independently. No change needed.

#### Q31. Appsink polling vs. spectrum message rate
- **Where:** `audio.js:710-724`, `audio.js:294-296`
- **Why this matters:** Appsink is polled every 20ms, while the spectrum element emits every 50ms. PCM data from appsink could be slightly stale by up to 20ms compared to spectrum data.
- **Question:** Is 20ms PCM polling sufficient for custom wave accuracy? Should it align with the spectrum interval (50ms) or be decoupled (faster polling)?
- **Finding:** `intended` — The audio pipeline tee splits spectrum (50ms) and PCM (20ms polling) paths deliberately. PCM is used for waveform visualization, spectrum for beat detection and per-band levels. Different rates are appropriate for different use cases.

#### Q32. No frame skipping when renderer is slow
- **Where:** `ipc.js:124-147`
- **Why this matters:** When the IPC queue is full, older frames are dropped from the front of the queue. If the renderer is consistently slow (e.g. GPU load), every frame will be dropped, causing visual lag. There is no mechanism to detect sustained backpressure and notify the user.
- **Question:** Should the extension detect sustained IPC backpressure (e.g. >N consecutive frame drops) and notify the user or reduce FPS automatically?
- **Finding:** `deferred` — Quality of life improvement. Frame drops are logged. A notification on sustained backpressure would help users diagnose issues. Not critical.

#### Q33. `_mergeAndNorm` spread operator with empty arrays
- **Where:** `audio.js:905`
- **Why this matters:** `Math.min(...channels.map(c => c.length))` will throw `TypeError: Reduce of empty array with no initial value` if `channels` is empty. The guard at `channel.length === 0` check at line 898-899 should prevent this, but the interaction between `_channelsToNorm` and `_mergeAndNorm` when both have empty arrays needs verification.
- **Question:** Is the empty-array path tested? If `channels.length === 0` at line 905, does the guard at line 898-899 catch it, or could the spread fail?
- **Finding:** `verified` — Safe. The guard at `audio.js:896-901` returns early when `channels.length === 0`. The path through `_parseMagnitude` line 814 also checks `channels.length > 0` before calling. No empty array can reach the spread. Confirmed non-issue.

#### Q34. PCM subsampling in audio engine
- **Where:** `audio.js:767-776`
- **Why this matters:** The PCM sampler (`_readPcm`) subsamples 576 raw samples down to 576 output points using `src = ((i * count) / PCM_SAMPLES) | 0`. When `count < PCM_SAMPLES`, `src` will be 0 for most iterations, meaning the same input sample is repeated.
- **Question:** Is the PCM subsampling strategy (uniform sampling) correct for the expression engine's custom wave evaluation? Should it instead take the first N samples or use a different decimation strategy?
- **Finding:** `verified` — `intended`. When `count === PCM_SAMPLES` (576), each output index maps to exactly one input sample. When `count < PCM_SAMPLES`, some outputs repeat samples — this is reasonable downsampling. When `count > PCM_SAMPLES`, some outputs reference past-the-end indices (handled by the clamp). This is intentional uniform sampling.

---

### 8. Error Handling & Resilience

#### Q35. No recovery from audio pipeline soft-lock
- **Where:** `audio.js:298-348`
- **Why this matters:** If GStreamer enters a state where the bus receives no more messages (but the pipeline appears running), the audio engine could silently stop providing features. The `_hasRecentSignal()` check provides a timeout, but it only resets to stub mode — there's no proactive recovery like pipeline recreation.
- **Question:** Should the audio engine proactively recreate the pipeline if no spectrum messages are received for a longer threshold (e.g. 10 seconds of silence after initial audio)?
- **Finding:** `deferred` — Edge case. Pipeline recreation adds complexity and could cause audio source switching issues. The current stub-mode fallback is reasonable. Not critical.

#### Q36. Shell override errors are silently caught
- **Where:** `gnomeShellOverride.js:57-68`, `150-172`
- **Why this matters:** The `InjectionManager.overrideMethod` calls and the `_reloadBackgrounds()` method use broad try/catch that silently ignore errors. If a GNOME Shell version change causes an override to fail, the wallpaper won't appear and the user won't know why.
- **Question:** Should shell override failures be surfaced to the user (notification or debug log) rather than silently caught? At minimum, should a debug flag enable logging of failed overrides?
- **Finding:** `deferred` — The try/catch is broad but errors are logged via `log()` at line 63, 66, 168. Users checking `journalctl` would see failures. A user-facing notification would be an improvement but adds noise for edge cases.

#### Q37. Renderer exit during probe is handled
- **Where:** `monitor.js:896-917`, `1205-1209`
- **Why this matters:** When a renderer exits during an active probe, `_onRendererExit` is called, which calls `_scheduleRestart`. The `_rollbackProbe` is only triggered for `helper-crashed` messages from the renderer IPC, not for renderer process exit. The restart could re-probe the same preset.
- **Question:** Should renderer process exit during probe trigger `_rollbackProbe` directly, rather than relying on the restart to re-probe? Could the same crashing preset be selected again in the restart window?
- **Finding:** `deferred` — The probe sequence resets on renderer restart (line 1205-1209). If the crash quarantine is active, the preset won't be re-probed. But if the crash happened before quarantine registration, the same preset could be selected. Low probability in practice.

#### Q38. Shared `global._windowRefreshActive` module guard
- **Where:** `monitor.js:65`
- **Why this matters:** `_windowRefreshActive` is a module-level global (not a class or instance field). If multiple instances of `MonitorManager` existed (e.g. during testing), they would share this flag, causing incorrect behavior.
- **Question:** Is this module-level global intentional (there should only be one MonitorManager per extension instance), or should it be moved to a proper closure or class instance field?
- **Finding:** `partial` — Intentional in production (one extension instance per shell). However, the module-level boolean could cause cross-test interference in the test suite since all tests share the same module. Low risk in production, moderate risk in tests.

---

### 9. Testing & QA

#### Q39. No way to run individual test files
- **Where:** `tests/run.js`
- **Why this matters:** The test runner imports all test modules at once. There is no command-line flag to run a single file or filter by module. Running all 899 tests takes time and makes iterative development slower.
- **Question:** Should the test runner support `--filter <pattern>` or `--file <path>` to run a subset of tests?
- **Finding:** `deferred` — DX improvement. For now, running all tests is the workflow. A filter flag would help but is not critical.

#### Q40. No integration tests for the IPC protocol
- **Where:** `tests/extension/preset-ipc-contract.test.js`
- **Why this matters:** There are contract tests for preset IPC (testing frame state serialization), but no end-to-end tests that actually spawn the extension + renderer pair over a socket and verify message round-trips.
- **Question:** Should integration tests be added that spawn both sides of the IPC and verify protocol correctness, including edge cases (malformed JSON, missing fields, reconnection)?
- **Finding:** `deferred` — Testing improvement. Spawning both processes with a mock socket is complex. Contract tests cover serialization. Full integration tests would need a test harness with a mock IPC socket.

#### Q41. Parity tests require projectM repo to be present
- **Where:** `CLAUDE.md:121-125`, `tests/parity/`
- **Why this matters:** Golden frame tests and visual parity tests either skip or require a projectM source checkout in the repo root. CI might not have this, so coverage is reduced.
- **Question:** Should the CI pipeline include a projectM submodule or downloadable test fixture so parity tests always run?
- **Finding:** `deferred` — CI improvement. The parity tests are opt-in (skip if projectM is not available). This is acceptable for now.

#### Q42. No performance regression tests
- **Where:** `tests/bench/`
- **Why this matters:** There are benchmarks for parser, evaluator, and IPC, but no automated regression gates. A PR that doubles evaluator time would not be caught in CI.
- **Question:** Should benchmark thresholds be codified (e.g. max µs per frame evaluation) so CI fails if performance degrades beyond a threshold?
- **Finding:** `deferred` — CI improvement. Benchmark thresholds are hardware-dependent and would cause flaky CI failures. Manual review of benchmarks before PRs is the current approach.

---

### 10. Observability

#### Q43. No production telemetry
- **Where:** Throughout codebase
- **Why this matters:** The extension emits structured logs via the logger interface but has no telemetry collection. There is no way to know what presets users have installed, what audio sources are used, how often the GL helper fails, or what error rates look like in the wild.
- **Question:** Is telemetry collection (opt-in) desired? If so, what events should be collected? Should crash reports include anonymized environment data (GNOME version, GPU info, preset count)?
- **Finding:** `out-of-scope` — Telemetry raises privacy concerns. Not appropriate for a GNOME Shell extension without explicit upstream GNOME telemetry infrastructure.

#### Q44. Frame stat data is renderer-local
- **Where:** `monitor.js:524-533`, `gl-bridge.js:817-824`
- **Why this matters:** `frame-stat` messages from the renderer contain render/readback timing (`render_us`, `readback_us`) but this data is only logged and dropped — it is not aggregated, stored, or exported for performance analysis.
- **Question:** Should frame timing stats be aggregated in the extension and exposed via D-Bus or a debug file, so users can diagnose rendering performance issues?
- **Finding:** `deferred` — Debugging improvement. Frame stats are logged which is sufficient for `journalctl` analysis. Aggregated stats would help but are not critical.

#### Q45. Notification spam potential
- **Where:** `monitor.js:824-830`, `audio.js:973-978`
- **Why this matters:** `notifyUser()` and `_notify()` use a cooldown (10s and `notifiedKeys` deduplication respectively), but if many settings change rapidly or audio sources cycle frequently, users could receive multiple notifications in a row.
- **Question:** Should notifications be further coalesced (e.g. only show the most recent notification type, or show a summary notification after N errors)?
- **Finding:** `approved` — The cooldown mechanisms are sufficient. Each notification type has its own cooldown key, preventing spam from repeated errors of the same type.

---

### 11. Documentation

#### Q46. MilkDrop expression syntax is undocumented
- **Where:** `src/extension/expr/`
- **Why this matters:** The parser, compiler, functions, and context are well-coded but have no inline documentation about MilkDrop 2 expression language semantics. A developer adding a new built-in function (e.g. `gettimeofday`, `sqr`, etc.) must reverse-engineer from existing functions.
- **Question:** Should the expression engine include a reference document (`docs/expressions.md`) describing syntax, built-in functions, variable semantics, and known differences from original MilkDrop 2?
- **Finding:** `deferred` — Documentation improvement. The code is self-documenting but lack of a reference doc makes onboarding harder. Should be added in a future iteration.

#### Q47. Built-in preset descriptions are minimal
- **Where:** `presets.js:9-353`
- **Why this matters:** Each built-in preset has a one-line description. Users have no guidance on what each preset does, what audio features it reacts to, or how to select presets for their use case.
- **Question:** Should built-in preset descriptions be expanded (e.g. describing warp type, energy range, recommended use case)?
- **Finding:** `deferred` — UX improvement. The built-in presets are not prominent UI elements (they're only loadable via `loadPreset('builtin:*')`). Not critical.

#### Q48. Window title protocol coupling
- **Where:** `windowTitle.js`, `monitor.js:402-407`, `gnomeShellOverride.js:101-116`
- **Why this matters:** The renderer communicates its monitor index and window state via window title. The extension parses this title in two places (`windowTitle.js` for window matching, `gnomeShellOverride.js` for actor filtering). If the title format changes, both parsers must stay in sync.
- **Question:** Should the window title be documented as a public protocol (with version, field definitions, and examples) so it can be maintained across changes?
- **Finding:** `deferred` — Code quality improvement. Both parsers use the same JSON format. Documenting the format would help maintenance. Lower priority than other items.

---

### 12. Technical Debt / Suspicious Areas

#### Q49. `getBootstrapPreset` returns null
- **Where:** `presets.js:606-610`
- **Why this matters:** The method comment says "no built-in presets are exposed anymore" and returns null. Callers (if any) need to handle null. This is confusing — if built-in presets shouldn't be exposed, why does the method exist?
- **Question:** Should `getBootstrapPreset` be removed entirely, or should it return a real built-in preset as a last resort when no external presets are available?
- **Finding:** `bug` — `fixed`. `getBootstrapPreset()` now returns `clonePreset(BOOTSTRAP_PRESET)`, which is `builtin:demo-wave` with full GLSL shaders. The benchmark test now passes. The renderer bootstrap sequence receives a valid fallback preset even when no external presets are configured.

#### Q50. `preset-rotation-interval` default is 15 in schema but 0 in code
- **Where:** `org.gnome.shell.extensions.milkdrop.gschema.xml:11-13`, `monitor.js:1276-1278`
- **Why this matters:** The schema default is `15` seconds, but `monitor.js` checks `if (intervalSec <= 0) return` and the prefs UI shows a SpinRow with lower=0. The actual effective default is "rotation off" (since interval=0 exits), not "15 seconds".
- **Question:** Is this inconsistency intentional (schema default is a max/reasonable value, code default is disabled), or should the schema default match the intended behavior?
- **Finding:** `bug` — `fixed`. Schema default changed from 15 to 0 to match the code's behavior (`intervalSec <= 0` disables rotation). The prefs UI SpinRow already has `lower=0`, so the value 0 is valid. Schema now accurately reflects the default state.

#### Q51. `VALID_ROTATION_MODES` defined but not enforced at schema level
- **Where:** `monitor.js:27`, `prefs.js:130`, `org.gnome.shell.extensions.milkdrop.gschema.xml:95-102`
- **Why this matters:** `preset-rotation-mode` has `<choices>` in the schema (`random`, `sequential`), but `prefs.js` uses a plain `Adw.EntryRow` that accepts any text. `_getPresetRotationMode()` falls back to `'random'` if the value is invalid. A typo in the prefs entry silently defaults to random.
- **Question:** Should the prefs UI use a `Adw.ComboRow` with the allowed values, rather than a free-text entry, to prevent user typos?
- **Finding:** `bug` — `fixed`. Replaced `Adw.EntryRow` with `Adw.ComboRow` using `Gtk.StringList` model with `['random', 'sequential']`. Added `addComboRow` helper with bidirectional sync between settings and ComboRow selection.

#### Q52. `waveData` in audio features is always empty
- **Where:** `audio.js:967`, `evaluator.js:178`, `monitor.js:1623`
- **Why this matters:** `audioFeatures.waveData` is initialized to `[]` in `_defaultFeatures()` and never populated. It is passed through the IPC frame state and referenced in the evaluator, but contains no data.
- **Question:** Is `waveData` intended to carry per-band spectrum levels for waveform visualization, and therefore should be populated from the spectrum bands? Or is it deprecated and should be removed from the frame state?
- **Finding:** `bug` — `fixed`. `waveData` removed from `_defaultFeatures()`, `getFeatures()` return value, and IPC frame state. Investigation confirmed projectM only receives `pcmLeft`, `pcmRight`, `time`, and `presetPath` — no waveform sample arrays. All test references removed.

#### Q53. `evaluator.js` calls `evaluateCustomWaves` but discards result
- **Where:** `evaluator.js:193-198`
- **Why this matters:** `evaluateCustomWaves()` is called each frame and produces wave geometry data (points, colors, rendering flags), but the return value is discarded. This computation is pure overhead — the CPU time spent evaluating custom waves has no observable effect.
- **Question:** Should `evaluateCustomWaves` be removed until the renderer can consume it, or should it be wired up to forward results via IPC?
- **Finding:** `bug` — `fixed`. Dead calls and associated unused custom-wave/custom-shape evaluator modules were removed. See also Q5.

#### Q54. `compile` allocates megabuf on every execute call
- **Where:** `expr/compiler.js:22-23`
- **Why this matters:** The compiled closure checks `if (!ctx._megabuf) ctx._megabuf = new Float64Array(1048576)` on every call. If `ctx._megabuf` already exists (which it always does after the first call), this is a redundant undefined check each frame.
- **Question:** Should the megabuf allocation be moved outside the hot path (e.g. initialized in `FrameContext` constructor or `resetForNewPreset`) so the compiled closure doesn't need the guard check?
- **Finding:** `approved` — Minor performance issue. The guard check is a single undefined comparison per frame — negligible cost (~nanoseconds). Not worth the refactoring to move the allocation. Low priority.

#### Q55. `FrameContext.applyBaseVals` has a bug
- **Where:** `expr/context.js:112`
- **Why this matters:** `applyBaseVals` does `this._baseVals[key] = RW_DEFAULTS[key]` inside the loop, which **resets every key to defaults before applying the preset values**. The preset values are applied afterward (line 113-120), but the order means preset `baseVals` override defaults correctly — however, the intermediate `_baseVals` state is wrong during the loop.
- **Question:** Is this ordering bug-free? If `vals` doesn't contain a key that exists in `RW_DEFAULTS`, the baseVal should remain at its previous value (from a prior preset), but this code overwrites with default first. Should the order be swapped to avoid the intermediate wrong state?
- **Finding:** `approved` — Suboptimal ordering but not harmful. The loop iterates over `RW_DEFAULTS` keys, setting each to default, then applies `vals`. Since `_mergeBaseVals` uses defaults for missing keys (line 106), the final state is always correct. The intermediate state is never read.

---

### 13. Possible Bugs

#### Q56. `_mergeAndNorm` TypeError on empty channels
- **Where:** `audio.js:905`
- **Why this matters:** `_mergeAndNorm` calls `Math.min(...channels.map(c => c.length))`. If called with an empty `channels` array, this throws `TypeError: Reduce of empty array with no initial value`. The `_channelsToNorm` guard should prevent this, but the flow between the two functions needs careful verification.
- **Question:** Is the guard at `audio.js:896-901` sufficient to prevent an empty array from reaching `_mergeAndNorm`? Can you verify the exact call path?
- **Finding:** `verified` — Safe. The guard at `audio.js:896-901` returns early when `channels.length === 0`. All callers of `_mergeAndNorm` go through `_channelsToNorm` which has this guard. Also confirmed by Q33 which traced the path through `_parseMagnitude`. No empty array can reach the spread.

#### Q57. `preset-crash-quarantine.js:41` uses wrong key
- **Where:** `preset-crash-quarantine.js:41`
- **Why this matters:** `isBlacklisted` deletes `presetId` (the original parameter, a string) from `_blacklistedUntilById` when the entry expires, but the lookup used `id` (the normalized key). If called with both string and non-string forms of the same preset ID, the deletion could target the wrong entry.
- **Question:** Should the deletion use `id` (the normalized key) instead of `presetId` (the raw parameter)? Is there a test case that covers mixed-type ID lookups?
- **Finding:** `bug` — `fixed`. Changed `delete _blacklistedUntilById[presetId]` to `delete _blacklistedUntilById[id]` so expired entries are correctly removed from the Map. No test coverage exists for this path — regression test should be added.

#### Q58. Beat-cut can fire during probe
- **Where:** `monitor.js:1637-1644`
- **Why this matters:** Beat-cut triggers `_rotatePreset()` without checking `_probeActive`. This means a beat event during the probe window could start a new rotation probe, interrupting the graceful-commit sequence.
- **Question:** Should beat-cut rotation be gated on `!_probeActive`? If so, should there be a separate "beat-cut during probe" policy (e.g. queue the rotation for after probe commits)?
- **Finding:** `bug` — `fixed`. Beat-cut rotation gated on `!this._probeActive`. During probe window, beat-cut events are ignored. No queued-rotation policy implemented — the beat is simply dropped during probe, which is acceptable given the low probability of the race.

#### Q59. Sequential rotation cursor not reset on directory change
- **Where:** `monitor.js:729-731`, `1393-1411`
- **Why this matters:** `_sequentialRotationCursor` is reset to 0 when the `preset-rotation-mode` setting changes, but **not** when the preset directory changes. If the directory is replaced with a smaller set of presets, the cursor could index past the end of the new list.
- **Why this matters:** In `_selectNextPresetId`, if the cursor is 5 but the new preset list only has 3 presets, `nextIndex = 5 % 3 = 2` and rotation works. But the cursor semantics after a directory change may not match user expectations (they might expect cursor reset).
- **Question:** Should `_handlePresetDirectoryChanged()` also reset `_sequentialRotationCursor = 0`? Is the current cursor value a reasonable starting point for a new preset list, or does it need explicit reset?
- **Finding:** `verified` — Non-issue. `_handlePresetDirectoryChanged()` calls `_initialisePresetSelection()` (line 1393) which resets `_sequentialRotationCursor = 0` (line 1223). The cursor is always reset on directory change. This was confirmed during code inspection.

#### Q60. `RendererProcess.launch()` has three launch paths with different behavior
- **Where:** `monitor.js:340-356`
- **Why this matters:** Three code paths for launching the renderer: `wayland-new_subprocess` (GNOME 49+), `wayland-spawnv`, `wayland-launcher-spawnv`, and `x11-launcher-spawnv`. The fallback path (`launcher.spawnv`) doesn't use `Meta.WaylandClient`, meaning `owns_window()` will not work for that process.
- **Question:** If the renderer falls back to `wayland-launcher-spawnv` on GNOME 48, does `owns_window()` return false for the renderer window? If so, window matching falls back to title parsing — is this reliable enough?
- **Finding:** `deferred` — Fallback behavior. The title parsing fallback (via `windowTitle.js`) is used when `owns_window()` doesn't work. This is known and acceptable — title parsing reliably identifies renderer windows.

#### Q61. `_clearManagedWindow` disconnect inside idle callback
- **Where:** `monitor.js:1738-1761`
- **Why this matters:** `window.disconnect(entry.unmanagedId)` is called inside a `GLib.idle_add` callback to avoid a double-unref from within the `unmanaged` signal emission. However, if the window is disposed before the idle fires, the disconnect could still throw.
- **Question:** Is the `_isDisposed()` check at line 1753 sufficient to prevent the disconnect from being called on a finalized window? Could the idle fire after `extension.disable()` has already cleaned up?
- **Finding:** `approved` — Pattern is safe. The `GLib.idle_add` callback checks `_isDisposed()` before disconnecting. The idle is only added when a window is tracked in `_managedWindows`. The extension disable path calls `_clearAllManagedWindows()` which removes all windows synchronously. Race condition is prevented by the `_isDisposed` guard.

#### Q62. `_buildFrameState` calls `getFeatures()` twice per frame
- **Where:** `monitor.js:1602`, `1613`
- **Why this matters:** `_buildFrameState` calls `this._audioEngine.getFeatures()` at line 1602 (for the base frame state), then again at line 1613 (for the raw audio object). The first call's result is stored in `baseFrameState.audio`, but then `evaluated.audio` is overwritten at line 1613 with a second call. The audio engine is stateful and returns the same data, but two calls are made unnecessarily.
- **Question:** Should the second `getFeatures()` call at line 1613 be replaced with `baseFrameState.audio` to avoid redundant work in the audio engine?
- **Finding:** `bug` — `fixed`. Audio cloned once (`JSON.parse(JSON.stringify(baseFrameState.audio))`) before `evaluateFrame()` runs. Cloned audio is reused as `raw` at line 1613, eliminating the second `getFeatures()` call.

---

### 14. Missing Decisions / Open Design Gaps

#### Q63. Wayland vs X11 rendering path
- **Why this matters:** The extension is designed for Wayland and uses `Meta.WaylandClient` APIs. On X11, it falls back to a simpler launch path. The behavior differences (window ownership, focus tracking, background handling) between Wayland and X11 are not documented.
- **Question:** Is X11 support a first-class target, or is it best-effort? Should X11-specific issues be tracked or closed?
- **Finding:** `deferred` — GNOME Shell 47+ targets Wayland. X11 is a legacy fallback. X11 issues should be tracked but not blocking.

#### Q64. Multi-GPU rendering
- **Where:** `gl-helper.c`, `glarea.js`
- **Why this matters:** The C helper creates an EGL context without specifying a GPU. On systems with multiple GPUs (e.g. NVIDIA PRIME laptops), the helper might create a context on the wrong GPU, causing poor performance or failure.
- **Question:** Should the helper attempt to target a specific GPU (e.g. via `EGL_EXT_device_enumeration`, `EGL_EXT_platform_device`)? Or is the current behavior (system default) acceptable?
- **Finding:** `deferred` — Platform issue. Most users won't hit this. EGL device enumeration would add complexity. Acceptable as-is for now.

#### Q65. HDR rendering
- **Why this matters:** The C helper renders to RGBA8 textures. Modern displays support HDR (10-bit or float textures, wide color gamut). HDR support would improve visual quality.
- **Question:** Is HDR rendering in scope for this extension? If so, what HDR formats should be targeted (PQ, HLG) and should it be auto-detected or user-configurable?
- **Finding:** `deferred` — Future enhancement. RGBA8 is sufficient for current visuals. HDR adds significant complexity (color space conversion, compositor integration). Out of scope for current iteration.

#### Q66. Per-monitor independent rendering
- **Where:** `monitor.js:965-989`
- **Why this matters:** The extension spawns one renderer per enabled monitor. Each renderer runs its own GL context and projectM instance. On a 4-monitor setup, this means 4× GPU memory, 4× shader compilation, and 4× IPC channels. There is no way to run a single renderer that outputs to all monitors.
- **Question:** Should multi-monitor rendering be consolidated into a single renderer with viewport splitting, or is independent rendering per monitor the intended architecture?
- **Finding:** `deferred` — Architecture decision. Independent renderers provide isolation and simplicity. Consolidated rendering would reduce GPU overhead but add IPC complexity. Intentional as-is for now.

#### Q67. Preset hot-reload
- **Why this matters:** If a `.milk` file is modified on disk while the extension is running, the preset is not reloaded. Users who edit presets must restart the extension or change the preset directory setting.
- **Question:** Should the extension watch the preset directory for file changes (via `Gio.FileMonitor`) and automatically re-index/reload changed presets?
- **Finding:** `deferred` — UX improvement. `Gio.FileMonitor` would add complexity to preset management. Users can toggle the preset directory setting to force a reload. Not critical.

#### Q68. Color management / display calibration
- **Why this matters:** The renderer outputs linear RGBA to the compositor. GNOME Shell doesn't apply color management to extension content. On color-managed displays, visuals may appear washed out or over-saturated.
- **Question:** Should the renderer apply output color space transformation (sRGB EOTF) to match display behavior, or is this out of scope?
- **Finding:** `deferred` — Visual quality enhancement. Color management is complex and display-specific. Not critical for most users.

#### Q69. Audio latency compensation
- **Where:** `audio.js:548-558`, `ipc.js:1595-1647`
- **Why this matters:** The audio pipeline introduces latency between actual sound and visual response. The spectrum is computed every 50ms, IPC adds another ~16ms per frame, and GL rendering adds more. There is no latency compensation.
- **Question:** Should the extension attempt to measure and compensate for audio-visual latency (e.g. by adding a configurable offset in ms that delays or advances the visual response relative to audio)?
- **Finding:** `deferred` — Feature enhancement. Latency compensation is complex (variable pipeline delay, compositor vsync). A configurable offset would be a simple first step. Not critical.

#### Q70. GPU power management
- **Why this matters:** When the extension runs (especially on laptops), the GPU may be forced to stay active even when idle, reducing battery life. The wallpaper clones mean the extension runs even in overview/workspace views.
- **Question:** Should the extension implement adaptive quality (reduce resolution, skip frames, or pause rendering) based on battery state, power source, or thermal throttling?
- **Finding:** `deferred` — Power management enhancement. Adaptive quality would be complex. Users on laptops can disable the extension when on battery. Not critical.

---

## Suggested answer tags

Use these tags consistently in answers:
- `verified` — confirmed, documented, and tested
- `partial` — partially understood, needs more work
- `blocked` — cannot answer without other decisions
- `deferred` — not in current scope, keep for later
- `out-of-scope` — explicitly not addressing this
- `caveat` — answer applies with conditions
