/**
 * Tests for MPRIS watcher parsing and aggregation.
 * Validates the input formats observed from the real-time log (tools/check-mpris.js):
 * - Properties.Get reply recursiveUnpack: ["Playing"], ["Stopped"], ["Paused"]
 * - hasActivePlayback: true only when at least one player has PlaybackStatus "Playing".
 */

import {
    parsePlaybackStatusFromUnpacked,
    hasActivePlaybackFromMap,
    MprisWatcher,
} from '../../src/extension/mpris-watcher.js';

export function run(assert) {
    // --- parsePlaybackStatusFromUnpacked: observed D-Bus reply formats ---

    // Real log: raw=["Playing"] → playing=true
    {
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(['Playing']);
        assert(statusStr === 'Playing', 'unpacked ["Playing"] gives statusStr "Playing"');
        assert(playing === true, 'unpacked ["Playing"] gives playing true');
    }

    // Real log: raw=["Stopped"] → playing=false
    {
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(['Stopped']);
        assert(statusStr === 'Stopped', 'unpacked ["Stopped"] gives statusStr "Stopped"');
        assert(playing === false, 'unpacked ["Stopped"] gives playing false');
    }

    // Real log: raw=["Paused"] → playing=false
    {
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(['Paused']);
        assert(statusStr === 'Paused', 'unpacked ["Paused"] gives statusStr "Paused"');
        assert(playing === false, 'unpacked ["Paused"] gives playing false');
    }

    // String directly (some bindings may return string)
    {
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked('Playing');
        assert(statusStr === 'Playing', 'unpacked "Playing" gives statusStr "Playing"');
        assert(playing === true, 'unpacked "Playing" gives playing true');
    }

    // PropertiesChanged a{sv} value may be GVariant in GJS; parser must recursiveUnpack
    {
        const gvariantLike = { recursiveUnpack: () => 'Playing' };
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(gvariantLike);
        assert(statusStr === 'Playing', 'GVariant-like (recursiveUnpack → "Playing") gives playing');
        assert(playing === true, 'GVariant-like Playing gives playing true');
    }
    {
        const gvariantLike = { recursiveUnpack: () => ['Paused'] };
        const { statusStr, playing } = parsePlaybackStatusFromUnpacked(gvariantLike);
        assert(statusStr === 'Paused' && playing === false, 'GVariant-like (recursiveUnpack → ["Paused"]) gives not playing');
    }

    // Empty or invalid → not playing
    {
        const r1 = parsePlaybackStatusFromUnpacked([]);
        assert(r1.statusStr === '' && r1.playing === false, 'empty array gives not playing');
        const r2 = parsePlaybackStatusFromUnpacked(null);
        assert(r2.statusStr === '' && r2.playing === false, 'null gives not playing');
        const r3 = parsePlaybackStatusFromUnpacked(undefined);
        assert(r3.statusStr === '' && r3.playing === false, 'undefined gives not playing');
    }

    // --- hasActivePlaybackFromMap: aggregation ---

    // No players → false
    assert(hasActivePlaybackFromMap(new Map()) === false, 'empty map gives hasActivePlayback false');

    // One player Stopped → false
    assert(
        hasActivePlaybackFromMap(new Map([['org.mpris.MediaPlayer2.Shortwave', false]])) === false,
        'single player not playing gives false'
    );

    // One player Playing → true
    assert(
        hasActivePlaybackFromMap(new Map([['org.mpris.MediaPlayer2.Shortwave', true]])) === true,
        'single player playing gives true'
    );

    // Two players: one Playing, one Stopped → true (real log: chromium Playing, Shortwave Stopped)
    assert(
        hasActivePlaybackFromMap(new Map([
            ['org.mpris.MediaPlayer2.chromium.instance11578', true],
            ['org.mpris.MediaPlayer2.de.haeckerfelix.Shortwave', false],
        ])) === true,
        'one playing among two gives true'
    );

    // Two players: both Paused/Stopped → false
    assert(
        hasActivePlaybackFromMap(new Map([
            ['org.mpris.MediaPlayer2.chromium.instance11578', false],
            ['org.mpris.MediaPlayer2.de.haeckerfelix.Shortwave', false],
        ])) === false,
        'both not playing gives false'
    );

    // --- MprisWatcher: hasActivePlayback before enable (no D-Bus) ---
    {
        const watcher = new MprisWatcher({ logger: { warn: () => {}, debug: () => {} } });
        assert(watcher.hasActivePlayback === false, 'watcher before enable has hasActivePlayback false');
        watcher.disable();
    }
}
