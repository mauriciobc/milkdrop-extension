import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';

import {MilkdropGLArea} from './glarea.js';
import {IpcClient} from './ipc-client.js';

const APPLICATION_ID = 'io.github.mauriciobc.MilkdropRenderer';

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

function parseArgs(argv) {
    const options = {
        monitor: 0,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        standalone: false,
        useOffload: true,
        strictRenderPath: false,
        socketPath: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];

        switch (arg) {
        case '--monitor':
            options.monitor = parseInt(value, 10);
            index += 1;
            break;
        case '--x':
            options.x = parseInt(value, 10);
            index += 1;
            break;
        case '--y':
            options.y = parseInt(value, 10);
            index += 1;
            break;
        case '--width':
            options.width = parseInt(value, 10);
            index += 1;
            break;
        case '--height':
            options.height = parseInt(value, 10);
            index += 1;
            break;
        case '--standalone':
            options.standalone = true;
            break;
        case '--no-offload':
            options.useOffload = false;
            break;
        case '--socket-path':
            options.socketPath = value;
            index += 1;
            break;
        case '--strict-render-path':
            options.strictRenderPath = true;
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
        this.connect('activate', () => this._onActivate());
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

        let lastFrame = null;
        let currentPreset = null;
        let lastFrameStat = null;
        let statusLabel = null;
        let audioDebugTimeoutId = 0;
        let framesReceivedCount = 0;
        let loggedMissingAudio = false;
        const updateStatusLabel = () => {
            if (!statusLabel)
                return;

            const frameText = lastFrame
                ? `frame ${lastFrame.frame} (IPC: ${framesReceivedCount})\nzoom ${(lastFrame.zoom ?? 0).toFixed(3)}\nrot ${(lastFrame.rot ?? 0).toFixed(4)}`
                : `Waiting for frame state (IPC: ${framesReceivedCount})`;
            const presetName = currentPreset?.name ?? lastFrame?.presetName;
            const presetText = presetName ? `preset ${presetName}` : 'preset pending';
            const helperText = lastFrameStat
                ? `helper frame ${lastFrameStat.frame_count}`
                : 'helper frame pending';
            const audio = lastFrame?.audio;
            const audioText = !audio
                ? 'audio (no data)'
                : `audio source=${audio.source ?? '?'} ${audio.active ? 'active' : 'inactive'} energy=${(audio.energy ?? 0).toFixed(2)} b=${(audio.bass ?? 0).toFixed(2)} m=${(audio.mid ?? 0).toFixed(2)} h=${(audio.high ?? 0).toFixed(2)} beat=${audio.beat ?? 0}`;
            statusLabel.set_label(`${frameText}\n${presetText}\n${helperText}\n${audioText}\nbridge ${this._bridgeStatusText}`);
        };

        const glArea = new MilkdropGLArea({
            standalone: this._options.standalone,
            strictRenderPath: this._options.strictRenderPath,
            logger: console,
            onBridgeMessage: message => {
                if (message.type === 'frame-stat' || message.type === 'frame-pixels')
                    lastFrameStat = message.type === 'frame-stat' ? message : lastFrameStat;
                this._handleBridgeMessage(message);
                updateStatusLabel();
            },
        });
        let renderChild = glArea;
        if (this._options.useOffload && typeof Gtk.GraphicsOffload === 'function')
            renderChild = new Gtk.GraphicsOffload({child: glArea});

        let child = renderChild;
        if (this._options.standalone || this._options.socketPath) {
            const overlay = new Gtk.Overlay();
            overlay.set_child(renderChild);

            statusLabel = new Gtk.Label({
                label: 'Waiting for frame state',
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                margin_top: 12,
                margin_start: 12,
                selectable: false,
            });
            if (_debugIpc())
                console.info(`milkdrop [renderer] status label created socketPath=${this._options.socketPath ?? 'none'}`);
            overlay.add_overlay(statusLabel);
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
                    framesReceivedCount += 1;
                    if (_debugIpc() && framesReceivedCount % 60 === 1)
                        console.info(`milkdrop [renderer] onFrame count=${framesReceivedCount} frame=${frame?.frame ?? '?'} hasAudio=${Boolean(frame?.audio)}`);
                    if (frame && (frame.audio == null || typeof frame.audio !== 'object')) {
                        if (!loggedMissingAudio) {
                            console.warn('milkdrop renderer: frame received without audio property, using placeholder');
                            loggedMissingAudio = true;
                        }
                        frame = {...frame, audio: {source: '?', active: false, energy: 0, bass: 0, mid: 0, high: 0, beat: 0, decay: 0}};
                    }
                    lastFrame = frame;
                    glArea.setFrameState(frame);
                    updateStatusLabel();
                },
                onPresetLoad: message => {
                    currentPreset = message.preset ?? null;
                    this._bridgeStatusText = currentPreset
                        ? `preset loaded: ${currentPreset.name}`
                        : 'preset cleared';
                    glArea.loadPresetVertex(currentPreset?.vertex ?? null);
                    glArea.loadPresetShaders(currentPreset?.shaders ?? null);
                    this._ipcClient?.send({
                        type: 'telemetry',
                        source: 'renderer',
                        stage: 'preset_load',
                        level: 'info',
                        ok: true,
                        msg: currentPreset?.name ?? 'preset cleared',
                    });
                    updateStatusLabel();
                },
                onMessage: message => {
                    if (message.type === 'shutdown') {
                        this.quit();
                        return;
                    }

                    if (statusLabel)
                        statusLabel.set_label(JSON.stringify(message, null, 2));
                },
            });
            this._ipcClient.start();

            if (_debugIpc()) {
                audioDebugTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    if (this._closing)
                        return GLib.SOURCE_REMOVE;
                    const a = lastFrame?.audio;
                    if (a != null)
                        console.debug(`milkdrop renderer audio debug: source=${a.source ?? '?'} active=${a.active} energy=${(a.energy ?? 0).toFixed(3)} bass=${(a.bass ?? 0).toFixed(3)} mid=${(a.mid ?? 0).toFixed(3)} high=${(a.high ?? 0).toFixed(3)}`);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        }

        updateStatusLabel();

        window.connect('close-request', () => {
            if (this._closing)
                return false;

            this._closing = true;
            if (audioDebugTimeoutId) {
                GLib.source_remove(audioDebugTimeoutId);
                audioDebugTimeoutId = 0;
            }
            this._ipcClient?.stop();
            this._ipcClient = null;
            return false;
        });

        window.present();
        print(`milkdrop renderer ready for monitor ${this._options.monitor}`);
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

const app = new MilkdropRendererApplication(parseArgs(ARGV));
app.run([]);
