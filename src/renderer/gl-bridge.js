import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const encoder = new TextEncoder();

function buildHelperPath() {
    const moduleFile = Gio.File.new_for_uri(import.meta.url);
    return GLib.build_filenamev([
        moduleFile.get_parent().get_path(),
        'milkdrop-gl-helper',
    ]);
}

function buildShmSocketPath() {
    const runtimeDir = GLib.get_user_runtime_dir();
    const nonce = `${GLib.get_monotonic_time()}-${Math.floor(Math.random() * 1_000_000)}`;
    return `${runtimeDir}/gnome-milkdrop-shm-${nonce}.sock`;
}

export class GlBridge {
    constructor({strictRenderPath = false, logger = console, onMessage = null}) {
        this._logger = logger;
        this._onMessage = onMessage;
        this._helperPath = buildHelperPath();
        this._allowBase64Fallback = !strictRenderPath;
        this._loggedBase64Fallback = false;
        this._loggedBase64Rejected = false;
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._cancellable = null;
        this._running = false;
        this._ready = false;
        this._lastFramePixels = null;
        this._lastFrameSerial = 0;
        this._startConfig = null;
        this._watchdogId = 0;
        this._lastFrameTime = 0;
        this._restartCount = 0;
        this._writeQueue = [];
        this._writePending = false;
        this._shmFdQueue = [];
        this._shmListener = null;
        this._shmSocketPath = null;
        this._shmAcceptPending = false;
    }

    static WATCHDOG_INTERVAL_MS = 5000;
    static WATCHDOG_TIMEOUT_MS = 10000;
    static MAX_RESTARTS = 3;
    static DEFAULT_ZOOM = 1.0;
    static DEFAULT_DECAY = 0.98;

    get available() {
        return Gio.File.new_for_path(this._helperPath).query_exists(null);
    }

    get ready() {
        return this._ready;
    }

    get lastFramePixels() {
        return this._lastFramePixels;
    }

    start({width, height}) {
        if (this._running)
            return true;

        this._writeQueue = [];
        this._writePending = false;

        if (!this.available) {
            this._ready = false;
            this._emit({
                type: 'helper-ready',
                ok: false,
                stage: 'helper_missing',
                msg: `native GL helper not found at ${this._helperPath}`,
            });
            this._emit({
                type: 'telemetry',
                stage: 'helper_missing',
                level: 'warn',
                msg: `native GL helper not found at ${this._helperPath}`,
            });
            return false;
        }

        this._running = true;
        this._ready = false;
        this._lastFramePixels = null;
        this._lastFrameSerial = 0;
        this._loggedBase64Fallback = false;
        this._loggedBase64Rejected = false;
        this._cancellable = new Gio.Cancellable();

        this._shmFdQueue = [];
        this._setupShmListener();

        const helperArgv = this._shmSocketPath
            ? [this._helperPath, '--shm-socket-path', this._shmSocketPath]
            : [this._helperPath];

        try {
            this._process = Gio.Subprocess.new(
                helperArgv,
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE
            );
        } catch (error) {
            this._emit({
                type: 'helper-ready',
                ok: false,
                stage: 'helper_spawn_failed',
                msg: error.message,
            });
            this._emit({
                type: 'telemetry',
                stage: 'helper_spawn_failed',
                level: 'error',
                msg: error.message,
            });
            this._running = false;
            this._startConfig = null;
            this._teardownShmListener();
            this._cancellable = null;
            return false;
        }

        this._stdin = this._process.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({
            base_stream: this._process.get_stdout_pipe(),
        });

        this._readOutput();
        this._process.wait_async(this._cancellable, (process, result) => {
            try {
                process.wait_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._handleHelperExit('helper_wait_failed', error.message);
                return;
            }

            if (!this._running)
                return;

            const exitCode = process.get_if_exited?.() ? process.get_exit_status() : -1;
            this._handleHelperExit('helper_exited', `native helper exited with code ${exitCode}`);
        });
        this.send({type: 'init', width, height});
        this.send({type: 'compile-default'});
        this._startConfig = {width, height};
        this._lastFrameTime = GLib.get_monotonic_time();
        this._startWatchdog();
        this._emit({
            type: 'telemetry',
            stage: 'helper_spawned',
            level: 'info',
            helperPath: this._helperPath,
        });
        if (!this._allowBase64Fallback) {
            this._emit({
                type: 'telemetry',
                stage: 'strict_render_path',
                level: 'info',
                msg: 'strict render path enabled; base64 frame fallback disabled',
            });
        }
        return true;
    }

    submitFrame(frameState) {
        if (!this._running || !this._ready)
            return;

        const audio = frameState.audio ?? {};
        const msg = {
            type: 'frame',
            frame: frameState.frame,
            time: frameState.t,
            zoom: frameState.zoom ?? GlBridge.DEFAULT_ZOOM,
            rot: frameState.rot ?? 0.0,
            dx: frameState.dx ?? 0.0,
            dy: frameState.dy ?? 0.0,
            decay: frameState.decay ?? GlBridge.DEFAULT_DECAY,
            energy: audio.energy ?? 0,
            bass: audio.bass ?? 0,
            mid: audio.mid ?? 0,
            high: audio.high ?? 0,
        };
        if (frameState.warpInShader === true) {
            msg.warpInShader = true;
            msg.warpAmount = frameState.warpAmount ?? 0;
            msg.warpSpeed = frameState.warpSpeed ?? 1;
            msg.warpScale = frameState.warpScale ?? 1;
            msg.warpType = frameState.warpType ?? 0;
        }
        this.send(msg);
    }

    uploadMesh(meshData) {
        if (!this._running || !this._ready)
            return;

        const b64 = GLib.base64_encode(new Uint8Array(meshData.vertices.buffer));
        this.send({
            type: 'mesh',
            vertexCount: meshData.vertexCount,
            floatsPerVertex: meshData.floatsPerVertex,
            data: b64,
        });
    }

    compileShaders(shaders) {
        if (!this._running)
            return;

        this.send({
            type: 'compile-shaders',
            draw: shaders?.draw ?? null,
            warp: shaders?.warp ?? null,
            composite: shaders?.composite ?? null,
        });
    }

    stop() {
        if (!this._running)
            return;

        this._stopWatchdog();
        this._writeQueue = [];
        this._writePending = false;
        this._teardownShmListener();
        this.send({type: 'shutdown'});
        this._running = false;
        this._ready = false;
        this._lastFramePixels = null;
        this._startConfig = null;
        this._cancellable?.cancel();
        try {
            this._process?.force_exit?.();
        } catch (_error) {
        }
        this._process = null;
        this._stdin = null;
        this._stdout = null;
        this._cancellable = null;
    }

    _setupShmListener() {
        this._teardownShmListener();
        this._shmSocketPath = buildShmSocketPath();
        try {
            try {
                Gio.File.new_for_path(this._shmSocketPath).delete(null);
            } catch (_e) {
            }

            this._shmListener = new Gio.SocketListener();
            const addr = Gio.UnixSocketAddress.new(this._shmSocketPath);
            this._shmListener.add_address(addr, Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
            this._armShmAcceptLoop();
        } catch (error) {
            this._emit({
                type: 'telemetry',
                stage: 'shm_listener_bind',
                level: 'warn',
                msg: error.message,
            });
            this._teardownShmListener();
        }
    }

    _teardownShmListener() {
        this._shmAcceptPending = false;
        if (this._shmListener) {
            try {
                this._shmListener.close();
            } catch (_e) {
            }
            this._shmListener = null;
        }
        if (this._shmSocketPath) {
            try {
                Gio.File.new_for_path(this._shmSocketPath).delete(null);
            } catch (_e) {
            }
            this._shmSocketPath = null;
        }
        this._shmFdQueue = [];
    }

    send(message) {
        if (!this._running || !this._stdin)
            return false;

        this._writeQueue.push(`${JSON.stringify(message)}\n`);
        this._flushWriteQueue();
        return true;
    }

    _flushWriteQueue() {
        if (this._writePending || !this._writeQueue.length || !this._running || !this._stdin)
            return;

        this._writePending = true;
        const payload = this._writeQueue.shift();
        const bytes = new GLib.Bytes(encoder.encode(payload));
        const capturedStdin = this._stdin;
        capturedStdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            if (this._stdin !== capturedStdin)
                return;
            this._writePending = false;
            try {
                stream.write_bytes_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._emit({
                        type: 'telemetry',
                        stage: 'helper_write_failed',
                        level: 'warn',
                        msg: error.message,
                    });
                }
            }
            this._flushWriteQueue();
        });
    }

    _armShmAcceptLoop() {
        if (!this._shmListener || !this._running || !this._cancellable || this._shmAcceptPending)
            return;

        this._shmAcceptPending = true;
        this._shmListener.accept_async(this._cancellable, (listener, result) => {
            this._shmAcceptPending = false;
            if (!this._running || !this._shmListener)
                return;

            try {
                const accepted = listener.accept_finish(result);
                const connection = Array.isArray(accepted) ? accepted[0] : accepted;

                if (!connection) {
                    this._emit({
                        type: 'telemetry',
                        stage: 'shm_accept',
                        level: 'warn',
                        msg: 'shm accept returned no connection',
                    });
                    this._armShmAcceptLoop();
                    return;
                }

                if (typeof connection.receive_fd_async === 'function') {
                    connection.receive_fd_async(this._cancellable, (conn, res) => {
                        if (!this._running)
                            return;

                        try {
                            const fd = conn.receive_fd_finish(res);
                            if (fd >= 0) {
                                this._shmFdQueue.push(fd);
                            } else {
                                this._emit({
                                    type: 'telemetry',
                                    stage: 'shm_receive_fd',
                                    level: 'warn',
                                    msg: 'received invalid shm file descriptor',
                                });
                            }
                        } catch (error) {
                            this._emit({
                                type: 'telemetry',
                                stage: 'shm_receive_fd',
                                level: 'warn',
                                msg: error.message,
                            });
                        }

                        this._armShmAcceptLoop();
                    });
                    return;
                }

                if (typeof connection.receive_fd === 'function') {
                    try {
                        const fd = connection.receive_fd(this._cancellable);
                        if (fd >= 0) {
                            this._shmFdQueue.push(fd);
                        } else {
                            this._emit({
                                type: 'telemetry',
                                stage: 'shm_receive_fd',
                                level: 'warn',
                                msg: 'received invalid shm file descriptor',
                            });
                        }
                    } catch (error) {
                        this._emit({
                            type: 'telemetry',
                            stage: 'shm_receive_fd',
                            level: 'warn',
                            msg: error.message,
                        });
                    }

                    this._armShmAcceptLoop();
                    return;
                }

                this._emit({
                    type: 'telemetry',
                    stage: 'shm_accept',
                    level: 'warn',
                    msg: 'shm connection missing fd receive support',
                });
                this._armShmAcceptLoop();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._emit({
                        type: 'telemetry',
                        stage: 'shm_accept',
                        level: 'warn',
                        msg: error.message,
                    });
                    this._armShmAcceptLoop();
                }
            }
        });
    }

    _readOutput() {
        if (!this._stdout)
            return;

        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            try {
                const [line, length] = stream.read_line_finish_utf8(result);
                if (length === 0) {
                    if (this._running)
                        this._handleHelperExit('helper_stdout_closed', 'native helper stdout closed unexpectedly');
                    return;
                }

                if (line)
                    this._handleLine(line);

                this._readOutput();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._handleHelperExit('helper_read_failed', error.message);
                }
            }
        });
    }

    _handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (_error) {
            this._emit({
                type: 'telemetry',
                stage: 'helper_stdout',
                level: 'debug',
                msg: line,
            });
            return;
        }

        if (message.type === 'frame-pixels-fd') {
            const width = message.width ?? 1;
            const height = message.height ?? 1;
            const stride = message.stride ?? Math.max(1, width * 4);
            const pixelCount = stride * height;
            const fd = this._shmFdQueue.shift();
            if (fd === undefined) {
                this._emit({
                    type: 'telemetry',
                    stage: 'shm_fd',
                    level: 'warn',
                    msg: 'frame-pixels-fd with no pending fd',
                });
                return;
            }
            try {
                const stream = Gio.UnixInputStream.new(fd, true);
                const bytes = stream.read_bytes(pixelCount, null);
                stream.close(null);
                this._lastFrameSerial += 1;
                this._lastFrameTime = GLib.get_monotonic_time();
                this._lastFramePixels = {
                    frame: message.frame ?? 0,
                    width,
                    height,
                    stride,
                    format: message.format ?? 'rgba8',
                    bytes: bytes.get_data(),
                    serial: this._lastFrameSerial,
                };
                this._emit({
                    type: 'frame-pixels',
                    ...this._lastFramePixels,
                });
            } catch (e) {
                this._emit({
                    type: 'telemetry',
                    stage: 'shm_read',
                    level: 'warn',
                    msg: String(e?.message ?? e),
                });
            }
            return;
        }

        if (message.type === 'frame-pixels') {
            if (!this._allowBase64Fallback) {
                if (!this._loggedBase64Rejected) {
                    this._loggedBase64Rejected = true;
                    this._emit({
                        type: 'telemetry',
                        stage: 'base64_disabled',
                        level: 'warn',
                        msg: 'dropping base64 frame payload because strict render path is enabled',
                    });
                }
                return;
            }

            if (!this._loggedBase64Fallback) {
                this._loggedBase64Fallback = true;
                this._emit({
                    type: 'telemetry',
                    stage: 'base64_fallback',
                    level: 'warn',
                    msg: 'using deprecated base64 frame transport fallback',
                });
            }

            const decoded = GLib.base64_decode(message.data ?? '');
            this._lastFrameSerial += 1;
            this._lastFrameTime = GLib.get_monotonic_time();
            this._lastFramePixels = {
                frame: message.frame ?? 0,
                width: message.width ?? 1,
                height: message.height ?? 1,
                stride: message.stride ?? Math.max(1, (message.width ?? 1) * 4),
                format: message.format ?? 'rgba8',
                bytes: decoded,
                serial: this._lastFrameSerial,
            };
            this._emit({
                type: 'frame-pixels',
                ...this._lastFramePixels,
            });
            return;
        }

        if (message.type === 'frame-stat') {
            this._emit(message);
            return;
        }

        if (message.type === 'telemetry' && message.stage === 'program_ready' && message.ok) {
            this._ready = true;
            this._emit({
                type: 'helper-ready',
                ok: true,
                stage: message.stage,
                msg: message.msg ?? 'native helper ready',
            });
        }

        if (message.type === 'shader_error') {
            this._ready = false;
            this._lastFramePixels = null;
            this._emit({
                type: 'helper-ready',
                ok: false,
                stage: message.stage ?? 'shader_error',
                msg: message.msg ?? 'shader error',
            });
        }

        this._emit(message);
    }

    _handleHelperExit(stage, msg) {
        if (!this._running)
            return;

        this._running = false;
        this._ready = false;
        this._lastFramePixels = null;
        this._writeQueue = [];
        this._writePending = false;
        this._stopWatchdog();
        this._teardownShmListener();
        this._stdin = null;
        this._stdout = null;
        this._process = null;
        this._cancellable = null;
        this._emit({
            type: 'helper-ready',
            ok: false,
            stage,
            msg,
        });
        this._emit({
            type: 'helper-crashed',
            stage,
            msg,
        });

        this._tryRestart();
    }

    _startWatchdog() {
        this._stopWatchdog();
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GlBridge.WATCHDOG_INTERVAL_MS, () => {
            if (!this._running || !this._ready) {
                this._watchdogId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const elapsed = (GLib.get_monotonic_time() - this._lastFrameTime) / 1000;
            if (elapsed > GlBridge.WATCHDOG_TIMEOUT_MS) {
                this._emit({
                    type: 'telemetry',
                    stage: 'watchdog',
                    level: 'warn',
                    msg: `helper unresponsive for ${Math.round(elapsed)}ms, restarting`,
                });
                this._watchdogId = 0;
                this.stop();
                this._tryRestart();
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWatchdog() {
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }
    }

    _tryRestart() {
        if (!this._startConfig)
            return;

        if (this._restartCount >= GlBridge.MAX_RESTARTS) {
            this._emit({
                type: 'telemetry',
                stage: 'watchdog',
                level: 'error',
                msg: `helper restart limit reached (${GlBridge.MAX_RESTARTS})`,
            });
            return;
        }

        this._restartCount += 1;
        this._emit({
            type: 'telemetry',
            stage: 'watchdog',
            level: 'info',
            msg: `restarting helper (attempt ${this._restartCount}/${GlBridge.MAX_RESTARTS})`,
        });

        const config = this._startConfig;
        this.start(config);
    }

    _emit(message) {
        this._onMessage?.(message);
    }
}