import GLib from 'gi://GLib';
import {MilkdropRendererApplication, parseArgs} from '../../src/renderer/renderer.js';

export function run(assert) {
    // parseArgs ignores missing numeric values and preserves defaults.
    {
        const parsed = parseArgs(['--width', '--height', '--x']);
        assert(parsed.width === 1280, 'parseArgs keeps default width when --width value is missing');
        assert(parsed.height === 720, 'parseArgs keeps default height when --height value is missing');
        assert(parsed.x === 0, 'parseArgs keeps default x when --x value is missing');
    }

    // parseArgs ignores invalid numeric values and keeps valid ones.
    {
        const parsed = parseArgs(['--width', 'abc', '--height', '1080', '--monitor', '2']);
        assert(parsed.width === 1280, 'parseArgs ignores invalid width values');
        assert(parsed.height === 1080, 'parseArgs applies valid height values');
        assert(parsed.monitor === 2, 'parseArgs applies valid monitor values');
    }

    // parseArgs does not consume following flag as value.
    {
        const parsed = parseArgs(['--width', '--standalone']);
        assert(parsed.width === 1280, 'parseArgs does not parse flags as numeric values');
        assert(parsed.standalone === true, 'parseArgs still parses following standalone flag');
    }

    // _flushStatusLabel updates label only when needed.
    {
        let setCalls = 0;
        let lastText = null;
        const appState = {
            _statusLabel: {
                set_label(text) {
                    setCalls += 1;
                    lastText = text;
                },
            },
            _textOverlayVisible: true,
            _statusDirty: true,
            _lastStatusLabelText: '',
            _lastFrame: {
                frame: 12,
                zoom: 1.2345,
                rot: 0.1,
                audio: {
                    source: 'test',
                    active: true,
                    energy: 0.6,
                    bass: 0.2,
                    mid: 0.3,
                    high: 0.4,
                    beat: 1,
                },
            },
            _framesReceivedCount: 3,
            _currentPreset: {name: 'Preset A'},
            _lastFrameStat: {frame_count: 9},
            _bridgeStatusText: 'helper ready',
        };

        MilkdropRendererApplication.prototype._flushStatusLabel.call(appState, false);
        MilkdropRendererApplication.prototype._flushStatusLabel.call(appState, false);
        assert(setCalls === 1, '_flushStatusLabel avoids redundant label updates when state is unchanged');
        assert(typeof lastText === 'string' && lastText.includes('Preset A'), '_flushStatusLabel renders expected status text');
    }

    // _cleanupRuntime is idempotent and stops resources once.
    {
        let stopCalls = 0;
        const appState = {
            _closing: false,
            _statusRefreshTimeoutId: 101,
            _audioDebugTimeoutId: 202,
            _ipcClient: {
                stop() {
                    stopCalls += 1;
                },
            },
        };

        const originalSourceRemove = GLib.source_remove;
        let removed = [];
        GLib.source_remove = id => {
            removed.push(id);
            return true;
        };
        try {
            MilkdropRendererApplication.prototype._cleanupRuntime.call(appState);
            MilkdropRendererApplication.prototype._cleanupRuntime.call(appState);
        } finally {
            GLib.source_remove = originalSourceRemove;
        }

        assert(stopCalls === 1, '_cleanupRuntime stops IPC client exactly once');
        assert(removed.length === 2, '_cleanupRuntime removes active timeout sources exactly once');
        assert(appState._statusRefreshTimeoutId === 0, '_cleanupRuntime clears status refresh timeout id');
        assert(appState._audioDebugTimeoutId === 0, '_cleanupRuntime clears audio debug timeout id');
    }

    // _handleBridgeMessage forwards bridge backpressure telemetry to IPC.
    {
        const sentMessages = [];
        const appState = {
            _bridgeStatusText: '',
            _ipcClient: {
                send(message) {
                    sentMessages.push(message);
                },
            },
        };

        MilkdropRendererApplication.prototype._handleBridgeMessage.call(appState, {
            type: 'telemetry',
            stage: 'helper_write_backpressure',
            level: 'warn',
            ok: true,
            msg: 'dropping frame writes due to full queue',
        });

        assert(appState._bridgeStatusText.includes('helper_write_backpressure'),
            '_handleBridgeMessage updates bridge status text with backpressure stage');
        assert(sentMessages.length === 1, '_handleBridgeMessage forwards telemetry through IPC client');
        assert(sentMessages[0]?.stage === 'helper_write_backpressure',
            '_handleBridgeMessage preserves telemetry stage when forwarding');
    }
}
