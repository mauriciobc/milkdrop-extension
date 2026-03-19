# Codebase Inspection Backlog

## Summary

**Total Issues Found:** 12  
**Completed:** 6  
**Pending:** 6  

## Completed Fixes

| # | Issue | Priority | Status |
|---|-------|----------|--------|
| 1 | Remove all 32 `FIX:` debug comments from `audio.js` | High | ✅ Done |
| 2 | Remove `[TEST]` debug prefix from `monitor.js:1385` | High | ✅ Done |
| 3 | Remove stale `eslint-disable` comment from `gnomeShellOverride.js` | Medium | ✅ Done |
| 4 | Add debug logging to empty catch in `monitor.js:_clearManagedWindow` | Medium | ✅ Done |
| 5 | Evaluator legacy blend path - verified uses fallback defaults correctly | High | ✅ Not a bug |
| 6 | Remove `← FIXED:` comment from `audio.js:_defaultFeatures` | Medium | ✅ Done |

---

## Pending Items

### HIGH PRIORITY

#### 1. Archive Legacy Documentation Files
**Files:** `PLAN.md`, `AGENTS.md`

These files contain verification notes from previous fixes that are now complete:
- `PLAN.md` - Contains MprisWatcher rewrite plan and monitor.js fixes (already fixed per AGENTS.md)
- `AGENTS.md` - Contains verification notes from 3 previous bug fixes

**Action:** Archive or clean up these files once all items are verified complete.

---

### MEDIUM PRIORITY

#### 2. Cache `_hasSettingKey` Results in `monitor.js`
**Location:** `monitor.js:1828-1837`

The `_hasSettingKey` method is called repeatedly for the same keys throughout the codebase. It performs schema lookups each time.

**Current pattern:**
```js
_hasSettingKey(key) {
    try {
        const schema = this._settings.settings_schema ?? this._settings.get_settings_schema?.();
        return Boolean(schema?.has_key?.(key));
    } catch (_error) {
        return false;
    }
}
```

**Suggested fix:** Cache results in a `Map` or `Set` on first access:
```js
_hasSettingKey(key) {
    if (this._settingKeyCache?.has(key) !== undefined)
        return this._settingKeyCache.get(key);
    // ...existing logic
}
```

---

#### 3. Legacy WaveSpec Path in `evaluator.js`
**Location:** `evaluator.js:215-255`

The code labeled "Legacy WaveSpec path" is still active and handles presets without expression payloads. The expression-based path (lines 139-213) handles presets with `init_eqs`, `frame_eqs`, or `pixel_eqs`.

**Questions to resolve:**
- Are WaveSpec presets still used/loaded by the preset store?
- Can the legacy path be removed or should it be fully documented?

**Current status:** The path is intentionally preserved for backward compatibility with non-expression presets.

---

#### 4. Audio Spectrum Parsing Strategies
**Location:** `audio.js:_parseMagnitude` (lines 810-850)

Three parsing strategies exist for GStreamer spectrum messages:
1. `get_list` (modern GJS)
2. `get_array` (older GJS)
3. `get_value` (GVariant fallback)

**Suggestion:** Add a module-level comment documenting why all three are needed and when each is used. The current approach is defensive but could be clarified.

---

#### 5. Add ESLint Configuration
**Issue:** `gnomeShellOverride.js` had `/* eslint-disable no-invalid-this */` but no ESLint config exists.

**Action:** Either:
- Add ESLint config for GJS (recommended for long-term code quality)
- Or document why linting is not applicable

---

#### 6. `PresetStore.getBootstrapPreset()` Dead Code Check
**Location:** `presets.js:606-610`

```js
getBootstrapPreset() {
    // Compatibility hook: no built-in presets are exposed anymore.
    // Callers should treat this as "no preset selected".
    return null;
}
```

The method always returns `null` with a comment saying built-in presets are no longer exposed.

**Action:** 
- Verify no callers depend on this method
- If unused, remove it
- If used, clarify its purpose

---

## Code Quality Observations

### Patterns That Work Well

1. **Defensive property access:** `?.` and `??` operators used consistently
2. **Error handling:** Try-catch blocks with fallback values
3. **Resource cleanup:** Proper disable() methods with null checks
4. **Memory management:** GLib source IDs properly tracked and cleared

### Patterns to Review

1. **Consistent logging:** Mix of `this._log.info?.()` and `if (this._log.info) this._log.info()` patterns
2. **Module constants:** Some at module level, some as class properties
3. **Async patterns:** Mix of Promise-based and callback-based async code

---

## Testing Coverage

**Current test count:** ~900+ tests passing  
**Test runner:** Custom minimal runner (`tests/run.js`)

### Missing Test Coverage Opportunities:
- Integration tests for IPC message handling
- Audio pipeline restart scenarios
- Preset rotation edge cases

---

## Recommendations

### Short Term (1-2 sprints)
1. Complete the 6 pending items above
2. Archive or clean up `PLAN.md` and `AGENTS.md`
3. Add ESLint configuration for GJS

### Medium Term
1. Document the expression engine architecture
2. Add integration test suite for renderer communication
3. Consider adding property change validation for GSettings

### Long Term
1. Evaluate removing legacy WaveSpec path if not used
2. Add TypeScript annotations for better IDE support
3. Consider migrating to a more structured testing framework
