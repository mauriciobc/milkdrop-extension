import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const encoder = new TextEncoder();
const SHM_READ_RETRY_BASE_MS = 5;
const SHM_READ_RETRY_MAX_MS = 100;
const FORCED_GC_INTERVAL_US = 100_000;

const forceGc = (() => {
    if (typeof globalThis.gc === 'function')
        return () => globalThis.gc();
    if (typeof imports !== 'undefined' && typeof imports.system?.gc === 'function')
        return () => imports.system.gc();
    return null;
})();

const PERF_WINDOW_SIZE = 300;

/**
 * Copy up to `maxLen` finite numeric samples from `src` into a plain Array.
 * Pre-allocates to avoid dynamic growth on the per-frame hot path.
 * Values already confirmed as numbers (e.g. from JSON.parse) skip the cast.
 */
function _copyAudioSamples(src, maxLen) {
    if (!src || src.length === 0)
        return [];
    const len = Math.min(src.length, maxLen);
    const out = new Array(len);
    let count = 0;
    for (let i = 0; i < len; i++) {
        const n = typeof src[i] === 'number' ? src[i] : Number(src[i]);
        if (Number.isFinite(n))
            out[count++] = n;
    }
    return count === len ? out : out.slice(0, count);
}

/**
 * Rolling frame-time statistics collector.
 * Collects render_us and readback_us from frame-stat messages and
 * computes percentiles over a sliding window.
 */
export class PerfCollector {
    constructor(windowSize = PERF_WINDOW_SIZE) {
        this._windowSize = windowSize;
        this._renderTimes = new Float64Array(windowSize);
        this._readbackTimes = new Float64Array(windowSize);
        this._totalTimes = new Float64Array(windowSize);
        this._index = 0;
        this._count = 0;
        this._lastFrameCount = 0;
        this._firstFrameTime = 0;
        this._lastFrameTime = 0;
    }

    record(frameStat) {
        const renderUs = frameStat.render_us ?? 0;
        const readbackUs = frameStat.readback_us ?? 0;
        const i = this._index % this._windowSize;
        this._renderTimes[i] = renderUs;
        this._readbackTimes[i] = readbackUs;
        this._totalTimes[i] = renderUs + readbackUs;
        this._index++;
        if (this._count < this._windowSize)
            this._count++;
        this._lastFrameCount = frameStat.frame_count ?? this._index;
        const t = frameStat.time ?? 0;
        if (this._firstFrameTime === 0)
            this._firstFrameTime = t;
        this._lastFrameTime = t;
    }

    getStats() {
        if (this._count === 0)
            return null;

        const n = this._count;
        const render = this._sorted(this._renderTimes, n);
        const readback = this._sorted(this._readbackTimes, n);
        const total = this._sorted(this._totalTimes, n);
        const elapsed = this._lastFrameTime - this._firstFrameTime;
        const fps = elapsed > 0 ? this._lastFrameCount / elapsed : 0;

        return {
            frames: this._lastFrameCount,
            windowSize: n,
            fps: Math.round(fps * 100) / 100,
            render: this._percentiles(render),
            readback: this._percentiles(readback),
            total: this._percentiles(total),
        };
    }

    reset() {
        this._index = 0;
        this._count = 0;
        this._lastFrameCount = 0;
        this._firstFrameTime = 0;
        this._lastFrameTime = 0;
    }

    _sorted(arr, n) {
        const slice = new Float64Array(n);
        const offset = this._index > this._windowSize ? this._index % this._windowSize : 0;
        for (let i = 0; i < n; i++)
            slice[i] = arr[(offset + i) % this._windowSize];
        slice.sort();
        return slice;
    }

    _percentiles(sorted) {
        const n = sorted.length;
        const p = (pct) => sorted[Math.max(0, Math.min(Math.ceil(pct / 100 * n) - 1, n - 1))];
        let sum = 0;
        for (let i = 0; i < n; i++)
            sum += sorted[i];
        return {
            min: sorted[0],
            median: p(50),
            mean: Math.round(sum / n * 100) / 100,
            p95: p(95),
            p99: p(99),
            max: sorted[n - 1],
        };
    }
}

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

function supportsAsyncShmFdReceive() {
    return typeof Gio.UnixConnection?.prototype?.receive_fd_async === 'function';
}

function supportsShmFdReceive() {
    const proto = Gio.UnixConnection?.prototype;
    if (!proto) return false;
    // Prefer async; fall back to sync via GLib FD source (receive_fd + get_socket).
    return typeof proto.receive_fd_async === 'function' ||
        (typeof proto.receive_fd === 'function' && typeof proto.get_socket === 'function');
}

export class GlBridge {
    constructor({strictRenderPath = false, logger = console, onMessage = null}) {
        this._logger = logger;
        this._onMessage = onMessage;
        this._helperPath = buildHelperPath();
        this._strictRenderPath = Boolean(strictRenderPath);
        this._loggedUnexpectedBase64 = false;
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
        this._lastFrameSentTime = 0;
        this._restartCount = 0;
        this._writeQueue = [];
        this._writePending = false;
        this._shmSlots = [];
        this._shmListener = null;
        this._shmSocketPath = null;
        this._shmAcceptPending = false;
        this._shmConnection = null;
        this._shmReceivePending = false;
        this._shmReceiveSourceId = 0;
        this._shmReadPending = false;
        this._shmDrainSourceId = 0;
        this._shmReadFailureStreak = 0;
        this._droppedFrameWrites = 0;
        this._perfCollector = new PerfCollector();
        this._lastForcedGcUs = 0;
    }

    static WATCHDOG_INTERVAL_MS = 5000;
    static WATCHDOG_TIMEOUT_MS = 25000;
    static MAX_RESTARTS = 3;
    static MAX_WRITE_QUEUE_LENGTH = 120;

    get available() {
        return Gio.File.new_for_path(this._helperPath).query_exists(null);
    }

    get ready() {
        return this._ready;
    }

    get lastFramePixels() {
        return this._lastFramePixels;
    }

    getPerfStats() {
        return this._perfCollector.getStats();
    }

    start({width, height}) {
        if (this._running)
            return true;

        this._writeQueue = [];
        this._writePending = false;
        this._droppedFrameWrites = 0;

        this._logger.warn?.(
            `milkdrop gl-bridge: helper path=${this._helperPath} exists=${this.available}`
        );

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
        this._loggedUnexpectedBase64 = false;
        this._cancellable = new Gio.Cancellable();

        this._shmSlots = [];
        this._shmReadPending = false;
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
        // Capture process at spawn time so a stale wait_async callback from a
        // dead helper cannot fire after _tryRestart has already replaced it.
        const capturedProcess = this._process;
        this._process.wait_async(this._cancellable, (process, result) => {
            try {
                process.wait_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._handleHelperExit('helper_wait_failed', error.message);
                return;
            }

            // Guard: if _process was replaced by a restart, this event is stale.
            if (this._process !== capturedProcess)
                return;
            if (!this._running)
                return;

            const exitCode = process.get_if_exited?.() ? process.get_exit_status() : -1;
            this._handleHelperExit('helper_exited', `native helper exited with code ${exitCode}`);
        });
        this.send({type: 'init', width, height});
        this._startConfig = {width, height};
        this._lastFrameTime = GLib.get_monotonic_time();
        this._startWatchdog();
        this._emit({
            type: 'telemetry',
            stage: 'helper_spawned',
            level: 'info',
            helperPath: this._helperPath,
        });
        if (this._strictRenderPath) {
            this._emit({
                type: 'telemetry',
                stage: 'strict_render_path',
                level: 'info',
                msg: 'strict render path enabled',
            });
        }
        return true;
    }

    resize({width, height}) {
        if (!this._running)
            return;
        if (width === this._startConfig?.width && height === this._startConfig?.height)
            return;
        this._startConfig = {width, height};
        // Allow resizes before helper-ready: size_allocate can fire before the
        // helper emits program_ready. The write queue preserves ordering.
        this.send({type: 'resize', width, height});
    }

    submitFrame(frameState) {
        if (!this._running || !this._ready)
            return;

        const audio = frameState.audio ?? {};
        const pcmLeftSrc = Array.isArray(frameState.pcmLeft) ? frameState.pcmLeft
            : (Array.isArray(audio.pcmLeft) ? audio.pcmLeft : null);
        const pcmRightSrc = Array.isArray(frameState.pcmRight) ? frameState.pcmRight
            : (Array.isArray(audio.pcmRight) ? audio.pcmRight : null);

        const msg = {
            type: 'frame',
            time: frameState.t,
            pcmLeft: _copyAudioSamples(pcmLeftSrc, 576),
            pcmRight: _copyAudioSamples(pcmRightSrc, 576),
        };

        if (frameState.presetPath != null && frameState.presetPath !== '')
            msg.presetPath = String(frameState.presetPath);

        this.send(msg);
    }

    changePreset(path) {
        if (!this._running)
            return;
        if (!path)
            return;
        this.send({type: 'preset-change', path: String(path)});
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
        this._lastFrameSentTime = 0;
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

        if (!supportsShmFdReceive()) {
            this._emit({
                type: 'telemetry',
                stage: 'shm_unavailable',
                level: 'warn',
                msg: 'gio fd receive is unavailable; disabling shm transport',
            });
            return;
        }

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
        if (this._shmDrainSourceId) {
            GLib.source_remove(this._shmDrainSourceId);
            this._shmDrainSourceId = 0;
        }
        this._closeShmConnection();
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
        this._closeQueuedShmFds();
        this._shmSlots = [];
        this._shmReadPending = false;
        this._shmReadFailureStreak = 0;
    }

    _closeShmConnection() {
        this._shmReceivePending = false;
        if (this._shmReceiveSourceId) {
            GLib.source_remove(this._shmReceiveSourceId);
            this._shmReceiveSourceId = 0;
        }
        if (!this._shmConnection)
            return;

        const connection = this._shmConnection;
        this._shmConnection = null;
        try {
            connection.close(null);
        } catch (_e) {
        }
    }

    // Thin wrapper around GLibUnix.fd_add_full so tests can mock it without touching
    // the real GLib event loop.
    _addFdSource(priority, fd, condition, callback) {
        return GLibUnix.fd_add_full(priority, fd, condition, callback);
    }

    // Non-blocking FD receive loop for systems where receive_fd_async is unavailable.
    // Uses a GLib FD source on the connection socket so receive_fd() is only called
    // when data is actually readable — safe to call synchronously at that point.
    _startShmReceiveLoopSync(connection, socketFd) {
        if (!this._running || this._shmConnection !== connection)
            return;

        this._shmReceiveSourceId = this._addFdSource(
            GLib.PRIORITY_DEFAULT, socketFd, GLib.IOCondition.IN, () => {
                if (this._shmConnection !== connection) {
                    this._shmReceiveSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                try {
                    const fd = connection.receive_fd(null);
                    if (typeof fd === 'number' && fd >= 0) {
                        this._enqueueShmFd(fd);
                        this._drainShmFrameQueue();
                    } else {
                        this._emit({
                            type: 'telemetry',
                            stage: 'shm_receive_fd',
                            level: 'warn',
                            msg: 'sync receive_fd returned invalid file descriptor',
                        });
                    }
                } catch (error) {
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return GLib.SOURCE_REMOVE;
                    this._emit({
                        type: 'telemetry',
                        stage: 'shm_receive_fd',
                        level: 'warn',
                        msg: error.message,
                    });
                    this._shmReceiveSourceId = 0;
                    this._closeShmConnection();
                    this._armShmAcceptLoop();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _enqueueShmFd(fd) {
        const slot = this._shmSlots.find(s => s.fd === undefined);
        if (slot)
            slot.fd = fd;
        else
            this._shmSlots.push({ meta: undefined, fd });
    }

    _closeQueuedShmFds() {
        for (const slot of this._shmSlots) {
            const fd = slot.fd;
            if (typeof fd !== 'number' || fd < 0)
                continue;
            try {
                const stream = Gio.UnixInputStream.new(fd, true);
                stream.close(null);
            } catch (_e) {
            }
        }
    }

    send(message) {
        if (!this._running || !this._stdin)
            return false;

        if (message.type === 'frame')
            this._lastFrameSentTime = GLib.get_monotonic_time();

        if (this._writeQueue.length >= GlBridge.MAX_WRITE_QUEUE_LENGTH) {
            if (message.type === 'frame') {
                this._droppedFrameWrites += 1;
                if (this._droppedFrameWrites === 1 || this._droppedFrameWrites % 60 === 0) {
                    this._emit({
                        type: 'telemetry',
                        stage: 'helper_write_backpressure',
                        level: 'warn',
                        msg: `dropping frame writes due to full queue (${this._writeQueue.length}) count=${this._droppedFrameWrites}`,
                    });
                }
                return false;
            }

            const oldestFrameIndex = this._writeQueue.findIndex(entry => entry.type === 'frame');
            if (oldestFrameIndex >= 0) {
                this._writeQueue.splice(oldestFrameIndex, 1);
            } else {
                this._writeQueue.shift();
                this._emit({
                    type: 'telemetry',
                    stage: 'helper_write_backpressure',
                    level: 'warn',
                    msg: 'write queue full without frame payloads; dropping oldest control message',
                });
            }
        }

        this._writeQueue.push({
            type: message.type ?? 'unknown',
            payload: `${JSON.stringify(message)}\n`,
        });
        this._flushWriteQueue();
        return true;
    }

    _flushWriteQueue() {
        if (this._writePending || !this._writeQueue.length || !this._running || !this._stdin)
            return;

        this._writePending = true;
        const entry = this._writeQueue.shift();
        let bytes;
        try {
            bytes = new GLib.Bytes(encoder.encode(entry.payload));
        } catch (e) {
            this._writePending = false;
            this._emit({type: 'telemetry', stage: 'helper_encode_failed', level: 'warn', msg: e.message});
            this._flushWriteQueue();
            return;
        }
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
        if (!this._shmListener || !this._running || !this._cancellable || this._shmAcceptPending || this._shmConnection)
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

                if (typeof connection.receive_fd_async !== 'function') {
                    // Try GLib source-based sync fallback (GJS < 1.86 doesn't bind receive_fd_async).
                    const socket = typeof connection.get_socket === 'function' ? connection.get_socket() : null;
                    const socketFd = typeof socket?.get_fd === 'function' ? socket.get_fd() : -1;
                    if (typeof socketFd === 'number' && socketFd >= 0) {
                        this._shmConnection = connection;
                        this._startShmReceiveLoopSync(connection, socketFd);
                        return;
                    }
                    this._emit({
                        type: 'telemetry',
                        stage: 'shm_accept',
                        level: 'warn',
                        msg: 'shm connection missing async fd receive support; disabling shm transport',
                    });
                    try {
                        connection.close(null);
                    } catch (_e) {
                    }
                    this._teardownShmListener();
                    return;
                }

                this._shmConnection = connection;
                this._startShmReceiveLoop(connection);
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

    _startShmReceiveLoop(connection) {
        if (!this._running || !this._cancellable || !connection || this._shmConnection !== connection)
            return;

        if (this._shmReceivePending)
            return;

        this._shmReceivePending = true;
        connection.receive_fd_async(this._cancellable, (conn, res) => {
            if (this._shmConnection !== connection) {
                this._shmReceivePending = false;
                return;
            }

            this._shmReceivePending = false;
            if (!this._running)
                return;

            try {
                const fd = conn.receive_fd_finish(res);
                if (fd >= 0) {
                    this._enqueueShmFd(fd);
                    this._drainShmFrameQueue();
                } else {
                    this._emit({
                        type: 'telemetry',
                        stage: 'shm_receive_fd',
                        level: 'warn',
                        msg: 'received invalid shm file descriptor',
                    });
                }
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._emit({
                    type: 'telemetry',
                    stage: 'shm_receive_fd',
                    level: 'warn',
                    msg: error.message,
                });
                this._closeShmConnection();
                this._armShmAcceptLoop();
            }
            this._startShmReceiveLoop(connection);
        });
    }

    _readOutput() {
        // Capture stdout/cancellable at call time so stale async callbacks from a
        // previous helper instance don't interfere after _tryRestart replaces them.
        const stdout = this._stdout;
        const cancellable = this._cancellable;
        if (!stdout)
            return;

        stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
            // Guard: if _stdout was replaced by a restart, this loop is stale — drop it.
            if (this._stdout !== stdout)
                return;

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
            const meta = {
                frame: message.frame ?? 0,
                width: message.width ?? 1,
                height: message.height ?? 1,
                stride: message.stride ?? Math.max(1, (message.width ?? 1) * 4),
                format: message.format ?? 'rgba8',
            };
            const slot = this._shmSlots.find(s => s.meta === undefined);
            if (slot)
                slot.meta = meta;
            else
                this._shmSlots.push({ meta, fd: undefined });
            this._drainShmFrameQueue();
            return;
        }

        if (message.type === 'frame-pixels') {
            if (!this._loggedUnexpectedBase64) {
                this._loggedUnexpectedBase64 = true;
                this._emit({
                    type: 'telemetry',
                    stage: 'unexpected_base64_frame',
                    level: 'warn',
                    msg: 'dropping deprecated base64 frame payload (frame-pixels); strict renderer expects SHM/FD transport',
                });
            }
            return;
        }

        if (message.type === 'frame-stat') {
            // Update watchdog heartbeat on every frame-stat so the watchdog doesn't
            // fire when the helper is rendering but pixels can't be delivered (e.g.
            // SHM transport temporarily unavailable).
            this._lastFrameTime = GLib.get_monotonic_time();
            this._perfCollector.record(message);
            this._emit(message);
            return;
        }

        if (message.type === 'telemetry' && message.stage === 'program_ready' && message.ok) {
            const wasReady = this._ready;
            this._ready = true;
            this._emit({
                type: 'helper-ready',
                ok: true,
                stage: message.stage,
                msg: message.msg ?? 'native helper ready',
            });
            // Restart the watchdog if _ready transitioned false→true (e.g. after
            // an error recovery or helper restart).  The watchdog guard cancels
            // itself when _ready becomes false, so it must be restarted here.
            if (!wasReady)
                this._startWatchdog();
            // Emit the raw telemetry too so listeners can observe it, then return —
            // the fall-through this._emit(message) below would double-emit otherwise.
            this._emit(message);
            return;
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

    _drainShmFrameQueue() {
        if (this._shmReadPending)
            return;

        const readyIndex = this._shmSlots.findIndex(s => s.meta != null && s.fd !== undefined);
        if (readyIndex < 0)
            return;

        const slot = this._shmSlots[readyIndex];
        this._shmSlots.splice(readyIndex, 1);
        const metadata = slot.meta;
        const fd = slot.fd;

        const pixelCount = metadata.stride * metadata.height;
        this._shmReadPending = true;
        this._readFrameBytesAsync(fd, pixelCount, (error, bytes) => {
            this._shmReadPending = false;
            if (error) {
                this._shmReadFailureStreak += 1;
                this._emit({
                    type: 'telemetry',
                    stage: 'shm_read',
                    level: 'warn',
                    msg: String(error?.message ?? error),
                });
                const delayMs = Math.min(
                    SHM_READ_RETRY_MAX_MS,
                    SHM_READ_RETRY_BASE_MS * (2 ** (this._shmReadFailureStreak - 1))
                );
                this._scheduleShmQueueDrain(delayMs);
            } else if (bytes) {
                this._shmReadFailureStreak = 0;
                this._publishFramePixels(metadata, bytes);
                this._drainShmFrameQueue();
            }
        });
    }

    _scheduleShmQueueDrain(delayMs = 0) {
        if (this._shmDrainSourceId)
            return;
        const delay = Math.max(0, Math.floor(delayMs));
        this._shmDrainSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._shmDrainSourceId = 0;
            this._drainShmFrameQueue();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readFrameBytesAsync(fd, pixelCount, callback) {
        let stream = null;
        try {
            stream = Gio.UnixInputStream.new(fd, true);
            stream.read_bytes_async(pixelCount, GLib.PRIORITY_DEFAULT, this._cancellable, (input, result) => {
                try {
                    const bytes = input.read_bytes_finish(result);
                    if (bytes.get_size() !== pixelCount) {
                        const error = new Error(`incomplete frame bytes read expected=${pixelCount} got=${bytes.get_size()}`);
                        error.code = 'INCOMPLETE_SHM_READ';
                        error.expected = pixelCount;
                        error.got = bytes.get_size();
                        callback(error, null);
                        return;
                    }
                    callback(null, bytes);
                } catch (error) {
                    callback(error, null);
                } finally {
                    try {
                        input.close(null);
                    } catch (_e) {
                    }
                }
            });
        } catch (error) {
            try {
                stream?.close?.(null);
            } catch (_e) {
            }
            callback(error, null);
        }
    }

    _publishFramePixels(metadata, bytes) {
        this._lastFrameSerial += 1;
        this._lastFrameTime = GLib.get_monotonic_time();
        // Explicitly drop the previous frame before creating the new one so the
        // GLib.Bytes (230+ KB of pixel data) can be collected promptly.  Without this,
        // SpiderMonkey may accumulate many live frames because it cannot see the C-heap
        // cost of the opaque GLib.Bytes wrapper objects.
        this._lastFramePixels = null;
        this._lastFramePixels = {
            frame: metadata.frame ?? 0,
            width: metadata.width ?? 1,
            height: metadata.height ?? 1,
            stride: metadata.stride ?? Math.max(1, (metadata.width ?? 1) * 4),
            format: metadata.format ?? 'rgba8',
            bytes,
            serial: this._lastFrameSerial,
        };
        this._emit({
            type: 'frame-pixels',
            ...this._lastFramePixels,
        });
        this._maybeForceGc();
    }

    _maybeForceGc() {
        if (!forceGc)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this._lastForcedGcUs < FORCED_GC_INTERVAL_US)
            return;
        this._lastForcedGcUs = nowUs;
        try {
            forceGc();
        } catch (_error) {
        }
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

            // If no frame has been sent recently (rendering is paused or initial
            // compile phase), reset the heartbeat so the watchdog doesn't fire
            // on an intentionally idle helper.  _lastFrameSentTime === 0 means
            // no frame has ever been sent (still compiling shaders).
            const sinceLastSend = this._lastFrameSentTime > 0
                ? (GLib.get_monotonic_time() - this._lastFrameSentTime) / 1000
                : Infinity;
            if (sinceLastSend > GlBridge.WATCHDOG_TIMEOUT_MS)
                this._lastFrameTime = GLib.get_monotonic_time();

            const elapsed = (GLib.get_monotonic_time() - this._lastFrameTime) / 1000;
            if (elapsed > GlBridge.WATCHDOG_TIMEOUT_MS) {
                const watchdogMsg = `milkdrop gl-bridge: watchdog triggered, helper unresponsive for ${Math.round(elapsed)}ms`;
                // Log directly to console so the message reaches journalctl even when
                // the IPC channel to the extension is stalled or the write buffer is full.
                this._logger.warn?.(watchdogMsg);
                this._emit({
                    type: 'telemetry',
                    stage: 'watchdog',
                    level: 'warn',
                    msg: `helper unresponsive for ${Math.round(elapsed)}ms, restarting`,
                });
                this._watchdogId = 0;
                // Save config before stop() clears it, otherwise _tryRestart()
                // will return immediately because !_startConfig.
                const savedConfig = this._startConfig;
                this.stop();
                if (savedConfig)
                    this._startConfig = savedConfig;
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
        if (!this._startConfig) {
            // No config means we can't restart; notify listeners so the glarea
            // can fall back to the software animation instead of freezing.
            this._emit({
                type: 'helper-ready',
                ok: false,
                stage: 'restart_unavailable',
                msg: 'helper restart unavailable (no start config)',
            });
            return;
        }

        if (this._restartCount >= GlBridge.MAX_RESTARTS) {
            this._emit({
                type: 'telemetry',
                stage: 'watchdog',
                level: 'error',
                msg: `helper restart limit reached (${GlBridge.MAX_RESTARTS})`,
            });
            this._emit({
                type: 'helper-ready',
                ok: false,
                stage: 'restart_limit_reached',
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