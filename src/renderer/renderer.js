import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';

import {MilkdropGLArea} from './glarea.js';
import {IpcClient} from './ipc-client.js';
import {PerfCollector} from './gl-bridge.js';

const APPLICATION_ID = 'io.github.mauriciobc.MilkdropRenderer';
const STATUS_REFRESH_INTERVAL_MS = 250;

function _debugIpc() {
    return GLib.getenv('MILKDROP_DEBUG_IPC') === '1';
}

function buildManagedWindowTitle(options) {
    const state = {
        monitor: options.monitor,
        position: [options.x, options.y],
        size: [options.width, options.height],
        keepAtBottom: true,
        keepMinimized: true,
        keepPosition: true,
    };

    return `@${APPLICATION_ID}!${JSON.stringify(state)}|${options.monitor}`;
}

function _hasOptionValue(value) {
    return typeof value === 'string' && value.length > 0 && !value.startsWith('--');
}

function _canonicalPath(path) {
    if (typeof path !== 'string' || path.length === 0)
        return null;
    const absolute = GLib.path_is_absolute(path)
        ? path
        : GLib.build_filenamev([GLib.get_current_dir(), path]);
    return GLib.canonicalize_filename(absolute, null);
}

function _modulePathFromUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('file://'))
        return null;
    try {
        return Gio.File.new_for_uri(url).get_path();
    } catch (_error) {
        return null;
    }
}

function _isExecutedAsMain(importMetaUrl, programArgs) {
    const modulePath = _canonicalPath(_modulePathFromUrl(importMetaUrl));
    const entryPath = _canonicalPath(programArgs?.[0]);
    return Boolean(modulePath && entryPath && modulePath === entryPath);
}

function parseArgs(argv) {
    const options = {
        monitor: 0,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        standalone: false,
        benchmark: false,
        benchmarkFrames: 300,
        useOffload: true,
        socketPath: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];

        switch (arg) {
        case '--monitor':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed))
                    options.monitor = parsed;
                index += 1;
            }
            break;
        case '--x':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed))
                    options.x = parsed;
                index += 1;
            }
            break;
        case '--y':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed))
                    options.y = parsed;
                index += 1;
            }
            break;
        case '--width':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed))
                    options.width = parsed;
                index += 1;
            }
            break;
        case '--height':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed))
                    options.height = parsed;
                index += 1;
            }
            break;
        case '--standalone':
            options.standalone = true;
            break;
        case '--benchmark':
            options.benchmark = true;
            options.standalone = true;
            break;
        case '--benchmark-frames':
            if (_hasOptionValue(value)) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed) && parsed > 0)
                    options.benchmarkFrames = parsed;
                index += 1;
            }
            break;
        case '--no-offload':
            options.useOffload = false;
            break;
        case '--socket-path':
            if (_hasOptionValue(value)) {
                options.socketPath = value;
                index += 1;
            }
            break;
        default:
            break;
        }
    }

    return options;
}

const MilkdropRendererApplication = GObject.registerClass(
class MilkdropRendererApplication extends Gtk.Application {
    constructor(options) {
        super({
            application_id: APPLICATION_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });

        this._options = options;
        this._closing = false;
        this._ipcClient = null;
        this._bridgeStatusText = 'GL bridge pending';
        this._statusLabel = null;
        this._textOverlayVisible = true;
        this._lastFrame = null;
        this._currentPreset = null;
        this._lastFrameStat = null;
        this._framesReceivedCount = 0;
        this._loggedMissingAudio = false;
        this._audioDebugTimeoutId = 0;
        this._statusRefreshTimeoutId = 0;
        this._statusDirty = true;
        this._lastStatusLabelText = '';
        this.connect('activate', () => this._onActivate());
        this.connect('shutdown', () => this._cleanupRuntime());
    }

    _onActivate() {
        const title = this._options.standalone
            ? `Milkdrop Renderer Preview #${this._options.monitor}`
            : buildManagedWindowTitle(this._options);
        const window = new Gtk.ApplicationWindow({
            application: this,
            title,
            decorated: this._options.standalone,
            default_width: this._options.width,
            default_height: this._options.height,
            resizable: this._options.standalone,
        });

        const glArea = new MilkdropGLArea({
            standalone: this._options.standalone,
            logger: console,
            onBridgeMessage: message => {
                if (message.type === 'frame-stat' || message.type === 'frame-pixels')
                    this._lastFrameStat = message.type === 'frame-stat' ? message : this._lastFrameStat;
                this._handleBridgeMessage(message);
                this._statusDirty = true;
            },
        });
        let renderChild = glArea;
        if (this._options.useOffload && typeof Gtk.GraphicsOffload === 'function')
            renderChild = new Gtk.GraphicsOffload({child: glArea});

        let child = renderChild;
        if (this._options.standalone || this._options.socketPath) {
            const overlay = new Gtk.Overlay();
            overlay.set_child(renderChild);

            this._statusLabel = new Gtk.Label({
                label: 'Waiting for frame state',
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                margin_top: 12,
                margin_start: 12,
                selectable: false,
            });
            if (_debugIpc())
                console.info(`milkdrop [renderer] status label created socketPath=${this._options.socketPath ?? 'none'}`);
            this._statusLabel.set_visible(this._textOverlayVisible);
            overlay.add_overlay(this._statusLabel);
            child = overlay;
        }

        window.set_child(child);

        const display = Gdk.Display.get_default();
        const monitors = display ? [...display.get_monitors()] : [];
        if (!this._options.standalone) {
            const monitor = monitors[this._options.monitor] ?? null;
            const geometry = monitor?.get_geometry?.() ?? null;
            const width = geometry?.width ?? this._options.width;
            const height = geometry?.height ?? this._options.height;
            window.set_default_size(width, height);
            window.set_size_request(width, height);
        }

        if (this._options.socketPath) {
            this._ipcClient = new IpcClient({
                socketPath: this._options.socketPath,
                logger: console,
                onFrame: frame => {
                    this._framesReceivedCount += 1;
                    if (_debugIpc() && this._framesReceivedCount % 60 === 1)
                        console.info(`milkdrop [renderer] onFrame count=${this._framesReceivedCount} frame=${frame?.frame ?? '?'} hasAudio=${Boolean(frame?.audio)}`);
                    if (frame && (frame.audio == null || typeof frame.audio !== 'object')) {
                        if (!this._loggedMissingAudio) {
                            console.warn('milkdrop renderer: frame received without audio property, using placeholder');
                            this._loggedMissingAudio = true;
                        }
                        frame = {...frame, audio: {source: '?', active: false, energy: 0, bass: 0, mid: 0, high: 0, beat: 0, decay: 0}};
                    }
                    this._lastFrame = frame;
                    glArea.setFrameState(frame);
                    this._statusDirty = true;
                },
                onPresetLoad: message => {
                    const nextPreset = message.preset ?? null;
                    const presetName = nextPreset?.name ?? 'preset cleared';
                    const presetPath = nextPreset?.path ?? null;
                    try {
                        this._currentPreset = nextPreset;
                        this._bridgeStatusText = nextPreset
                            ? `preset loaded: ${presetName}`
                            : 'preset cleared';
                        this._ipcClient?.send({
                            type: 'telemetry',
                            source: 'renderer',
                            stage: 'preset_load',
                            level: 'info',
                            ok: true,
                            msg: presetName,
                        });
                    } catch (error) {
                        this._bridgeStatusText = `preset load failed: ${presetName}`;
                        console.warn(`milkdrop [renderer] preset load failed (${presetName}): ${error.message}`);
                        this._ipcClient?.send({
                            type: 'telemetry',
                            source: 'renderer',
                            stage: 'preset_load',
                            level: 'warn',
                            ok: false,
                            msg: `${presetName}: ${error.message}`,
                        });
                    }
                    this._statusDirty = true;
                },
                onMessage: message => {
                    if (message.type === 'shutdown') {
                        this._cleanupRuntime();
                        this.quit();
                        return;
                    }

                    if (message.type === 'set-text-overlay-visible') {
                        this._textOverlayVisible = Boolean(message.visible);
                        this._statusLabel?.set_visible(this._textOverlayVisible);
                        this._statusDirty = true;
                        this._flushStatusLabel(true);
                        return;
                    }

                    if (this._statusLabel) {
                        const text = JSON.stringify(message, null, 2);
                        if (text !== this._lastStatusLabelText) {
                            this._statusLabel.set_label(text);
                            this._lastStatusLabelText = text;
                        }
                    }
                },
            });
            this._ipcClient.start();

            if (_debugIpc()) {
                this._audioDebugTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    if (this._closing)
                        return GLib.SOURCE_REMOVE;
                    const a = this._lastFrame?.audio;
                    if (a != null)
                        console.debug(`milkdrop renderer audio debug: source=${a.source ?? '?'} active=${a.active} energy=${(a.energy ?? 0).toFixed(3)} bass=${(a.bass ?? 0).toFixed(3)} mid=${(a.mid ?? 0).toFixed(3)} high=${(a.high ?? 0).toFixed(3)}`);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        }

        this._statusRefreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STATUS_REFRESH_INTERVAL_MS, () => {
            if (this._closing)
                return GLib.SOURCE_REMOVE;
            this._flushStatusLabel();
            return GLib.SOURCE_CONTINUE;
        });
        this._flushStatusLabel(true);

        window.connect('close-request', () => {
            this._cleanupRuntime();
            return false;
        });

        window.present();
        print(`milkdrop renderer ready for monitor ${this._options.monitor}`);
    }

    _flushStatusLabel(force = false) {
        if (!this._statusLabel || !this._textOverlayVisible)
            return;
        if (!force && !this._statusDirty)
            return;

        const frameText = this._lastFrame
            ? `frame ${this._lastFrame.frame} (IPC: ${this._framesReceivedCount})\nzoom ${(this._lastFrame.zoom ?? 0).toFixed(3)}\nrot ${(this._lastFrame.rot ?? 0).toFixed(4)}`
            : `Waiting for frame state (IPC: ${this._framesReceivedCount})`;
        const presetName = this._currentPreset?.name ?? this._lastFrame?.presetName;
        const presetText = presetName ? `preset ${presetName}` : 'preset pending';
        const helperText = this._lastFrameStat
            ? `helper frame ${this._lastFrameStat.frame_count}`
            : 'helper frame pending';
        const audio = this._lastFrame?.audio;
        const audioText = !audio
            ? 'audio (no data)'
            : `audio source=${audio.source ?? '?'} ${audio.active ? 'active' : 'inactive'} energy=${(audio.energy ?? 0).toFixed(2)} b=${(audio.bass ?? 0).toFixed(2)} m=${(audio.mid ?? 0).toFixed(2)} h=${(audio.high ?? 0).toFixed(2)} beat=${audio.beat ?? 0}`;
        const text = `${frameText}\n${presetText}\n${helperText}\n${audioText}\nbridge ${this._bridgeStatusText}`;
        if (text !== this._lastStatusLabelText) {
            this._statusLabel.set_label(text);
            this._lastStatusLabelText = text;
        }
        this._statusDirty = false;
    }

    _cleanupRuntime() {
        if (this._closing)
            return;
        this._closing = true;

        if (this._statusRefreshTimeoutId) {
            GLib.source_remove(this._statusRefreshTimeoutId);
            this._statusRefreshTimeoutId = 0;
        }
        if (this._audioDebugTimeoutId) {
            GLib.source_remove(this._audioDebugTimeoutId);
            this._audioDebugTimeoutId = 0;
        }
        this._ipcClient?.stop();
        this._ipcClient = null;
    }

    _handleBridgeMessage(message) {
        switch (message.type) {
        case 'helper-ready':
            this._bridgeStatusText = message.ok
                ? 'helper ready'
                : `helper not ready: ${message.stage ?? 'unknown'}`;
            this._ipcClient?.send({
                type: 'helper-ready',
                ok: message.ok ?? false,
                stage: message.stage ?? 'unknown',
                msg: message.msg ?? this._bridgeStatusText,
            });
            break;
        case 'frame-stat':
            this._bridgeStatusText = `helper frame ${message.frame_count}`;
            this._ipcClient?.send({
                type: 'frame-stat',
                frame_count: message.frame_count ?? 0,
                time: message.time ?? 0,
            });
            break;
        case 'helper-crashed':
            this._bridgeStatusText = `helper crashed: ${message.stage ?? 'unknown'}`;
            this._ipcClient?.send({
                type: 'helper-crashed',
                stage: message.stage ?? 'unknown',
                msg: message.msg ?? 'native helper crashed',
            });
            break;
        case 'frame-pixels':
            this._bridgeStatusText = `helper pixels frame ${message.frame ?? 0}`;
            break;
        case 'telemetry': {
            const stage = message.stage ?? 'unknown';
            const msg = message.msg ?? stage;
            this._bridgeStatusText = `${stage}: ${msg}`;
            this._ipcClient?.send({
                type: 'telemetry',
                source: 'gl-bridge',
                stage,
                level: message.level ?? 'info',
                ok: message.ok ?? true,
                msg,
            });
            break;
        }
        case 'shader_error':
            this._bridgeStatusText = `shader error: ${message.stage}`;
            this._ipcClient?.send({
                type: 'shader_error',
                stage: message.stage ?? 'unknown',
                msg: message.msg ?? 'unknown shader error',
            });
            break;
        default:
            this._bridgeStatusText = JSON.stringify(message);
            this._ipcClient?.send({
                type: 'telemetry',
                source: 'gl-bridge',
                stage: 'message',
                level: 'debug',
                ok: true,
                msg: JSON.stringify(message),
            });
            break;
        }
    }
});

export {parseArgs, MilkdropRendererApplication};

/**
 * Benchmark mode: render N frames with synthetic data, print timing summary, exit.
 * Requires a display and GL context (not headless), but no IPC or extension.
 */
function runBenchmark(options) {
    const totalFrames = options.benchmarkFrames;
    const collector = new PerfCollector(totalFrames);
    let framesRendered = 0;

    const app = new Gtk.Application({
        application_id: `${APPLICATION_ID}.Benchmark`,
        flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
    });

    app.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({
            application: app,
            title: 'Milkdrop Benchmark',
            default_width: options.width,
            default_height: options.height,
            decorated: true,
        });

        const glArea = new MilkdropGLArea({
            standalone: true,
            logger: console,
            onBridgeMessage: message => {
                if (message.type === 'frame-stat') {
                    collector.record(message);
                    framesRendered++;
                    if (framesRendered >= totalFrames) {
                        const stats = collector.getStats();
                        print('\nMilkdrop Renderer Benchmark');
                        print('='.repeat(60));
                        print(`Resolution: ${options.width}x${options.height}`);
                        print(`Frames: ${totalFrames}`);
                        print(`FPS: ${stats.fps}`);
                        print('');
                        const fmtRow = (label, s) =>
                            `  ${label.padEnd(12)} min=${String(s.min).padStart(7)} med=${String(s.median).padStart(7)} avg=${String(s.mean).padStart(9)} p95=${String(s.p95).padStart(7)} p99=${String(s.p99).padStart(7)} max=${String(s.max).padStart(7)} µs`;
                        print(fmtRow('Render', stats.render));
                        print(fmtRow('Readback', stats.readback));
                        print(fmtRow('Total', stats.total));
                        print('='.repeat(60));

                        // Also output JSON for machine consumption
                        print(`\n${JSON.stringify({benchmark: stats, resolution: {width: options.width, height: options.height}, frames: totalFrames}, null, 2)}`);

                        app.quit();
                    }
                }
                if (message.type === 'helper-ready' && message.ok)
                    print(`GL helper ready, rendering ${totalFrames} frames...`);
            },
        });

        window.set_child(glArea);
        window.present();

        // Feed synthetic frames at vsync-ish rate
        let frameCounter = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (framesRendered >= totalFrames)
                return GLib.SOURCE_REMOVE;

            frameCounter++;
            const t = frameCounter / 60;
            glArea.setFrameState({
                frame: frameCounter,
                t,
                zoom: 1.0 + 0.02 * Math.sin(t * 0.5),
                rot: 0.012 * Math.sin(t * 0.25),
                dx: 0.01 * Math.sin(t * 0.3),
                dy: 0.01 * Math.cos(t * 0.2),
                decay: 0.97,
                presetId: 'bootstrap:demo-wave',
                presetName: 'Demo Wave',
                blendProgress: 1,
                audio: {energy: 0.45, bass: 0.52, mid: 0.38, high: 0.22, beat: 0, decay: 0.44},
                uniforms: {
                    time: t,
                    zoom: 1.02,
                    rot: 0.015,
                    dx: 0.003,
                    dy: -0.002,
                    decay: 0.97,
                    energy: 0.45,
                    bass: 0.52,
                    mid: 0.38,
                    high: 0.22,
                    beat: 0,
                },
            });

            return GLib.SOURCE_CONTINUE;
        });
    });

    app.run([]);
}

const PROGRAM_ARGS = imports.system?.programArgs ?? [];
const CLI_ARGS = PROGRAM_ARGS.length > 0
    ? PROGRAM_ARGS.slice(1)
    : (typeof ARGV !== 'undefined' ? ARGV : []);

const _isMain = typeof import.meta.main === 'boolean'
    ? import.meta.main
    : _isExecutedAsMain(import.meta.url, PROGRAM_ARGS);

if (_isMain) {
    const options = parseArgs(CLI_ARGS);
    if (options.benchmark) {
        runBenchmark(options);
    } else {
        const app = new MilkdropRendererApplication(options);
        app.run([]);
    }
}
