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

function helperPathEndsWith(bridge, name) {
    return bridge._helperPath.endsWith(name);
}

export function run(assert) {
    // Helper path always points to milkdrop-gl-helper (unified binary).
    {
        const {bridge} = createBridgeWithMessages();
        assert(helperPathEndsWith(bridge, 'milkdrop-gl-helper'),
            'GlBridge helper path ends with milkdrop-gl-helper');
    }

    // submitFrame sends simplified message with time and PCM.
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
            pcmLeft: Array.from({length: 576}, (_, i) => Math.sin(i / 576 * Math.PI)),
            pcmRight: Array.from({length: 576}, (_, i) => Math.cos(i / 576 * Math.PI)),
            audio: {energy: 0.4, bass: 0.2, mid: 0.3, high: 0.1},
        });

        assert(sent.length === 1, 'submitFrame sends one message when bridge is running and ready');
        const frame = sent[0];
        assert(frame.type === 'frame', 'submitFrame sends frame message type');
        assert(Math.abs(frame.time - 12.5) < 1e-9, 'submitFrame forwards time');
        assert(Array.isArray(frame.pcmLeft) && frame.pcmLeft.length === 576,
            'submitFrame forwards pcmLeft with 576 samples');
        assert(Array.isArray(frame.pcmRight) && frame.pcmRight.length === 576,
            'submitFrame forwards pcmRight with 576 samples');
    }

    // submitFrame includes presetPath when frameState has it.
    {
        const {bridge} = createBridgeWithMessages();
        const sent = [];
        bridge._running = true;
        bridge._ready = true;
        bridge.send = msg => sent.push(msg);
        bridge.submitFrame({
            frame: 1,
            t: 0.5,
            presetPath: '/path/to/preset.milk',
            audio: {energy: 0, bass: 0, mid: 0, high: 0},
        });
        assert(sent.length === 1 && sent[0].presetPath === '/path/to/preset.milk',
            'submitFrame forwards presetPath');
    }

    // changePreset sends preset-change message.
    {
        const {bridge} = createBridgeWithMessages();
        const sent = [];
        bridge._running = true;
        bridge.send = msg => sent.push(msg);
        bridge.changePreset('/path/to/new.milk');
        assert(sent.length === 1, 'changePreset sends one message');
        assert(sent[0].type === 'preset-change' && sent[0].path === '/path/to/new.milk',
            'changePreset sends correct preset-change message');
    }

    // changePreset ignores null/undefined path.
    {
        const {bridge} = createBridgeWithMessages();
        const sent = [];
        bridge._running = true;
        bridge.send = msg => sent.push(msg);
        bridge.changePreset(null);
        bridge.changePreset(undefined);
        assert(sent.length === 0, 'changePreset ignores null/undefined path');
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

        assert(bridge._shmSlots.length === 1, 'accept_finish tuple shape enqueues received fd');
        assert(bridge._shmSlots[0].fd === 17, 'accept_finish tuple keeps received fd value');
    }

    // _armShmAcceptLoop uses GLib FD source when receive_fd_async is unavailable but get_socket() is present.
    {
        const {bridge} = createBridgeWithMessages();
        const fdSourceCalls = [];
        bridge._addFdSource = (priority, fd, condition, callback) => {
            fdSourceCalls.push({priority, fd, condition, callback});
            return 77;
        };

        const fakeSocketFd = 42;
        const connection = {
            receive_fd() { return 99; },
            get_socket() { return {get_fd: () => fakeSocketFd}; },
            close() {},
        };
        const listener = {
            accept_async(_cancellable, callback) { callback(listener, {}); },
            accept_finish() { return connection; },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();

        assert(fdSourceCalls.length === 1,
            '_armShmAcceptLoop arms GLib FD source when receive_fd_async is unavailable');
        assert(fdSourceCalls.length >= 1 && fdSourceCalls[0].fd === fakeSocketFd,
            '_armShmAcceptLoop FD source uses connection socket FD');
        assert(bridge._shmConnection === connection,
            '_armShmAcceptLoop keeps connection alive for sync receive loop');

        if (fdSourceCalls.length >= 1) {
            const result = fdSourceCalls[0].callback();
            assert(bridge._shmSlots.length === 1, 'sync receive loop enqueues FD on source fire');
            assert(bridge._shmSlots[0].fd === 99, 'sync receive loop enqueues FD value from receive_fd');
            assert(result === GLib.SOURCE_CONTINUE, 'sync receive loop GLib source continues after receiving FD');
        }
    }

    // _armShmAcceptLoop disables shm when sync connection has no accessible socket FD.
    {
        const {bridge, messages} = createBridgeWithMessages();
        let acceptCalls = 0;
        const connection = {
            receive_fd() { return 99; },
            close() {},
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() { return connection; },
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
        assert(acceptCalls === 1, 'no-socket-fd connection is rejected without rearming receive loop');
        assert(bridge._shmListener === null, 'no-socket-fd connection disables shm listener');
        assert(bridge._shmSlots.length === 0, 'no-socket-fd connection does not enqueue fds');
        assert(warned, 'no-socket-fd connection emits warning telemetry');
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
            receive_fd_finish(result) { return result.fd; },
            close() {},
        };
        const listener = {
            accept_async(_cancellable, callback) {
                acceptCalls += 1;
                if (acceptCalls === 1)
                    callback(listener, {});
            },
            accept_finish() { return connection; },
        };

        bridge._running = true;
        bridge._cancellable = {};
        bridge._shmListener = listener;
        bridge._armShmAcceptLoop();
        pendingReceiveCallback(connection, {fd: 21});
        pendingReceiveCallback(connection, {fd: 22});

        assert(acceptCalls === 1, 'persistent shm connection does not re-accept per fd');
        assert(bridge._shmSlots.length === 2, 'persistent shm connection queues multiple received fds');
        assert(bridge._shmSlots[0].fd === 21 && bridge._shmSlots[1].fd === 22,
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
            close() {},
        };
        const secondConnection = {
            receive_fd_async(_cancellable, _callback) {},
            receive_fd_finish(result) { return result.fd; },
            close() {},
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
        bridge._enqueueShmFd(44);
        bridge._drainShmFrameQueue();

        const frameMessage = messages.find(message => message.type === 'frame-pixels');
        assert(Boolean(frameMessage), 'frame-pixels-fd emits frame once fd arrives');
        assert(frameMessage?.frame === 1, 'frame-pixels-fd keeps metadata while waiting for fd');
        assert(frameMessage?.bytes === fakeBytes, 'frame-pixels-fd forwards GLib.Bytes without copying');
    }

    // fd arriving before metadata is preserved and paired later.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const fakeBytes = GLib.Bytes.new(new Uint8Array([7, 8, 9, 10]));
        bridge._readFrameBytesAsync = (_fd, _pixelCount, callback) => callback(null, fakeBytes);

        bridge._enqueueShmFd(55);
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

        bridge._enqueueShmFd(70);
        bridge._enqueueShmFd(71);
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

    // incomplete shm read schedules delayed retry instead of immediate tight loop.
    {
        const {bridge, messages} = createBridgeWithMessages();
        const scheduledDelays = [];
        bridge._scheduleShmQueueDrain = delay => scheduledDelays.push(delay);
        bridge._readFrameBytesAsync = (_fd, _pixelCount, callback) => {
            callback(new Error('incomplete frame bytes read expected=16 got=0'), null);
        };
        bridge._shmSlots.push({
            meta: {frame: 1, width: 2, height: 2, stride: 8, format: 'rgba8'},
            fd: 33,
        });

        bridge._drainShmFrameQueue();

        const warned = messages.some(message =>
            message.type === 'telemetry' &&
            message.stage === 'shm_read' &&
            message.level === 'warn'
        );
        assert(bridge._shmReadFailureStreak === 1, 'incomplete shm read increments failure streak');
        assert(scheduledDelays.length === 1 && scheduledDelays[0] > 0,
            'incomplete shm read schedules delayed retry');
        assert(warned, 'incomplete shm read emits warning telemetry');
    }

    // publishing frame pixels triggers bounded forced GC hook.
    {
        const {bridge} = createBridgeWithMessages();
        let gcCalls = 0;
        bridge._maybeForceGc = () => {
            gcCalls += 1;
        };

        bridge._publishFramePixels({
            frame: 3,
            width: 1,
            height: 1,
            stride: 4,
            format: 'rgba8',
        }, GLib.Bytes.new(new Uint8Array([1, 2, 3, 4])));

        assert(gcCalls === 1, '_publishFramePixels invokes forced GC hook');
    }

    // Deprecated base64 frame payloads are dropped (strict-only renderer).
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
        const telemetry = messages.find(message =>
            message.type === 'telemetry' && message.stage === 'unexpected_base64_frame'
        );
        assert(!frameMessage, 'base64 payload does not emit frame-pixels message');
        assert(Boolean(telemetry), 'base64 payload emits unexpected_base64_frame telemetry');
        assert(bridge.lastFramePixels === null, 'base64 payload does not update lastFramePixels');
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

    // PerfCollector resets on start() so stats don't bleed across helper restarts.
    {
        const {bridge} = createBridgeWithMessages();

        // Record some frames to populate the collector.
        bridge._perfCollector.record({render_us: 1000, readback_us: 200, frame_count: 10, time: 1.0});
        bridge._perfCollector.record({render_us: 2000, readback_us: 400, frame_count: 11, time: 1.016});
        const statsBefore = bridge._perfCollector.getStats();
        assert(statsBefore !== null, 'PerfCollector has stats after recording frames');
        assert(statsBefore.frames === 11, 'PerfCollector stats reflect last frame_count before restart');

        // Simulate restart: start() should reset the collector before re-launch.
        // Skip actual process spawn by patching the bridge to be "not available".
        const origAvailable = Object.getOwnPropertyDescriptor(GlBridge.prototype, 'available');
        Object.defineProperty(bridge, 'available', {get: () => false, configurable: true});
        bridge.start({width: 800, height: 600});

        const statsAfter = bridge._perfCollector.getStats();
        assert(statsAfter === null, 'PerfCollector is cleared by start() so restarts begin with fresh stats');

        if (origAvailable)
            Object.defineProperty(bridge, 'available', origAvailable);
    }
}
