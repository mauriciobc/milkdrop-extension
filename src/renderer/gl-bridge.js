import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const encoder = new TextEncoder();

const PERF_WINDOW_SIZE = 300;

const FRAME_RENDER_CONTROL_DEFAULTS = {
    cx: 0.5,
    cy: 0.5,
    sx: 1.0,
    sy: 1.0,
    zoomexp: 1.0,
    warp: 1.0,
    wrap: 1,
    echo_zoom: 1.0,
    echo_alpha: 0.0,
    echo_orient: 0,
    gamma: 1.0,
    brighten: 0,
    darken: 0,
    solarize: 0,
    invert: 0,
    darken_center: 0,
    ob_size: 0.01,
    ob_r: 0.0,
    ob_g: 0.0,
    ob_b: 0.0,
    ob_a: 0.0,
    ib_size: 0.01,
    ib_r: 0.25,
    ib_g: 0.25,
    ib_b: 0.25,
    ib_a: 0.0,
    mv_x: 12.0,
    mv_y: 9.0,
    mv_dx: 0.0,
    mv_dy: 0.0,
    mv_l: 0.9,
    mv_r: 1.0,
    mv_g: 1.0,
    mv_b: 1.0,
    mv_a: 0.0,
    wave_mode: 0,
    wave_a: 0.8,
    wave_scale: 1.0,
    wave_smoothing: 0.75,
    wave_x: 0.5,
    wave_y: 0.5,
    wave_dots: 0,
    wave_thick: 0,
    additivewave: 0,
    wave_r: 1.0,
    wave_g: 1.0,
    wave_b: 1.0,
};

function _numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Copy up to `maxLen` finite numeric samples from `src` into a plain Array.
 * Avoids chained map/filter/slice allocations on the per-frame hot path.
 */
function _copyAudioSamples(src, maxLen) {
    if (!src || src.length === 0)
        return [];
    const len = Math.min(src.length, maxLen);
    const out = [];
    for (let i = 0; i < len; i++) {
        const n = Number(src[i]);
        if (Number.isFinite(n))
            out.push(n);
    }
    return out;
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
        this._pendingFrameMetaQueue = [];
        this._shmListener = null;
        this._shmSocketPath = null;
        this._shmAcceptPending = false;
        this._shmConnection = null;
        this._shmReceivePending = false;
        this._shmReceiveSourceId = 0;
        this._shmReadPending = false;
        this._droppedFrameWrites = 0;
        this._perfCollector = new PerfCollector();
    }

    static WATCHDOG_INTERVAL_MS = 5000;
    static WATCHDOG_TIMEOUT_MS = 25000;
    static MAX_RESTARTS = 3;
    static MAX_WRITE_QUEUE_LENGTH = 120;
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
        this._loggedBase64Fallback = false;
        this._loggedBase64Rejected = false;
        this._cancellable = new Gio.Cancellable();

        this._shmFdQueue = [];
        this._pendingFrameMetaQueue = [];
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
        for (const [key, fallback] of Object.entries(FRAME_RENDER_CONTROL_DEFAULTS))
            msg[key] = _numberOr(frameState[key], fallback);
        
        // Send expanded PCM waveform data (576 L + 576 R = 1152 samples) for MilkDrop 2 compliance.
        // Avoid per-frame map/filter/slice allocations — copy directly into pre-sized arrays.
            const pcmLeftSrc = Array.isArray(frameState.pcmLeft) ? frameState.pcmLeft
                : (Array.isArray(audio.pcmLeft) ? audio.pcmLeft : null);
            const pcmRightSrc = Array.isArray(frameState.pcmRight) ? frameState.pcmRight
                : (Array.isArray(audio.pcmRight) ? audio.pcmRight : null);
            msg.pcmLeft = _copyAudioSamples(pcmLeftSrc, 576);
            msg.pcmRight = _copyAudioSamples(pcmRightSrc, 576);

            const waveDataSrc = Array.isArray(frameState.wave_data) ? frameState.wave_data
                : (Array.isArray(frameState.waveData) ? frameState.waveData
                    : (Array.isArray(audio.waveData) ? audio.waveData : null));
            msg.wave_data = _copyAudioSamples(waveDataSrc, 576);
            msg.waveData = _copyAudioSamples(waveDataSrc, 64);

            const spectrumLeftSrc = Array.isArray(frameState.spectrumLeft) ? frameState.spectrumLeft
                : (Array.isArray(audio.spectrumLeft) ? audio.spectrumLeft : Array.isArray(audio.pcmLeft) ? audio.pcmLeft : null);
            const spectrumRightSrc = Array.isArray(frameState.spectrumRight) ? frameState.spectrumRight
                : (Array.isArray(audio.spectrumRight) ? audio.spectrumRight : Array.isArray(audio.pcmRight) ? audio.pcmRight : null);
            msg.spectrumLeft = _copyAudioSamples(spectrumLeftSrc, 64);
            msg.spectrumRight = _copyAudioSamples(spectrumRightSrc, 64);
        if (frameState.warpInShader === true) {
            msg.warpInShader = true;
            msg.warpAmount = frameState.warpAmount ?? 0;
            msg.warpSpeed = frameState.warpSpeed ?? 1;
            msg.warpScale = frameState.warpScale ?? 1;
            msg.warpType = frameState.warpType ?? 0;
        }
        
        // Include custom waves (evaluated by expression engine)
        if (Array.isArray(frameState.customWaves)) {
            msg.customWaves = frameState.customWaves.map(wave => {
                if (!wave) return null;
                return {
                    points: wave.points?.map(p => ({
                        x: Number(p.x) || 0,
                        y: Number(p.y) || 0,
                        r: Number(p.r) || 1,
                        g: Number(p.g) || 1,
                        b: Number(p.b) || 1,
                        a: Number(p.a) || 1,
                    })) || [],
                    useDots: !!wave.useDots,
                    additive: !!wave.additive,
                    drawThick: !!wave.drawThick,
                };
            });
        }
        
        // Include custom shapes (evaluated by expression engine)
        if (Array.isArray(frameState.customShapes)) {
            msg.customShapes = frameState.customShapes.map(shape => {
                if (!shape) return null;
                return {
                    x: Number(shape.x) || 0.5,
                    y: Number(shape.y) || 0.5,
                    rad: Number(shape.rad) || 0.1,
                    ang: Number(shape.ang) || 0,
                    sides: Math.max(3, Math.floor(Number(shape.sides) || 4)),
                    r: Number(shape.r) || 1,
                    g: Number(shape.g) || 0,
                    b: Number(shape.b) || 0,
                    a: Number(shape.a) || 0.8,
                    r2: Number(shape.r2) || 0,
                    g2: Number(shape.g2) || 1,
                    b2: Number(shape.b2) || 0,
                    a2: Number(shape.a2) || 0.5,
                    border_r: Number(shape.border_r) || 1,
                    border_g: Number(shape.border_g) || 1,
                    border_b: Number(shape.border_b) || 1,
                    border_a: Number(shape.border_a) || 0.1,
                    additive: !!shape.additive,
                    thickOutline: !!shape.thickOutline,
                    textured: !!shape.textured,
                    tex_ang: Number(shape.tex_ang) || 0,
                    tex_zoom: Number(shape.tex_zoom) || 1,
                };
            });
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
        this._shmFdQueue = [];
        this._pendingFrameMetaQueue = [];
        this._shmReadPending = false;
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
                        this._shmFdQueue.push(fd);
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

    _closeQueuedShmFds() {
        for (const fd of this._shmFdQueue) {
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
        const bytes = new GLib.Bytes(encoder.encode(entry.payload));
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
                    this._shmFdQueue.push(fd);
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
            this._pendingFrameMetaQueue.push({
                frame: message.frame ?? 0,
                width: message.width ?? 1,
                height: message.height ?? 1,
                stride: message.stride ?? Math.max(1, (message.width ?? 1) * 4),
                format: message.format ?? 'rgba8',
            });
            this._drainShmFrameQueue();
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
            const bytes = GLib.Bytes.new(decoded);
            this._publishFramePixels({
                frame: message.frame ?? 0,
                width: message.width ?? 1,
                height: message.height ?? 1,
                stride: message.stride ?? Math.max(1, (message.width ?? 1) * 4),
                format: message.format ?? 'rgba8',
            }, bytes);
            return;
        }

        if (message.type === 'frame-stat') {
            // Update watchdog heartbeat on every frame-stat so the watchdog doesn't
            // fire when the helper is rendering but pixels can't be delivered (e.g.
            // large frames that exceed the base64 cap with no SHM).
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
            // Restart the watchdog if _ready transitioned false→true (e.g. after a
            // compile-shaders recompile stopped and then resumed frame rendering).
            // The watchdog guard cancels itself when _ready becomes false, so it must
            // be explicitly restarted here.
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

        const metadata = this._pendingFrameMetaQueue.shift();
        const fd = this._shmFdQueue.shift();
        if (!metadata || fd === undefined) {
            if (metadata)
                this._pendingFrameMetaQueue.unshift(metadata);
            if (fd !== undefined)
                this._shmFdQueue.unshift(fd);
            return;
        }

        const pixelCount = metadata.stride * metadata.height;
        this._shmReadPending = true;
        this._readFrameBytesAsync(fd, pixelCount, (error, bytes) => {
            this._shmReadPending = false;
            if (error) {
                this._emit({
                    type: 'telemetry',
                    stage: 'shm_read',
                    level: 'warn',
                    msg: String(error?.message ?? error),
                });
            } else if (bytes) {
                this._publishFramePixels(metadata, bytes);
            }
            this._drainShmFrameQueue();
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
                        callback(new Error(`incomplete frame bytes read expected=${pixelCount} got=${bytes.get_size()}`), null);
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