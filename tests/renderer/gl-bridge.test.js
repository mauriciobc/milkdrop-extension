import GLib from 'gi://GLib';

import {GlBridge} from '../../src/renderer/gl-bridge.js';

function createBridgeWithMessages(options = {}) {
    const messages = [];
    const bridge = new GlBridge({
        ...options,
        logger: console,
        onMessage: message => messages.push(message),
    });
    return {bridge, messages};
}

export function run(assert) {
    // _armShmAcceptLoop does not arm when not running.
    {
        const {bridge} = createBridgeWithMessages();
        let acceptCalls = 0;
        bridge._running = false;
        bridge._cancellable = {};
        bridge._shmListener = {
            accept_async() {
                acceptCalls += 1;
            },
        };

        bridge._armShmAcceptLoop();
        assert(acceptCalls === 0, '_armShmAcceptLoop skips arming when bridge is not running');
    }

    // _armShmAcceptLoop rearms and emits telemetry when accepted connection cannot receive fd.
    {
        const {bridge, messages} = createBridgeWithMessages();
        let acceptCalls = 0;
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() {
                return {};
            },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_accept' &&
            message.level === 'warn'
        );
        assert(acceptCalls === 2, '_armShmAcceptLoop rearms listener after invalid shm connection');
        assert(warned, '_armShmAcceptLoop emits warning telemetry for invalid shm connection');
    }

    // _armShmAcceptLoop accepts tuple return from accept_finish (GJS introspection shape).
    {
        const {bridge} = createBridgeWithMessages();
        let acceptCalls = 0;
        const connection = {
            receive_fd() {
                return 17;
            },
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() {
                return [connection, null];
            },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();

        assert(bridge._shmFdQueue.length === 1, 'accept_finish tuple shape enqueues received fd');
        assert(bridge._shmFdQueue[0] === 17, 'accept_finish tuple keeps received fd value');
    }

    // frame-pixels-fd without queued fd emits telemetry warning.
    {
        const {bridge, messages} = createBridgeWithMessages();
        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels-fd',
            frame: 1,
            width: 2,
            height: 2,
            stride: 8,
            format: 'rgba8',
        }));

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_fd' &&
            message.level === 'warn'
        );
        assert(warned, 'frame-pixels-fd without pending fd emits shm_fd warning');
    }

    // Base64 frame fallback updates bridge frame cache.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const payload = new Uint8Array([10, 20, 30, 40]);
        const encoded = GLib.base64_encode(payload);

        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels',
            frame: 7,
            width: 1,
            height: 1,
            stride: 4,
            format: 'rgba8',
            data: encoded,
        }));

        const frameMessage = messages.find(message => message.type === 'frame-pixels');
        const fallbackTelemetry = messages.find(message =>
            message.type === 'telemetry' && message.stage === 'base64_fallback'
        );
        assert(Boolean(frameMessage), 'base64 frame emits frame-pixels message');
        assert(Boolean(fallbackTelemetry), 'base64 frame emits fallback telemetry');
        assert(bridge.lastFramePixels?.frame === 7, 'base64 frame updates lastFramePixels frame number');
        assert(bridge.lastFramePixels?.serial === 1, 'base64 frame increments lastFramePixels serial');
        assert(bridge.lastFramePixels?.bytes?.length === 4, 'base64 frame decode preserves byte length');
    }

    // Strict render path rejects base64 frame fallback payloads.
    {
        const {bridge, messages} = createBridgeWithMessages({strictRenderPath: true});
        const payload = new Uint8Array([10, 20, 30, 40]);
        const encoded = GLib.base64_encode(payload);

        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels',
            frame: 7,
            width: 1,
            height: 1,
            stride: 4,
            format: 'rgba8',
            data: encoded,
        }));

        const frameMessage = messages.find(message => message.type === 'frame-pixels');
        const rejectedTelemetry = messages.find(message =>
            message.type === 'telemetry' && message.stage === 'base64_disabled'
        );
        assert(!frameMessage, 'strict render path drops base64 frame payload');
        assert(Boolean(rejectedTelemetry), 'strict render path emits base64_disabled telemetry');
        assert(bridge.lastFramePixels === null, 'strict render path keeps frame cache empty for base64 payloads');
    }
}