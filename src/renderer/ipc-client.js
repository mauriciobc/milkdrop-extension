import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const encoder = new TextEncoder();
const RECONNECT_DELAY_MS = 500;

function _debugIpc() {
    return GLib.getenv('MILKDROP_DEBUG_IPC') === '1';
}

export class IpcClient {
    constructor({socketPath, logger = console, onFrame = null, onPresetLoad = null, onMessage = null}) {
        this._socketPath = socketPath;
        this._logger = logger;
        this._onFrame = onFrame;
        this._onPresetLoad = onPresetLoad;
        this._onMessage = onMessage;
        this._cancellable = null;
        this._socketClient = null;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._running = false;
        this._closing = false;
        this._connectPending = false;
        this._reconnectSourceId = 0;
        this._writeQueue = [];
        this._writePending = false;
        this.currentFrame = null;
        this._firstLineReceived = false;
        this._frameReceiveCount = 0;
    }

    start() {
        if (!this._socketPath || this._running)
            return;

        this._running = true;
        this._closing = false;
        this._connectPending = false;
        this._writeQueue = [];
        this._writePending = false;
        this._firstLineReceived = false;
        this._frameReceiveCount = 0;
        this._cancellable = new Gio.Cancellable();
        this._socketClient = new Gio.SocketClient();
        this._connect();
    }

    _connect() {
        if (!this._running || this._closing || this._connectPending || !this._socketClient || !this._cancellable)
            return;

        this._connectPending = true;
        this._socketClient.connect_async(
            Gio.UnixSocketAddress.new(this._socketPath),
            this._cancellable,
            (client, result) => {
                this._connectPending = false;
                try {
                    this._connection = client.connect_finish(result);
                    if (!this._running || this._closing) {
                        this._closeConnection();
                        return;
                    }

                    this._input = new Gio.DataInputStream({
                        base_stream: this._connection.get_input_stream(),
                    });
                    this._output = this._connection.get_output_stream();
                    this._firstLineReceived = false;
                    if (_debugIpc())
                        this._logger.info?.(`milkdrop [renderer] IPC connected socket=${this._socketPath}`);
                    this.send({type: 'ready'});
                    this._readLoop();
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        this._logger.warn?.(`milkdrop [renderer] IPC connect failed: ${error.message}`);
                        this._scheduleReconnect();
                    }
                }
            }
        );
    }

    _scheduleReconnect() {
        if (!this._running || this._closing || this._reconnectSourceId)
            return;

        this._reconnectSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECONNECT_DELAY_MS, () => {
            this._reconnectSourceId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleDisconnect() {
        this._closeConnection();
        this._scheduleReconnect();
    }

    stop() {
        if (this._closing)
            return;

        this._closing = true;
        this._running = false;
        this._connectPending = false;
        this._writeQueue = [];
        this._writePending = false;
        if (this._reconnectSourceId) {
            GLib.source_remove(this._reconnectSourceId);
            this._reconnectSourceId = 0;
        }
        this._cancellable?.cancel();
        this._closeConnection();
        this._socketClient = null;
        this._cancellable = null;
        this._closing = false;
    }

    send(message) {
        if (!this._running || this._closing || !this._output)
            return;

        this._writeQueue.push(`${JSON.stringify(message)}\n`);
        this._flushWriteQueue();
    }

    _flushWriteQueue() {
        if (this._writePending || !this._writeQueue.length || !this._running || this._closing || !this._output)
            return;

        this._writePending = true;
        const payload = this._writeQueue.shift();
        const bytes = new GLib.Bytes(encoder.encode(payload));
        const capturedOutput = this._output;
        capturedOutput.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            if (this._output !== capturedOutput)
                return;
            this._writePending = false;
            try {
                if (!this._running || this._closing || !this._output)
                    return;
                stream.write_bytes_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._logger.debug?.(`milkdrop renderer IPC write failed: ${error.message}`);
                    this._handleDisconnect();
                    return;
                }
            }
            this._flushWriteQueue();
        });
    }

    _readLoop() {
        if (!this._running || this._closing || !this._input)
            return;

        this._input.read_line_async(GLib.PRIORITY_HIGH, this._cancellable, (stream, result) => {
            try {
                if (!this._running || this._closing || !this._input)
                    return;

                const [line, length] = stream.read_line_finish_utf8(result);
                if (line === null || length === 0) {
                    this._handleDisconnect();
                    return;
                }

                this._handleLine(line);
                this._readLoop();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._logger.debug?.(`milkdrop renderer IPC read failed: ${error.message}`);
                    this._handleDisconnect();
                    return;
                }
                this._closeConnection();
            }
        });
    }

    _closeConnection() {
        const connection = this._connection;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._writeQueue = [];
        this._writePending = false;
        if (!connection)
            return;
        try {
            connection.close_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
                try {
                    connection.close_finish(result);
                } catch (_error) {
                }
            });
        } catch (_error) {
        }
    }

    _handleLine(line) {
        if (!this._running || this._closing)
            return;

        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this._logger.warn?.(`milkdrop renderer IPC invalid JSON: ${error.message}`);
            return;
        }

        if (!this._firstLineReceived) {
            this._firstLineReceived = true;
            if (_debugIpc())
                this._logger.info?.(`milkdrop [renderer] first IPC line received type=${message?.type ?? '?'}`);
        }

        if (message.type === 'frame') {
            this._frameReceiveCount += 1;
            if (_debugIpc() && this._frameReceiveCount % 60 === 0)
                this._logger.info?.(`milkdrop [renderer] frame received count=${this._frameReceiveCount} hasAudio=${Boolean(message?.audio)} frame=${message?.frame ?? '?'}`);
            this.currentFrame = message;
            try {
                this._onFrame?.(message);
            } catch (error) {
                this._logger.warn?.(`milkdrop [renderer] frame callback failed: ${error.message}`);
            }
            return;
        }

        if (message.type === 'preset-load') {
            try {
                this._onPresetLoad?.(message);
            } catch (error) {
                this._logger.warn?.(`milkdrop [renderer] preset-load callback failed: ${error.message}`);
            }
            return;
        }

        try {
            this._onMessage?.(message);
        } catch (error) {
            this._logger.warn?.(`milkdrop [renderer] message callback failed type=${message?.type ?? 'unknown'}: ${error.message}`);
        }
    }
}
