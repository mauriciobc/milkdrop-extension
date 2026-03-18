/**
 * MPRIS media playback watcher. Tracks whether any MPRIS player on the
 * session bus has PlaybackStatus "Playing". Used to pause visualizations
 * when "show only when media playing" is enabled.
 *
 * Discovery uses async Gio.DBusConnection.call() + signal_subscribe() for
 * org.freedesktop.DBus (the bus daemon itself does not implement the
 * Properties interface, so makeProxyWrapper cannot be used for it).
 *
 * Per-player state uses Gio.DBusProxy (makeProxyWrapper) for automatic
 * property caching and g-properties-changed signal delivery.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYBACK_STATUS = 'PlaybackStatus';
const STATUS_PLAYING = 'Playing';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';

// Interface XML for org.mpris.MediaPlayer2.Player — only PlaybackStatus needed.
const MPRIS_PLAYER_IFACE_XML = `
<node>
  <interface name="${PLAYER_IFACE}">
    <property name="${PLAYBACK_STATUS}" type="s" access="read"/>
  </interface>
</node>`;

// Proxy class generated once at module load — used per-player only.
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE_XML);

function _debugMpris() {
    return GLib.getenv('MILKDROP_DEBUG_MPRIS') === '1';
}

/**
 * Unwrap a D-Bus value that may be a GVariant (e.g. from a{sv}).
 * GJS may leave variant values as GVariant; we need to recursiveUnpack to get the string.
 */
function _deepUnpack(value) {
    if (value == null)
        return value;
    if (typeof value.recursiveUnpack === 'function')
        return _deepUnpack(value.recursiveUnpack());
    return value;
}

/**
 * Parse PlaybackStatus from a proxy property value or PropertiesChanged a{sv} value.
 * - proxy.PlaybackStatus returns a plain string when cached.
 * - PropertiesChanged a{sv} values may remain as GVariant in GJS; must unpack before comparing.
 * Returns { statusStr, playing } where playing is true only when statusStr === 'Playing'.
 */
export function parsePlaybackStatusFromUnpacked(unpacked) {
    const inner = _deepUnpack(unpacked);
    const raw = Array.isArray(inner) ? inner[0] : inner;
    const statusStr = typeof raw === 'string' ? raw : (Array.isArray(raw) && raw.length > 0 ? String(raw[0]) : '');
    return { statusStr, playing: statusStr === STATUS_PLAYING };
}

/** Returns true if any value in the map is true (used for hasActivePlayback). */
export function hasActivePlaybackFromMap(playingByBusName) {
    for (const playing of playingByBusName.values()) {
        if (playing)
            return true;
    }
    return false;
}

export class MprisWatcher {
    constructor({logger = null, onPlayingChanged = null} = {}) {
        this._logger = logger ?? console;
        this._onPlayingChanged = onPlayingChanged ?? null;
        this._connection = null;
        this._nameOwnerChangedId = 0;
        this._playerProxies = new Map();      // busName → MprisPlayerProxy
        this._pendingInit = new Set();        // busNames with in-flight proxy creation
        this._playingByBusName = new Map();   // busName → boolean
        this._enabled = false;
    }

    get hasActivePlayback() {
        return hasActivePlaybackFromMap(this._playingByBusName);
    }

    setOnPlayingChanged(callback) {
        this._onPlayingChanged = callback;
    }

    enable() {
        if (this._enabled)
            return;
        const connection = Gio.DBus.session;
        if (!connection) {
            this._logger.warn?.('milkdrop MPRIS: no session bus');
            return;
        }
        this._logger.warn?.('milkdrop MPRIS enable() called');
        this._enabled = true;
        this._connection = connection;

        // Subscribe to NameOwnerChanged before ListNames so we don't miss
        // any player that appears between the two calls.
        this._nameOwnerChangedId = connection.signal_subscribe(
            DBUS_NAME,
            DBUS_NAME,
            'NameOwnerChanged',
            DBUS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this)
        );

        this._listAndAddPlayers();
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        if (this._nameOwnerChangedId && this._connection) {
            try {
                this._connection.signal_unsubscribe(this._nameOwnerChangedId);
            } catch (_e) {}
            this._nameOwnerChangedId = 0;
        }
        this._pendingInit.clear();
        for (const proxy of this._playerProxies.values())
            this._disconnectPlayerProxy(proxy);
        this._playerProxies.clear();
        this._playingByBusName.clear();
        this._connection = null;
    }

    _listAndAddPlayers() {
        if (!this._connection || !this._enabled)
            return;

        try {
            this._connection.call(
                DBUS_NAME,
                DBUS_PATH,
                DBUS_NAME,
                'ListNames',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, result) => {
                    if (!this._enabled)
                        return;
                    try {
                        const reply = connection.call_finish(result);
                        const names = reply.recursiveUnpack?.()?.flat?.() ?? [];
                        const mprisNames = new Set(
                            names.filter(n => typeof n === 'string' && n.startsWith(MPRIS_PREFIX))
                        );

                        for (const busName of mprisNames) {
                            if (!this._playerProxies.has(busName) && !this._pendingInit.has(busName))
                                this._addPlayer(busName);
                        }
                        for (const busName of [...this._playerProxies.keys()]) {
                            if (!mprisNames.has(busName))
                                this._removePlayer(busName);
                        }

                        const count = this._playerProxies.size + this._pendingInit.size;
                        this._logger.warn?.(`milkdrop MPRIS enabled: ${count} player(s), hasActivePlayback=${this.hasActivePlayback}`);
                    } catch (e) {
                        this._logger.warn?.(`milkdrop MPRIS ListNames error: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._logger.warn?.(`milkdrop MPRIS ListNames call failed: ${e.message}`);
        }
    }

    _addPlayer(busName) {
        if (this._playerProxies.has(busName) || this._pendingInit.has(busName))
            return;
        this._pendingInit.add(busName);
        this._playingByBusName.set(busName, false);

        new MprisPlayerProxy(
            this._connection,
            busName,
            MPRIS_PATH,
            (proxy, error) => {
                this._pendingInit.delete(busName);
                if (!this._enabled) {
                    this._playingByBusName.delete(busName);
                    return;
                }
                if (error) {
                    this._playingByBusName.delete(busName);
                    this._logger.warn?.(`milkdrop MPRIS proxy error for ${busName.replace(MPRIS_PREFIX, '')}: ${error.message}`);
                    return;
                }
                if (this._playerProxies.has(busName))
                    return;

                const previous = this.hasActivePlayback;

                try {
                    const statusStr = proxy.PlaybackStatus ?? '';
                    const { playing } = parsePlaybackStatusFromUnpacked(statusStr);
                    this._playingByBusName.set(busName, playing);

                    proxy._propsChangedId = proxy.connect('g-properties-changed',
                        (_proxy, changed, _invalidated) => this._onPropertiesChanged(busName, changed));
                    proxy._nameOwnerNotifyId = proxy.connect('notify::g-name-owner',
                        () => {
                            if (!proxy.g_name_owner)
                                this._removePlayer(busName);
                        });

                    this._playerProxies.set(busName, proxy);
                } catch (e) {
                    this._playingByBusName.delete(busName);
                    this._logger.warn?.(`milkdrop MPRIS proxy setup failed for ${busName.replace(MPRIS_PREFIX, '')}: ${e.message}`);
                    return;
                }

                if (_debugMpris()) {
                    const short = busName.replace(MPRIS_PREFIX, '');
                    const statusStr = proxy.PlaybackStatus ?? '';
                    const playing = this._playingByBusName.get(busName) ?? false;
                    this._logger.warn?.(`milkdrop MPRIS proxy ready ${short}: PlaybackStatus=${statusStr || '(empty)'} playing=${playing}`);
                }

                if (previous !== this.hasActivePlayback) {
                    this._logger.warn?.(`milkdrop MPRIS hasActivePlayback ${previous} → ${this.hasActivePlayback} (player added)`);
                    this._onPlayingChanged?.();
                }
            },
            null,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START
        );
    }

    _removePlayer(busName) {
        const previous = this.hasActivePlayback;
        const proxy = this._playerProxies.get(busName);
        if (proxy)
            this._disconnectPlayerProxy(proxy);
        this._playerProxies.delete(busName);
        this._playingByBusName.delete(busName);

        if (_debugMpris())
            this._logger.warn?.(`milkdrop MPRIS removed ${busName.replace(MPRIS_PREFIX, '')}`);

        if (previous !== this.hasActivePlayback) {
            this._logger.warn?.(`milkdrop MPRIS hasActivePlayback ${previous} → ${this.hasActivePlayback} (player removed)`);
            this._onPlayingChanged?.();
        }
    }

    _disconnectPlayerProxy(proxy) {
        try {
            if (proxy._propsChangedId) {
                proxy.disconnect(proxy._propsChangedId);
                proxy._propsChangedId = 0;
            }
            if (proxy._nameOwnerNotifyId) {
                proxy.disconnect(proxy._nameOwnerNotifyId);
                proxy._nameOwnerNotifyId = 0;
            }
        } catch (_e) {}
    }

    _onNameOwnerChanged(_connection, _sender, _path, _interface, _signal, params) {
        if (!params || !params.n_children || params.n_children() < 1)
            return;
        const nameV = params.get_child_value(0);
        const name = nameV.unpack ? nameV.unpack() : (nameV.get_string?.()[1] ?? '');
        if (typeof name !== 'string' || !name.startsWith(MPRIS_PREFIX))
            return;

        let newOwner = '';
        try {
            const newOwnerV = params.get_child_value(2);
            newOwner = newOwnerV.unpack ? newOwnerV.unpack() : (newOwnerV.get_string?.()[1] ?? '');
        } catch (_e) {}

        if (newOwner)
            this._addPlayer(name);
        else
            this._removePlayer(name);
    }

    _onPropertiesChanged(busName, changed) {
        const changedJS = changed.recursiveUnpack?.() ?? {};
        if (!Object.prototype.hasOwnProperty.call(changedJS, PLAYBACK_STATUS))
            return;
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(changedJS[PLAYBACK_STATUS]);
        const previous = this.hasActivePlayback;
        this._playingByBusName.set(busName, playing);
        if (_debugMpris()) {
            const short = busName.replace(MPRIS_PREFIX, '');
            this._logger.warn?.(`milkdrop MPRIS PropertiesChanged ${short}: PlaybackStatus=${statusStr || '(empty)'} playing=${playing}`);
        }
        if (previous !== this.hasActivePlayback) {
            this._logger.warn?.(`milkdrop MPRIS hasActivePlayback ${previous} → ${this.hasActivePlayback} (PropertiesChanged)`);
            this._onPlayingChanged?.();
        }
    }
}
