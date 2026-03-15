import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const encoder = new TextEncoder();

export function buildSocketPath(monitorIndex) {
    return GLib.build_filenamev([
        GLib.get_user_runtime_dir(),
        `gnome-milkdrop-${monitorIndex}.sock`,
    ]);
}

function _debugIpc() {
    return GLib.getenv('MILKDROP_DEBUG_IPC') === '1';
}

export class IpcServer {
    constructor({monitorIndex, logger, onMessage = null}) {
        this._monitorIndex = monitorIndex;
        this._logger = logger;
        this._onMessage = onMessage;
        this._cancellable = null;
        this._service = null;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._ready = false;
        this._enabled = false;
        this._closing = false;
        this._writeQueue = [];
        this._writePending = false;
        this._pendingFrame = null;
        this.socketPath = buildSocketPath(monitorIndex);
        this._serviceSignalId = 0;
        this._frameWriteCount = 0;
        this._sendDropLogged = false;
    }

    static MAX_QUEUE_LENGTH = 5;

    get ready() {
        return this._ready;
    }

    enable() {
        if (this._enabled)
            this.disable();

        this._enabled = true;
        this._closing = false;
        this._cancellable = new Gio.Cancellable();
        this._unlinkSocket();

        this._service = new Gio.SocketService();
        this._serviceSignalId = this._service.connect('incoming', (_service, connection) => {
            if (!this._enabled || this._closing) {
                try {
                    connection.close(null);
                } catch (_error) {
                }
                return false;
            }

            this._acceptConnection(connection);
            return true;
        });

        try {
            this._service.add_address(
                Gio.UnixSocketAddress.new(this.socketPath),
                Gio.SocketType.STREAM,
                Gio.SocketProtocol.DEFAULT,
                null
            );
            this._service.start();
        } catch (error) {
            this._logger.warn?.(`milkdrop ipc socket bind failed for monitor ${this._monitorIndex}: ${error.message}`);
            this.disable();
        }
    }

    disable() {
        if (!this._enabled && !this._service)
            return;

        this._closing = true;
        this._enabled = false;
        this._ready = false;

        if (this._cancellable) {
            try {
                this._cancellable.cancel();
            } catch (_e) {}
            this._cancellable = null;
        }

        if (this._service && this._serviceSignalId) {
            try {
                this._service.disconnect(this._serviceSignalId);
            } catch (_e) {}
            this._serviceSignalId = 0;
        }

        try {
            this._connection?.close(null);
        } catch (_e) {}
        try {
            this._service?.stop();
        } catch (_e) {}
        try {
            Gio.File.new_for_path(this.socketPath).delete(null);
        } catch (_e) {}

        this._writeQueue = [];
        this._writePending = false;
        this._pendingFrame = null;
        this._input = null;
        this._output = null;
        this._connection = null;
        this._service = null;
        this._closing = false;
    }

    send(message) {
        if (!this._enabled || this._closing || !this._output) {
            if (_debugIpc() && !this._sendDropLogged) {
                this._sendDropLogged = true;
                const reason = !this._output ? 'no_output' : this._closing ? 'closing' : 'disabled';
                this._logger.info?.(`milkdrop [ipc-server] send dropped monitor=${this._monitorIndex} reason=${reason}`);
            }
            return false;
        }

        const payload = `${JSON.stringify(message)}\n`;
        if (message?.type === 'frame') {
            this._pendingFrame = payload;
        } else {
            this._writeQueue.push(payload);
            while (this._writeQueue.length > IpcServer.MAX_QUEUE_LENGTH)
                this._writeQueue.shift();
        }
        this._flushWriteQueue();
        return true;
    }

    _flushWriteQueue() {
        const hasWork = this._writeQueue.length > 0 || this._pendingFrame !== null;
        if (this._writePending || !hasWork || !this._enabled || this._closing || !this._output)
            return;

        this._writePending = true;
        const payload = this._writeQueue.length > 0
            ? this._writeQueue.shift()
            : this._pendingFrame;
        if (payload === this._pendingFrame)
            this._pendingFrame = null;
        if (_debugIpc() && payload && payload.startsWith('{"type":"frame"')) {
            this._frameWriteCount += 1;
            if (this._frameWriteCount % 60 === 0)
                this._logger.info?.(`milkdrop [ipc-server] frame written monitor=${this._monitorIndex} count=${this._frameWriteCount}`);
        }
        const bytes = new GLib.Bytes(encoder.encode(payload));
        const capturedOutput = this._output;
        capturedOutput.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            this._writePending = false;
            if (this._output !== capturedOutput) {
                this._flushWriteQueue();
                return;
            }
            try {
                if (!this._enabled || this._closing)
                    return;
                stream.write_bytes_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.warn?.(`milkdrop ipc write failed for monitor ${this._monitorIndex}: ${error.message}`);
            }
            this._flushWriteQueue();
        });
    }

    _acceptConnection(connection) {
        if (!this._enabled || this._closing)
            return;

        this._closeConnection();

        this._connection = connection;
        this._input = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
        });
        this._output = connection.get_output_stream();
        this._ready = false;
        this._writeQueue = [];
        this._writePending = false;
        this._pendingFrame = null;
        this._logger.warn?.(`[GNOME Milkdrop] IPC client connected monitor=${this._monitorIndex}`);
        this._readControlMessage();
    }

    _readControlMessage() {
        if (!this._enabled || this._closing || !this._input)
            return;

        this._input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            try {
                if (!this._enabled || this._closing || !this._input)
                    return;

                const [line, length] = stream.read_line_finish_utf8(result);
                if (length === 0) {
                    this._closeConnection();
                    return;
                }

                if (line)
                    this._handleLine(line);

                this._readControlMessage();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.debug?.(`milkdrop ipc read stopped for monitor ${this._monitorIndex}: ${error.message}`);
                this._closeConnection();
            }
        });
    }

    _handleLine(line) {
        if (!this._enabled || this._closing)
            return;

        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this._logger.warn?.(`milkdrop ipc invalid JSON on monitor ${this._monitorIndex}: ${error.message}`);
            return;
        }

        if (message.type === 'ready') {
            this._ready = true;
            this._sendDropLogged = false;
            if (_debugIpc())
                this._logger.info?.(`milkdrop [ipc-server] ready received monitor=${this._monitorIndex}`);
        }

        this._onMessage?.(message);
    }

    _closeConnection() {
        if (_debugIpc() && this._connection)
            this._logger.info?.(`milkdrop [ipc-server] client closed monitor=${this._monitorIndex}`);
        this._ready = false;
        this._writeQueue = [];
        this._writePending = false;
        this._pendingFrame = null;
        this._input = null;
        this._output = null;
        try {
            this._connection?.close(null);
        } catch (_error) {
        }
        this._connection = null;
    }

    _unlinkSocket() {
        try {
            Gio.File.new_for_path(this.socketPath).delete(null);
        } catch (_error) {
        }
    }
}
