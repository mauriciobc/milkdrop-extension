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
    // submitFrame forwards expanded renderer contract fields.
    {
        const {bridge} = createBridgeWithMessages();
        const sent = [];
        bridge._running = true;
        bridge._ready = true;
        bridge.send = message => {
            sent.push(message);
            return true;
        };

        bridge.submitFrame({
            frame: 99,
            t: 12.5,
            zoom: 1.02,
            rot: 0.01,
            dx: 0.02,
            dy: -0.03,
            decay: 0.95,
            cx: 0.33,
            cy: 0.77,
            sx: 1.2,
            sy: 0.8,
            zoomexp: 1.5,
            warp: 0.42,
            wrap: 0,
            echo_zoom: 1.1,
            echo_alpha: 0.25,
            echo_orient: 2,
            gamma: 1.3,
            brighten: 1,
            darken: 0,
            solarize: 1,
            invert: 0,
            darken_center: 1,
            ob_size: 0.02,
            ob_r: 0.1,
            ob_g: 0.2,
            ob_b: 0.3,
            ob_a: 0.4,
            ib_size: 0.03,
            ib_r: 0.5,
            ib_g: 0.6,
            ib_b: 0.7,
            ib_a: 0.8,
            mv_x: 14,
            mv_y: 10,
            mv_dx: 0.01,
            mv_dy: -0.02,
            mv_l: 0.9,
            mv_r: 1.0,
            mv_g: 0.9,
            mv_b: 0.8,
            mv_a: 0.7,
            wave_mode: 3,
            wave_a: 0.6,
            wave_scale: 1.7,
            wave_smoothing: 0.9,
            wave_x: 0.45,
            wave_y: 0.55,
            wave_dots: 1,
            wave_thick: 1,
            additivewave: 1,
            wave_data: Array.from({length: 576}, (_, i) => Math.sin(i / 576 * Math.PI)),
            audio: {energy: 0.4, bass: 0.2, mid: 0.3, high: 0.1},
        });

        assert(sent.length === 1, 'submitFrame sends one message when bridge is running and ready');
        const frame = sent[0];
        assert(frame.type === 'frame' && frame.frame === 99, 'submitFrame sends frame message type and frame number');
        assert(Math.abs(frame.cx - 0.33) < 1e-9 && Math.abs(frame.cy - 0.77) < 1e-9,
            'submitFrame forwards cx/cy fields');
        assert(Math.abs(frame.sx - 1.2) < 1e-9 && Math.abs(frame.sy - 0.8) < 1e-9,
            'submitFrame forwards sx/sy fields');
        assert(Math.abs(frame.zoomexp - 1.5) < 1e-9 && Math.abs(frame.warp - 0.42) < 1e-9,
            'submitFrame forwards zoomexp/warp fields');
        assert(frame.wrap === 0, 'submitFrame forwards wrap field');
        assert(Math.abs(frame.echo_zoom - 1.1) < 1e-9 && Math.abs(frame.echo_alpha - 0.25) < 1e-9,
            'submitFrame forwards echo fields');
        assert(frame.echo_orient === 2, 'submitFrame forwards echo orientation');
        assert(Math.abs(frame.ob_size - 0.02) < 1e-9 && Math.abs(frame.ib_size - 0.03) < 1e-9,
            'submitFrame forwards border size fields');
        assert(frame.mv_x === 14 && frame.mv_y === 10, 'submitFrame forwards motion vector grid fields');
        assert(Math.abs(frame.mv_dx - 0.01) < 1e-9 && Math.abs(frame.mv_dy + 0.02) < 1e-9,
            'submitFrame forwards motion vector displacement fields');
        assert(Math.abs(frame.wave_a - 0.6) < 1e-9 && frame.wave_mode === 3,
            'submitFrame forwards waveform control fields');
        assert(frame.wave_dots === 1 && frame.wave_thick === 1 && frame.additivewave === 1,
            'submitFrame forwards waveform draw flags');
        assert(Array.isArray(frame.wave_data) && frame.wave_data.length === 576,
            'submitFrame forwards waveform sample payload');
        assert(Math.abs(frame.wave_data[2] - Math.sin(2 / 576 * Math.PI)) < 1e-9,
            'submitFrame preserves waveform sample values');
    }

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

    // _armShmAcceptLoop disables shm transport when async fd receive is unavailable.
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
        bridge._shmSocketPath = '/tmp/fake-shm.sock';
        bridge._armShmAcceptLoop();

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_accept' &&
            message.level === 'warn'
        );
        assert(acceptCalls === 1, '_armShmAcceptLoop accepts once when shm async receive is unavailable');
        assert(bridge._shmListener === null, '_armShmAcceptLoop disables shm listener when async receive is unavailable');
        assert(warned, '_armShmAcceptLoop emits warning telemetry when async receive is unavailable');
    }

    // _armShmAcceptLoop accepts tuple return from accept_finish (GJS introspection shape).
    {
        const {bridge} = createBridgeWithMessages();
        let acceptCalls = 0;
        let pendingReceiveCallback = null;
        const connection = {
            receive_fd_async(_cancellable, callback) {
                pendingReceiveCallback = callback;
            },
            receive_fd_finish(result) {
                return result.fd;
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
        pendingReceiveCallback(connection, {fd: 17});

        assert(bridge._shmFdQueue.length === 1, 'accept_finish tuple shape enqueues received fd');
        assert(bridge._shmFdQueue[0] === 17, 'accept_finish tuple keeps received fd value');
    }

    // _armShmAcceptLoop does not use synchronous receive_fd fallback path.
    {
        const {bridge, messages} = createBridgeWithMessages();
        let acceptCalls = 0;
        const connection = {
            receive_fd() {
                return 99;
            },
            close() {
            },
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() {
                return connection;
            },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._shmSocketPath = '/tmp/fake-shm.sock';
        bridge._armShmAcceptLoop();

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_accept' &&
            message.level === 'warn'
        );
        assert(acceptCalls === 1, 'sync-only connection is rejected without rearming receive loop');
        assert(bridge._shmListener === null, 'sync-only connection disables shm listener');
        assert(bridge._shmFdQueue.length === 0, 'sync-only connection does not enqueue fds');
        assert(warned, 'sync-only connection emits warning telemetry');
    }

    // _armShmAcceptLoop keeps a persistent connection and receives multiple fds without re-accept.
    {
        const {bridge} = createBridgeWithMessages();
        let acceptCalls = 0;
        let pendingReceiveCallback = null;
        const connection = {
            receive_fd_async(_cancellable, callback) {
                pendingReceiveCallback = callback;
            },
            receive_fd_finish(result) {
                return result.fd;
            },
            close() {
            },
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() {
                return connection;
            },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();

        pendingReceiveCallback(connection, {fd: 21});
        pendingReceiveCallback(connection, {fd: 22});

        assert(acceptCalls === 1, 'persistent shm connection does not re-accept per fd');
        assert(bridge._shmFdQueue.length === 2, 'persistent shm connection queues multiple received fds');
        assert(bridge._shmFdQueue[0] === 21 && bridge._shmFdQueue[1] === 22,
            'persistent shm connection preserves fd ordering');
    }

    // _armShmAcceptLoop re-accepts after receive_fd_async failure.
    {
        const {bridge, messages} = createBridgeWithMessages();
        let acceptCalls = 0;
        let firstPendingCallback = null;
        const firstConnection = {
            receive_fd_async(_cancellable, callback) {
                firstPendingCallback = callback;
            },
            receive_fd_finish(_result) {
                throw new Error('receive failed');
            },
            close() {
            },
        };
        const secondConnection = {
            receive_fd_async(_cancellable, _callback) {
            },
            receive_fd_finish(result) {
                return result.fd;
            },
            close() {
            },
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                callback(listener, {acceptCall: acceptCalls});
            },
            accept_finish(result) {
                return result.acceptCall === 1 ? firstConnection : secondConnection;
            },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();

        firstPendingCallback(firstConnection, {});

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_receive_fd' &&
            message.level === 'warn'
        );
        assert(acceptCalls === 2, 'receive_fd_async failure triggers shm re-accept');
        assert(warned, 'receive_fd_async failure emits shm_receive_fd warning telemetry');
    }

    // frame-pixels-fd waits for fd instead of dropping immediately.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const fakeBytes = GLib.Bytes.new(new Uint8Array([1, 2, 3, 4]));
        bridge._readFrameBytesAsync = (_fd, _pixelCount, callback) => callback(null, fakeBytes);

        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels-fd',
            frame: 1,
            width: 2,
            height: 2,
            stride: 8,
            format: 'rgba8',
        }));
        bridge._shmFdQueue.push(44);
        bridge._drainShmFrameQueue();

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_fd' &&
            message.level === 'warn'
        );
        const frameMessage = messages.find(message => message.type === 'frame-pixels');
        assert(!warned, 'frame-pixels-fd no longer warns when fd has not arrived yet');
        assert(Boolean(frameMessage), 'frame-pixels-fd emits frame once fd arrives');
        assert(frameMessage?.frame === 1, 'frame-pixels-fd keeps metadata while waiting for fd');
        assert(frameMessage?.bytes === fakeBytes, 'frame-pixels-fd forwards GLib.Bytes without copying');
    }

    // fd arriving before metadata is preserved and paired later.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const fakeBytes = GLib.Bytes.new(new Uint8Array([7, 8, 9, 10]));
        bridge._readFrameBytesAsync = (_fd, _pixelCount, callback) => callback(null, fakeBytes);

        bridge._shmFdQueue.push(55);
        bridge._drainShmFrameQueue();
        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels-fd',
            frame: 2,
            width: 2,
            height: 2,
            stride: 8,
            format: 'rgba8',
        }));

        const frameMessage = messages.find(message => message.type === 'frame-pixels');
        assert(Boolean(frameMessage), 'queued fd is consumed when metadata arrives');
        assert(frameMessage?.frame === 2, 'queued fd pairs with later metadata in FIFO order');
    }

    // queued metadata and fds are read in FIFO order without parallel shm reads.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const readCalls = [];
        bridge._readFrameBytesAsync = (fd, _pixelCount, callback) => {
            readCalls.push({fd, callback});
        };

        bridge._shmFdQueue.push(70);
        bridge._shmFdQueue.push(71);
        bridge._drainShmFrameQueue();
        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels-fd',
            frame: 101,
            width: 2,
            height: 2,
            stride: 8,
            format: 'rgba8',
        }));
        bridge._handleLine(JSON.stringify({
            type: 'frame-pixels-fd',
            frame: 102,
            width: 2,
            height: 2,
            stride: 8,
            format: 'rgba8',
        }));

        assert(readCalls.length === 1, 'shm reads are processed one at a time');
        assert(readCalls[0].fd === 70, 'first queued fd is read first');

        const firstBytes = GLib.Bytes.new(new Uint8Array([1, 1, 1, 1]));
        const secondBytes = GLib.Bytes.new(new Uint8Array([2, 2, 2, 2]));
        readCalls[0].callback(null, firstBytes);
        assert(readCalls.length === 2, 'next shm read starts after previous finishes');
        assert(readCalls[1].fd === 71, 'second queued fd is read second');
        readCalls[1].callback(null, secondBytes);

        const frameMessages = messages.filter(message => message.type === 'frame-pixels');
        assert(frameMessages.length === 2, 'two paired shm frames emit two frame-pixels messages');
        assert(frameMessages[0]?.frame === 101 && frameMessages[1]?.frame === 102,
            'paired frames preserve FIFO metadata order');
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
        assert(typeof bridge.lastFramePixels?.bytes?.get_size === 'function',
            'base64 frame stores bytes as GLib.Bytes');
        assert(bridge.lastFramePixels?.bytes?.get_size() === 4, 'base64 frame decode preserves byte length');
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

    // send applies backpressure by dropping frame payloads when queue is full.
    {
        const {bridge, messages} = createBridgeWithMessages();
        bridge._running = true;
        bridge._stdin = {};
        bridge._flushWriteQueue = () => {};
        const originalLimit = GlBridge.MAX_WRITE_QUEUE_LENGTH;
        GlBridge.MAX_WRITE_QUEUE_LENGTH = 2;

        let accepted = false;
        try {
            bridge.send({type: 'frame', frame: 1});
            bridge.send({type: 'frame', frame: 2});
            accepted = bridge.send({type: 'frame', frame: 3});
        } finally {
            GlBridge.MAX_WRITE_QUEUE_LENGTH = originalLimit;
        }

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'helper_write_backpressure' &&
            message.level === 'warn'
        );
        assert(accepted === false, 'send drops frame payloads when queue is full');
        assert(bridge._writeQueue.length === 2, 'send keeps queue bounded at configured limit');
        assert(warned, 'send emits backpressure warning telemetry when dropping frames');
    }
}