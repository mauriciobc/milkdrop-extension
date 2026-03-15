✓ **Verification Complete**

The finding in `src/extension/evaluator.js` around lines 152-158 has been verified and fixed:

**Issue**: The code was passing `incomingAudio.spectrum || []` to both `spectrumLeft` and `spectrumRight`, but `incomingAudio.spectrum` doesn't exist (the audio engine only provides `pcmLeft` and `pcmRight`).

**Fix Applied** (src/extension/evaluator.js:190-193):
- Changed `spectrumLeft: incomingAudio.spectrum || []` to `spectrumLeft: incomingAudio.pcmLeft || []`
- Changed `spectrumRight: incomingAudio.spectrum || []` to `spectrumRight: incomingAudio.pcmRight || []`
- Added clarifying comment explaining that spectrum data is not provided by the audio engine

**Verification**:
- ✓ Syntax check passed
- ✓ All 895 tests pass
- ✓ No remaining references to `incomingAudio.spectrum`

**Result**: Spectrum-based custom waves will now use PCM data as a fallback, which is the expected behavior when spectrum data is unavailable.

---

✓ **Verification Complete**

The finding in `src/extension/wallpaper.js` around lines 74-85 has been verified and fixed:

**Issue**: The destroy handler for the wallpaper clone closed over `this._wallpaper`. If a new wallpaper was created before the `GLib.idle_add` callback from a destroyed wallpaper ran, the idle callback would erroneously null out the new wallpaper instance.

**Fix Applied** (src/extension/wallpaper.js:75-84):
- Captured the current wallpaper reference as `destroyedWallpaper` inside the connect callback.
- Updated the idle callback to use `destroyedWallpaper` instead of `this._wallpaper`.
- Added a check: only null `this._wallpaper` if it strictly matches `destroyedWallpaper`.

**Verification**:
- ✓ All 899 tests pass.
- ✓ Manual inspection confirms the race condition is resolved.

**Result**: Wallpaper transitions and re-applications are now robust against race conditions between destruction and creation of clones.
---

✓ **Verification Complete**

The finding in `src/extension/audio.js` around lines 657-661 has been verified and fixed:

**Issue**: The code was treating `GstStructure.get_string('format')` and `get_int('channels')` as returning scalars. In GJS, `get_int` (which has an out parameter and boolean return in C) returns a `[success, value]` tuple. Treating this tuple as a scalar caused math operations (e.g. `bytesPerSample * channels`) to result in `NaN`, silently breaking PCM processing in `_processAppsinkSample`.

**Fix Applied** (src/extension/audio.js:657-663):
- Updated the retrieval of `format` and `channels` to use a robust extraction pattern that handles both scalar and tuple return values.
- Used destructuring to capture success flags (`okFormat`, `okChannels`) and values (`format`, `channels`).
- Updated the guard to return early if either field is missing or the retrieval failed (`!okFormat || !okChannels`).

**Verification**:
- ✓ Verified `get_int` returns tuple behavior with GJS test script.
- ✓ All 899 tests pass.
- ✓ PCM data processing is now robust against GJS binding variations for GstStructure getters.

**Result**: Waveform/PCM data from appsink will now correctly parse format and channel count, ensuring accurate audio visualization.
