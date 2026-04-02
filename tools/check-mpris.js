#!/usr/bin/gjs
/**
 * MPRIS real-time log. Run from repo root:
 *   gjs tools/check-mpris.js
 *
 * Keeps running and logs MPRIS state to the terminal every second,
 * plus D-Bus signal events when players appear/disappear or
 * PlaybackStatus changes. Ctrl+C to exit.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const PLAYBACK_STATUS = 'PlaybackStatus';
const POLL_INTERVAL_SEC = 1;

function now() {
    const d = new Date();
    return d.toISOString().slice(11, 23) + ' ';
}

function log(msg) {
    print(now() + msg);
}

function listMprisNames(connection) {
    try {
        const reply = connection.call_sync(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_NAME,
            'ListNames',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
        const raw = reply && reply.recursiveUnpack && reply.recursiveUnpack();
        const arr = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
        if (!Array.isArray(arr))
            return [];
        return arr.filter(function(name) { return typeof name === 'string' && name.indexOf(MPRIS_PREFIX) === 0; });
    } catch (e) {
        log('ListNames ERROR: ' + e.message);
        return [];
    }
}

function getPlaybackStatus(connection, busName) {
    try {
        const params = new GLib.Variant('(ss)', [PLAYER_IFACE, PLAYBACK_STATUS]);
        const reply = connection.call_sync(
            busName,
            MPRIS_PATH,
            PROPERTIES_IFACE,
            'Get',
            params,
            null,
            Gio.DBusCallFlags.NONE,
            500,
            null
        );
        if (!reply)
            return { status: null, raw: null, error: 'empty reply' };
        const unpacked = reply.recursiveUnpack && reply.recursiveUnpack();
        const raw = Array.isArray(unpacked) ? unpacked[0] : unpacked;
        const status = typeof raw === 'string' ? raw : (Array.isArray(raw) && raw.length > 0 ? String(raw[0]) : null);
        return { status: status, raw: unpacked, error: null };
    } catch (e) {
        return { status: null, raw: null, error: e.message };
    }
}

function pollAndLog(connection) {
    log('--- poll ---');
    const names = listMprisNames(connection);
    log('MPRIS bus names: ' + names.length);

    if (names.length === 0) {
        log('  (none)');
        log('hasActivePlayback: false');
        return;
    }

    let anyPlaying = false;
    for (let i = 0; i < names.length; i++) {
        const busName = names[i];
        const shortName = busName.slice(MPRIS_PREFIX.length);
        const result = getPlaybackStatus(connection, busName);
        const status = result.status;
        const raw = result.raw;
        const error = result.error;
        if (error) {
            log('  ' + shortName + ': ERROR ' + error);
            continue;
        }
        const playing = status === 'Playing';
        if (playing)
            anyPlaying = true;
        log('  ' + shortName + '  PlaybackStatus="' + (status || '') + '"  playing=' + playing);
        if (raw !== undefined && raw !== status && raw !== null)
            log('    raw=' + JSON.stringify(raw));
    }
    log('hasActivePlayback: ' + anyPlaying);
}

function subscribeSignals(connection) {
    try {
        connection.signal_subscribe(
            DBUS_NAME,
            DBUS_NAME,
            'NameOwnerChanged',
            DBUS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            function(_conn, _sender, _path, _iface, _signal, params) {
                if (!params || !params.n_children || params.n_children() < 1) return;
                const nameV = params.get_child_value(0);
                const name = nameV.unpack ? nameV.unpack() : (nameV.get_string ? nameV.get_string()[1] : '');
                if (typeof name !== 'string' || name.indexOf(MPRIS_PREFIX) !== 0) return;
                const oldV = params.n_children() > 1 ? params.get_child_value(1) : null;
                const newV = params.n_children() > 2 ? params.get_child_value(2) : null;
                const oldOwner = oldV && oldV.unpack ? oldV.unpack() : '';
                const newOwner = newV && newV.unpack ? newV.unpack() : '';
                const shortName = name.slice(MPRIS_PREFIX.length);
                if (newOwner && !oldOwner)
                    log('[signal] NameOwnerChanged  ' + shortName + '  APPEARED');
                else if (!newOwner && oldOwner)
                    log('[signal] NameOwnerChanged  ' + shortName + '  DISAPPEARED');
                else
                    log('[signal] NameOwnerChanged  ' + shortName + '  owner changed');
            }
        );
        log('Subscribed to NameOwnerChanged (bus)');
    } catch (e) {
        log('NameOwnerChanged subscribe ERROR: ' + e.message);
    }
}

function subscribePropertiesChanged(connection, busName) {
    const shortName = busName.slice(MPRIS_PREFIX.length);
    try {
        connection.signal_subscribe(
            busName,
            PROPERTIES_IFACE,
            'PropertiesChanged',
            MPRIS_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            function(_conn, _sender, _path, _iface, _signal, params) {
                if (!params || params.n_children() < 2) return;
                const changedV = params.get_child_value(1);
                const changed = changedV.recursiveUnpack ? changedV.recursiveUnpack() : {};
                if (changed && changed[PLAYBACK_STATUS] !== undefined) {
                    const v = changed[PLAYBACK_STATUS];
                    const status = typeof v === 'string' ? v : (Array.isArray(v) && v[0] !== undefined ? String(v[0]) : '');
                    log('[signal] PropertiesChanged  ' + shortName + '  PlaybackStatus="' + status + '"');
                }
            }
        );
    } catch (e) {
        log('PropertiesChanged subscribe ' + shortName + ' ERROR: ' + e.message);
    }
}

function main() {
    log('MPRIS real-time log (session bus, poll every ' + POLL_INTERVAL_SEC + 's, Ctrl+C to exit)\n');

    var connection;
    try {
        connection = Gio.DBus.session;
    } catch (e) {
        log('ERROR: No session bus: ' + e.message);
        return;
    }

    subscribeSignals(connection);

    const subscribedPlayers = {};
    function ensureSubscribed(connection, busName) {
        if (subscribedPlayers[busName]) return;
        subscribedPlayers[busName] = true;
        subscribePropertiesChanged(connection, busName);
    }

    function poll() {
        pollAndLog(connection);
        const names = listMprisNames(connection);
        for (let i = 0; i < names.length; i++)
            ensureSubscribed(connection, names[i]);
        return true;
    }

    poll();
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SEC, poll);

    const loop = GLib.MainLoop.new(null, false);
    loop.run();
}

main();
