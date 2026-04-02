# Plan: Rewrite MprisWatcher + Monitor.js Fixes

## Scope

Two independent files with targeted changes. Public API of `MprisWatcher` is unchanged — `monitor.js` integration and pure-function tests require no modifications.

---

## File 1: `src/extension/mpris-watcher.js` — Full internal rewrite

### What changes

Replace all `call_sync` + `signal_subscribe` internals with `Gio.DBusProxy.makeProxyWrapper`-based async equivalents, matching the pattern used by GNOME Shell's own `js/ui/mpris.js`.

### What stays

- All exported symbols: `parsePlaybackStatusFromUnpacked`, `hasActivePlaybackFromMap`, `MprisWatcher`
- `_deepUnpack` private helper
- Public `MprisWatcher` API: `hasActivePlayback`, `enable()`, `disable()`, `setOnPlayingChanged()`
- All constant names that are correct D-Bus identifiers (`MPRIS_PREFIX`, `MPRIS_PATH`, `PLAYER_IFACE`, `STATUS_PLAYING`, `PLAYBACK_STATUS`)

### Step-by-step changes

**Step 1 — Remove now-unused constants**

Remove `DBUS_NAME`, `DBUS_PATH`, `PROPERTIES_IFACE`. They were only needed for the low-level `call_sync`/`signal_subscribe` APIs.

**Step 2 — Add interface XML constants**

Add two module-level string constants for `makeProxyWrapper`:

- `DBUS_IFACE_XML` — `org.freedesktop.DBus` interface with `ListNames` method + `NameOwnerChanged` signal
- `MPRIS_PLAYER_IFACE_XML` — `org.mpris.MediaPlayer2.Player` interface with only the `PlaybackStatus` property

Defined inline (not loaded from gresource) to avoid shell-version dependency.

**Step 3 — Generate proxy classes at module level**

```js
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE_XML);
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE_XML);
```

Generated once per module load.

**Step 4 — Replace state fields in `MprisWatcher` constructor**

| Remove | Add |
|---|---|
| `this._nameOwnerChangedId` | `this._dbusProxy` (DBusProxy for org.freedesktop.DBus) |
| `this._propertySubscriptions` (Map busName→signalId) | `this._playerProxies` (Map busName→MprisPlayerProxy) |
| `this._connection` (kept) | — |
| — | `this._pendingInit` (Set of busNames with in-flight proxy creation) |

**Step 5 — Rewrite `enable()`**

1. Guard `if (this._enabled) return`.
2. Set `this._enabled = true`, assign `this._connection = Gio.DBus.session`.
3. Create `new DBusProxy(connection, 'org.freedesktop.DBus', '/org/freedesktop/DBus', callback)` — async.
4. In callback: store `this._dbusProxy`, attach `connectSignal('NameOwnerChanged', ...)`, call `this._listAndAddPlayers()`.

No synchronous work after step 3.

**Step 6 — Add `_listAndAddPlayers()` (replaces `_refreshPlayers` + `_listMprisNames`)**

1. Call `this._dbusProxy.ListNamesRemote((names, error) => { ... })` — the auto-generated async method.
2. Filter `names` for strings starting with `MPRIS_PREFIX`.
3. For each new MPRIS name: call `_addPlayer(busName)` (skip if already in `_playerProxies`).
4. For each tracked name not in the new list: call `_removePlayer(busName)`.

No `call_sync`. No separate `_listMprisNames` function needed.

**Step 7 — Add `_addPlayer(busName)`**

1. Guard: `if (this._playerProxies.has(busName)) return`.
2. Optimistically set `_playingByBusName.set(busName, false)` and add to `_pendingInit`.
3. Create `new MprisPlayerProxy(connection, busName, MPRIS_PATH, (proxy, error) => { ... })`.
4. In callback:
   - Remove from `_pendingInit`.
   - If `error` or `!this._enabled`: clean up and return.
   - Store proxy in `_playerProxies`.
   - Connect `g-properties-changed` (GObject signal, not D-Bus signal) via `proxy.connect(...)` — store the signal ID on the proxy instance as `proxy._propsChangedId`.
   - Connect `notify::g-name-owner` via `proxy.connect(...)` — store as `proxy._nameOwnerNotifyId`.
   - Read initial status: `const statusStr = proxy.PlaybackStatus ?? ''`.
   - Parse via `parsePlaybackStatusFromUnpacked(statusStr)`.
   - Update `_playingByBusName.set(busName, playing)`.
   - If `hasActivePlayback` changed, call `_onPlayingChanged()`.

**Note on signals**: `g-properties-changed` and `notify::g-name-owner` are GObject signals — use `proxy.connect(...)`. The D-Bus signal `NameOwnerChanged` from the DBusProxy is accessed via `proxy.connectSignal(...)`.

**Step 8 — Add `_removePlayer(busName)`**

1. Retrieve proxy from `_playerProxies`.
2. If proxy exists: disconnect `proxy._propsChangedId` and `proxy._nameOwnerNotifyId`.
3. Delete from `_playerProxies` and `_playingByBusName`.
4. Compare `hasActivePlayback` before/after and notify if changed.

**Step 9 — Rewrite `_onNameOwnerChanged(proxy, nameOwner, [name, oldOwner, newOwner])`**

`makeProxyWrapper`'s `connectSignal` delivers parameters as a pre-unpacked JS array.

1. Filter: `if (!name.startsWith(MPRIS_PREFIX)) return`.
2. If `newOwner` non-empty → `_addPlayer(name)`.
3. If `newOwner` empty → `_removePlayer(name)`.

**No call to `_refreshPlayers()`.** This eliminates the double-fire bug: each transition fires `_onPlayingChanged()` at most once (from inside `_addPlayer`/`_removePlayer`).

**Step 10 — Rewrite `_onPropertiesChanged(busName, proxy, changed)`**

Called from `proxy.connect('g-properties-changed', ...)`.

1. `const changedJS = changed.recursiveUnpack?.() ?? {}`.
2. If `PLAYBACK_STATUS` not in `changedJS`, return.
3. Parse via `parsePlaybackStatusFromUnpacked(changedJS[PLAYBACK_STATUS])` — still needed because `recursiveUnpack` may leave inner values as GVariant objects.
4. Update `_playingByBusName.set(busName, playing)`.
5. Compare before/after `hasActivePlayback`, notify if changed.

**Step 11 — Rewrite `disable()`**

1. Guard `if (!this._enabled) return`.
2. Set `this._enabled = false`.
3. For each proxy in `_playerProxies`: disconnect `_propsChangedId` and `_nameOwnerNotifyId`.
4. `_playerProxies.clear()`, `_playingByBusName.clear()`, `_pendingInit.clear()`.
5. If `_dbusProxy`: it will be GC'd; no manual `signal_unsubscribe` needed (proxy owns its subscriptions).
6. `this._dbusProxy = null`, `this._connection = null`.

---

## File 2: `src/extension/monitor.js` — Two targeted fixes

### Fix A — Inconsistent settings access in `_checkVisibility` (line ~1104)

**Replace:**
```js
let showOnlyWhenMedia = false;
try {
    if (this._settings)
        showOnlyWhenMedia = this._settings.get_boolean('show-only-when-media-playing');
} catch (_e) {}
```
**With:**
```js
const showOnlyWhenMedia = this._getBooleanSetting('show-only-when-media-playing', false);
```

Same fix applies to `_applyMediaOverlayVisibility` (~line 1125) and `GetWindowStatus()` (~line 1194) — three locations total.

### Fix B — Remove perpetual polling timer from `_applyMediaOverlayVisibility` (~line 1169)

**Remove** the entire `if (!visible) { ... } else { ... }` block that schedules self-recursive `GLib.timeout_add` calls.

**Rationale:** `_applyMediaOverlayVisibility` is called from `_checkVisibility()` which is already triggered by all relevant events (settings change, window focus, MPRIS playback change). A permanent 400–800ms poll in the gnome-shell process is unnecessary overhead.

The `_mediaOverlayReapplyTimeoutId` field and its cancellation logic at the top of the method can remain as-is — they become permanent no-ops but are harmless and provide a safety net.

---

## Tests

`tests/extension/mpris-watcher.test.js` — **no changes required.**

- Imports (`parsePlaybackStatusFromUnpacked`, `hasActivePlaybackFromMap`, `MprisWatcher`) all remain exported.
- Pure-function tests are unchanged.
- The class test only checks pre-enable state (no D-Bus access) — continues to pass.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `_addPlayer` callback fires after `disable()` | Guard `if (!this._enabled)` at top of every async callback |
| `connectSignal` vs `connect` confusion | DBus signals (NameOwnerChanged) → `connectSignal`; GObject signals (g-properties-changed, notify::) → `connect` |
| `makeProxyWrapper` unavailability | Available on all GJS/GNOME 47+ — confirmed safe |
| Double-fire eliminated but callback fires 0 times | Each `_addPlayer`/`_removePlayer` independently compares before/after `hasActivePlayback` and notifies |
| Timer removal causes overlay stuck | Event-driven path is sufficient; verify with `just nested` + `busctl` query |

---

## Change Order

1. Rewrite `mpris-watcher.js` (self-contained, no effect until `enable()` called)
2. Apply fixes to `monitor.js` (Fix A and Fix B, can be in same pass)
3. Run `gjs -m tests/run.js` to confirm pure-function tests still pass
