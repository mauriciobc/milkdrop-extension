import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const encoder = new TextEncoder();

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
        this._cancellable = new Gio.Cancellable();
        this._socketClient = null;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._running = false;
        this._closing = false;
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
        this._socketClient = new Gio.SocketClient();
        this._socketClient.connect_async(
            Gio.UnixSocketAddress.new(this._socketPath),
            this._cancellable,
            (client, result) => {
                try {
                    this._connection = client.connect_finish(result);
                    if (!this._running || this._closing) {
                        this.stop();
                        return;
                    }

                    this._input = new Gio.DataInputStream({
                        base_stream: this._connection.get_input_stream(),
                    });
                    this._output = this._connection.get_output_stream();
                    if (_debugIpc())
                        this._logger.info?.(`milkdrop [renderer] IPC connected socket=${this._socketPath}`);
                    this.send({type: 'ready'});
                    this._readLoop();
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._logger.warn?.(`milkdrop [renderer] IPC connect failed: ${error.message}`);
                }
            }
        );
    }

    stop() {
        if (this._closing)
            return;

        this._closing = true;
        this._running = false;
        this._writeQueue = [];
        this._writePending = false;
        this._cancellable.cancel();
        const connection = this._connection;
        this._connection = null;
        this._input = null;
        this._output = null;
        if (connection) {
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
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.debug?.(`milkdrop renderer IPC write failed: ${error.message}`);
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
                    this.stop();
                    return;
                }

                this._handleLine(line);
                this._readLoop();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.debug?.(`milkdrop renderer IPC read failed: ${error.message}`);
                this.stop();
            }
        });
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
            this._onFrame?.(message);
            return;
        }

        if (message.type === 'preset-load') {
            this._onPresetLoad?.(message);
            return;
        }

        this._onMessage?.(message);
    }
}
