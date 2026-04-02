import {IpcClient} from '../../src/renderer/ipc-client.js';

export function run(assert) {
    // _handleLine dispatches frame/preset/generic messages to proper callbacks.
    {
        let frameMessage = null;
        let presetMessage = null;
        let genericMessage = null;
        const client = new IpcClient({
            socketPath: '/tmp/milkdrop-test.sock',
            onFrame: message => {
                frameMessage = message;
            },
            onPresetLoad: message => {
                presetMessage = message;
            },
            onMessage: message => {
                genericMessage = message;
            },
        });
        client._running = true;

        client._handleLine('{"type":"frame","frame":7,"audio":{"active":true}}');
        client._handleLine('{"type":"preset-load","preset":{"name":"A"}}');
        client._handleLine('{"type":"telemetry","ok":true}');

        assert(frameMessage?.type === 'frame', 'ipc-client dispatches frame messages to onFrame');
        assert(client.currentFrame?.frame === 7, 'ipc-client stores currentFrame after frame dispatch');
        assert(presetMessage?.type === 'preset-load', 'ipc-client dispatches preset-load messages to onPresetLoad');
        assert(genericMessage?.type === 'telemetry', 'ipc-client dispatches generic messages to onMessage');
    }

    // _handleLine ignores invalid JSON without throwing and logs warning.
    {
        let warnCount = 0;
        let callbackCount = 0;
        const client = new IpcClient({
            socketPath: '/tmp/milkdrop-test.sock',
            logger: {
                warn() {
                    warnCount += 1;
                },
            },
            onMessage: () => {
                callbackCount += 1;
            },
        });
        client._running = true;

        client._handleLine('{invalid-json');
        assert(warnCount === 1, 'ipc-client warns once on invalid JSON line');
        assert(callbackCount === 0, 'ipc-client does not dispatch callbacks for invalid JSON');
    }

    // _readLoop resets the heartbeat timer on each successfully received line.
    // Without this, a stalled IPC connection (no data from extension) goes undetected forever.
    {
        let heartbeatResets = 0;
        const client = new IpcClient({socketPath: '/tmp/milkdrop-test.sock'});
        client._running = true;
        client._cancellable = {};
        client._resetHeartbeat = () => { heartbeatResets += 1; };

        let capturedCallback = null;
        const mockInput = {
            read_line_async(_priority, _cancellable, callback) { capturedCallback = callback; },
            read_line_finish_utf8(_result) { return ['{"type":"telemetry"}', 17]; },
        };
        client._input = mockInput;
        client._readLoop();
        capturedCallback(mockInput, {});

        assert(heartbeatResets >= 1, 'ipc-client _readLoop resets heartbeat timer on each received line');
    }

    // _readLoop does not register a duplicate loop when a stale callback fires after _input is replaced.
    {
        const readCallTargets = [];
        let oldCallback = null;

        const inputA = {
            read_line_async(_priority, _cancellable, callback) {
                readCallTargets.push('A');
                oldCallback = callback;
            },
            read_line_finish_utf8(_result) {
                return ['{"type":"telemetry"}', 17];
            },
        };
        const inputB = {
            read_line_async(_priority, _cancellable, _callback) {
                readCallTargets.push('B');
            },
        };

        const client = new IpcClient({socketPath: '/tmp/milkdrop-test.sock'});
        client._running = true;
        client._cancellable = {};

        // Step 1: start loop on inputA
        client._input = inputA;
        client._readLoop();
        assert(readCallTargets.join('') === 'A', 'ipc-client _readLoop registers read on initial input');

        // Step 2: simulate reconnect — replace _input with inputB and start new loop
        client._input = inputB;
        client._readLoop();
        assert(readCallTargets.join('') === 'AB', 'ipc-client _readLoop registers read on new input after reconnect');

        // Step 3: stale callback from inputA fires — must NOT register another read on inputB
        oldCallback(inputA, {});
        assert(readCallTargets.join('') === 'AB',
            'ipc-client stale _readLoop callback does not register duplicate read after _input is replaced');
    }

    // stop() is idempotent and closes connection asynchronously once.
    {
        let closeAsyncCalls = 0;
        let closeFinishCalls = 0;
        const client = new IpcClient({socketPath: '/tmp/milkdrop-test.sock'});
        client._running = true;
        client._writeQueue = ['one'];
        client._writePending = true;
        client._connection = {
            close_async(_priority, _cancellable, callback) {
                closeAsyncCalls += 1;
                callback(this, {});
            },
            close_finish(_result) {
                closeFinishCalls += 1;
            },
        };
        client._input = {};
        client._output = {};

        client.stop();
        client.stop();

        assert(closeAsyncCalls === 1, 'ipc-client stop schedules async close exactly once');
        assert(closeFinishCalls === 1, 'ipc-client stop finishes async close exactly once');
        assert(client._running === false, 'ipc-client stop marks client as not running');
        assert(client._connection === null, 'ipc-client stop clears connection reference');
        assert(client._input === null, 'ipc-client stop clears input reference');
        assert(client._output === null, 'ipc-client stop clears output reference');
        assert(client._writeQueue.length === 0, 'ipc-client stop clears pending write queue');
        assert(client._writePending === false, 'ipc-client stop clears write pending flag');
    }
}
