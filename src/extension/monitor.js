import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {AudioEngine} from './audio.js';
import {Evaluator} from './evaluator.js';
import {IpcServer} from './ipc.js';
import {perfBegin, perfEnd} from './perf.js';
import {PresetStore} from './presets.js';
import {parseRendererWindowTitle, RENDERER_TITLE_PREFIX} from './windowTitle.js';

const HOTPLUG_RESTART_DEBOUNCE_MS = 150;
const NOTIFICATION_COOLDOWN_MS = 10000;
const DEFAULT_BEAT_CUT_COOLDOWN_SEC = 2.0;
const VALID_ROTATION_MODES = new Set(['random', 'sequential']);

function _debugIpc() {
    return GLib.getenv('MILKDROP_DEBUG_IPC') === '1';
}

function _isDisposed(obj) {
    try {
        if (!obj)
            return true;
        return GObject.Object.prototype.toString.call(obj).includes('DISPOSED');
    } catch (_e) {
        return true;
    }
}

// Module-level guard: prevents _handleWindowMapped from creating new
// ManagedRendererWindow instances while any _refresh() is executing.
// This breaks the unmanaged→remap→new-MRW→idle→_refresh→... recursion.
let _windowRefreshActive = false;

function notifyUser(title, body, logger) {
    try {
        const source = new MessageTray.Source({
            title: 'MilkDrop',
            iconName: 'dialog-warning-symbolic',
        });
        Main.messageTray.add(source);
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            isTransient: true,
        });
        source.addNotification(notification);
    } catch (error) {
        logger?.debug?.(`milkdrop notification failed: ${error.message}`);
    }
}

class ManagedRendererWindow {
    constructor({window, logger}) {
        this._window = window;
        this._logger = logger;
        this._signals = [];
        this._refreshing = false;
        this._refreshSourceId = 0;
        this._state = {
            position: null,
            keepAtBottom: false,
            keepMinimized: false,
            keepPosition: false,
            desktopType: false,
        };

        this._parseTitle();
        this._scheduleRefresh();

        // Re-minimize if something un-minimizes the window (e.g. a click).
        this._signals.push(
            this._window.connect_after('shown', () => {
                if (this._state.keepMinimized)
                    this._window.minimize?.();
            })
        );
        this._signals.push(
            this._window.connect('notify::minimized', () => {
                if (this._state.keepMinimized && !this._window.minimized)
                    this._window.minimize?.();
            })
        );

        // Re-lower if something raises the window.
        this._signals.push(
            this._window.connect_after('raised', () => {
                if (this._state.keepAtBottom)
                    this._window.lower?.();
            })
        );
        this._signals.push(
            this._window.connect('notify::above', () => {
                if (this._state.keepAtBottom && this._window.above)
                    this._window.unmake_above?.();
            })
        );
    }

    disconnect() {
        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        if (this._window) {
            for (const signalId of this._signals) {
                try {
                    this._window.disconnect(signalId);
                } catch (_error) {
                    // Window may already be finalized.
                }
            }
        }
        this._signals = [];
        this._window = null;
    }

    _parseTitle() {
        const parsedTitle = parseRendererWindowTitle(this._window?.title ?? null);
        if (!parsedTitle)
            return;

        try {
            this._state = {
                ...this._state,
                position: Array.isArray(parsedTitle.state.position) ? parsedTitle.state.position.map(Number) : this._state.position,
                keepAtBottom: Boolean(parsedTitle.state.keepAtBottom),
                keepMinimized: Boolean(parsedTitle.state.keepMinimized),
                keepPosition: Boolean(parsedTitle.state.keepPosition),
                desktopType: Boolean(parsedTitle.state.desktopType),
            };
        } catch (error) {
            this._logger.debug?.(`milkdrop failed to parse renderer title state: ${error.message}`);
        }
    }

    _scheduleRefresh() {
        if (this._refreshSourceId)
            return;

        this._refreshSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshSourceId = 0;
            _windowRefreshActive = true;
            try {
                this._refresh();
            } finally {
                _windowRefreshActive = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (!this._window || this._refreshing)
            return;

        this._refreshing = true;
        try {
            this._setDesktopType();
            this._applyPosition();

            if (this._state.keepAtBottom) {
                this._window.unmake_above?.();
                this._window.lower?.();
            }

            if (this._state.keepMinimized && !this._window.minimized)
                this._window.minimize?.();

            this._window.stick?.();
            if (typeof this._window.hide_from_window_list === 'function')
                this._window.hide_from_window_list();
        } finally {
            this._refreshing = false;
        }
    }

    _setDesktopType() {
        if (!this._state.desktopType)
            return;

        if (typeof this._window.set_type !== 'function')
            return;

        if (Meta.WindowType?.DESKTOP === undefined)
            return;

        try {
            this._window.set_type(Meta.WindowType.DESKTOP);
        } catch (error) {
            this._logger.debug?.(`milkdrop failed to set desktop window type: ${error.message}`);
        }
    }

    _applyPosition() {
        if (!this._window || !this._state.keepPosition || !Array.isArray(this._state.position))
            return;

        const [x, y] = this._state.position;
        this._window.move_frame?.(true, x, y);
    }
}

class RendererProcess {
    constructor({extensionPath, monitor, logger, strictRenderPath = false, textOverlayVisible = true, onNotify = null}) {
        this._extensionPath = extensionPath;
        this._monitor = monitor;
        this._logger = logger;
        this._strictRenderPath = strictRenderPath;
        this._textOverlayVisible = Boolean(textOverlayVisible);
        this._pendingTextOverlayVisible = this._textOverlayVisible;
        this._onNotify = onNotify;
        this._waylandClient = null;
        this._stdout = null;
        this._cancellable = new Gio.Cancellable();
        this._running = false;
        this._stopping = false;
        this._launchPath = 'uninitialized';
        this._pendingPresetLoad = null;
        this._helperReady = false;
        this._lastFrameStat = null;
        this._windowManaged = false;
        this._ipc = new IpcServer({
            monitorIndex: monitor.index,
            logger,
            onMessage: message => this._handleIpcMessage(message),
        });
        this.subprocess = null;
        this._killTimeoutId = 0;
        this._stopIdleId = 0;
        this._loggedNotReady = false;
    }

    get monitorIndex() {
        return this._monitor.index;
    }

    get ready() {
        return this._ipc.ready;
    }

    get helperReady() {
        return this._helperReady;
    }

    get lastFrameStat() {
        return this._lastFrameStat;
    }

    get windowManaged() {
        return this._windowManaged;
    }

    markWindowManaged() {
        this._windowManaged = true;
    }

    clearWindowManaged() {
        this._windowManaged = false;
    }

    launch() {
        if (this._running)
            return;

        this._running = true;
        this._stopping = false;
        this._helperReady = false;
        this._lastFrameStat = null;
        this._windowManaged = false;
        this._ipc.enable();

        const rendererPath = GLib.build_filenamev([
            this._extensionPath,
            'renderer',
            'renderer.js',
        ]);
        const argv = [
            'gjs',
            '-m',
            rendererPath,
            '--monitor', `${this._monitor.index}`,
            '--x', `${this._monitor.x}`,
            '--y', `${this._monitor.y}`,
            '--width', `${this._monitor.width}`,
            '--height', `${this._monitor.height}`,
            '--socket-path', this._ipc.socketPath,
        ];

        if (this._strictRenderPath)
            argv.push('--strict-render-path');

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.set_cwd(GLib.get_home_dir());

        const shellVersion = parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);
        this._logger.warn?.(
            `[GNOME Milkdrop] renderer launch monitor=${this._monitor.index} rendererPath=${rendererPath} socketPath=${this._ipc.socketPath} shell=${shellVersion}`
        );
        try {
            if (Meta.is_wayland_compositor()) {
                if (shellVersion >= 49 && typeof Meta.WaylandClient?.new_subprocess === 'function') {
                    this._launchPath = 'wayland-new_subprocess';
                    this._waylandClient = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
                    this.subprocess = this._waylandClient.get_subprocess();
                } else if (typeof Meta.WaylandClient?.new === 'function') {
                    this._launchPath = 'wayland-spawnv';
                    this._waylandClient = Meta.WaylandClient.new(global.context, launcher);
                    this.subprocess = this._waylandClient.spawnv(global.display, argv);
                } else {
                    this._launchPath = 'wayland-launcher-spawnv';
                    this.subprocess = launcher.spawnv(argv);
                }
            } else {
                this._launchPath = 'x11-launcher-spawnv';
                this.subprocess = launcher.spawnv(argv);
            }
        } catch (spawnError) {
            this._logger.warn?.(
                `[GNOME Milkdrop] renderer spawn failed monitor=${this._monitor.index}: ${spawnError.message}`
            );
            this._running = false;
            return;
        }

        if (this.subprocess?.get_stdout_pipe()) {
            this._stdout = new Gio.DataInputStream({
                base_stream: this.subprocess.get_stdout_pipe(),
            });
            this._readOutput();
        }

        this.subprocess?.wait_async(this._cancellable, (process, result) => {
            if (this._killTimeoutId) {
                GLib.source_remove(this._killTimeoutId);
                this._killTimeoutId = 0;
            }
            if (!this._running && !this._stopping)
                return;

            try {
                process.wait_finish(result);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.debug?.(`milkdrop renderer wait failed: ${error.message}`);
                return;
            }

            if (!this._running && !this._stopping)
                return;

            const code = process.get_if_exited() ? process.get_exit_status() : -1;
            this._logger.info?.(`milkdrop renderer exited for monitor ${this._monitor.index} with code ${code}`);
            this._running = false;
            this._stopping = false;
        });
    }

    ownsWindow(window) {
        try {
            return this._waylandClient?.owns_window(window) ?? false;
        } catch (_error) {
            return false;
        }
    }

    stop() {
        if (this._stopping)
            return;

        this._stopping = true;
        this._running = false;
        this._helperReady = false;
        this._lastFrameStat = null;
        this._pendingPresetLoad = null;
        this._windowManaged = false;
        this._ipc.disable();
        this._cancellable.cancel();

        if (this._stopIdleId) {
            GLib.source_remove(this._stopIdleId);
            this._stopIdleId = 0;
        }

        // Capture refs for deferred cleanup — I/O calls are blocked during GC.
        const process = this.subprocess;
        const waylandClient = this._waylandClient;
        const stdout = this._stdout;

        this.subprocess = null;
        this._stdout = null;
        this._waylandClient = null;

        // Defer I/O that GJS blocks during garbage collection.
        this._stopIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._stopIdleId = 0;
            try {
                process?.send_signal(15);
            } catch (_e) {}
            if (process) {
                this._killTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                    try {
                        process.send_signal(9);
                    } catch (_e) {}
                    this._killTimeoutId = 0;
                    return false;
                });
            }
            try {
                waylandClient?.close?.();
            } catch (_e) {}
            try {
                stdout?.close(null);
            } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    sendFrame(frameState) {
        if (!this._running || this._stopping || !this.ready) {
            if (!this.ready && !this._loggedNotReady) {
                this._loggedNotReady = true;
                if (_debugIpc())
                    this._logger.info?.(`milkdrop [extension] sendFrame skipped monitor=${this._monitor.index} reason=not_ready`);
            }
            return false;
        }

        if (_debugIpc() && frameState?.frame != null && frameState.frame % 60 === 0)
            this._logger.info?.(`milkdrop [extension] sendFrame ok monitor=${this._monitor.index}`);

        this._flushPendingPresetLoad();
        this._flushPendingTextOverlaySetting();
        this._ipc.send(frameState);
        return true;
    }

    queuePresetLoad(preset) {
        this._pendingPresetLoad = preset ? {
            id: preset.id,
            name: preset.name,
            source: preset.source,
            frame: preset.frame,
            vertex: preset.vertex ?? null,
            shaders: preset.shaders ?? null,
            baseVals: preset.baseVals,
            init_eqs: preset.init_eqs,
            frame_eqs: preset.frame_eqs,
            pixel_eqs: preset.pixel_eqs,
            shapes: preset.shapes,
            waves: preset.waves,
        } : null;
        this._flushPendingPresetLoad();
    }

    setTextOverlayVisible(visible) {
        this._textOverlayVisible = Boolean(visible);
        this._pendingTextOverlayVisible = this._textOverlayVisible;
        this._flushPendingTextOverlaySetting();
    }

    _handleIpcMessage(message) {
        if (this._stopping)
            return;

        switch (message.type) {
        case 'ready':
            this._logger.warn?.(`[GNOME Milkdrop] renderer IPC ready monitor=${this._monitor.index}`);
            this._flushPendingPresetLoad();
            this._flushPendingTextOverlaySetting();
            break;
        case 'helper-ready':
            this._helperReady = message.ok ?? false;
            this._logger.warn?.(
                `[GNOME Milkdrop] helper ready monitor=${this._monitor.index} ok=${this._helperReady} stage=${message.stage ?? 'unknown'} msg=${message.msg ?? ''}`
            );
            break;
        case 'frame-stat':
            this._lastFrameStat = {
                frameCount: message.frame_count ?? 0,
                time: message.time ?? 0,
            };
            if (this._lastFrameStat.frameCount === 1 || this._lastFrameStat.frameCount % 120 === 0) {
                this._logger.info?.(
                    `milkdrop helper frame monitor=${this._monitor.index} frame=${this._lastFrameStat.frameCount} time=${this._lastFrameStat.time.toFixed(3)}`
                );
            }
            break;
        case 'helper-crashed':
            this._helperReady = false;
            this._logger.warn?.(
                `milkdrop helper crashed on monitor ${this._monitor.index}: ${message.stage ?? 'unknown'} ${message.msg ?? ''}`
            );
            this._onNotify?.('GL Helper Crashed', `Monitor ${this._monitor.index}: ${message.msg ?? message.stage ?? 'unknown error'}`);
            break;
        case 'fps':
            this._logger.debug?.(`milkdrop renderer FPS monitor ${this._monitor.index}: ${message.value}`);
            break;
        case 'telemetry':
            this._logger.info?.(
                `milkdrop renderer telemetry monitor ${this._monitor.index} stage=${message.stage} level=${message.level ?? 'info'} ok=${message.ok ?? true} msg=${message.msg ?? ''}`
            );
            break;
        case 'shader_error':
            this._logger.warn?.(`milkdrop shader error on monitor ${this._monitor.index}: ${message.msg}`);
            this._onNotify?.('Shader Compile Error', `Monitor ${this._monitor.index}: ${message.msg ?? 'unknown shader error'}`);
            break;
        default:
            this._logger.debug?.(`milkdrop renderer control message on monitor ${this._monitor.index}: ${JSON.stringify(message)}`);
            break;
        }
    }

    _flushPendingPresetLoad() {
        if (!this._pendingPresetLoad || !this._running || this._stopping || !this.ready)
            return false;

        this._ipc.send({
            type: 'preset-load',
            preset: this._pendingPresetLoad,
        });
        this._pendingPresetLoad = null;
        return true;
    }

    _flushPendingTextOverlaySetting() {
        if (this._pendingTextOverlayVisible === null || !this._running || this._stopping || !this.ready)
            return false;

        this._ipc.send({
            type: 'set-text-overlay-visible',
            visible: this._pendingTextOverlayVisible,
        });
        this._pendingTextOverlayVisible = null;
        return true;
    }

    _readOutput() {
        if (!this._stdout || this._stopping)
            return;

        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            try {
                if (this._stopping || !this._stdout)
                    return;

                const [line, length] = stream.read_line_finish_utf8(result);
                if (length > 0 && !line.startsWith('milkdrop [renderer]'))
                    this._logger.info?.(`milkdrop renderer[${this._monitor.index}] ${line}`);
                this._readOutput();
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._logger.debug?.(`milkdrop renderer stdout read stopped: ${error.message}`);
            }
        });
    }
}

export class MonitorManager {
    constructor({extensionPath, settings, logger}) {
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._presetStore = new PresetStore({settings: this._settings, logger: this._logger});
        this._evaluator = new Evaluator();
        this._audioEngine = new AudioEngine({
            settings: this._settings,
            logger: this._logger,
            onFallback: (title, body) => this._notifyUser(title, body),
        });
        this._currentPreset = this._presetStore.getBootstrapPreset();
        this._rendererProcesses = new Map();
        this._managedWindows = new Map();
        this._monitorSignals = [];
        this._frameSourceId = 0;
        this._frameCounter = 0;
        this._windowManagerSignalId = 0;
        this._restartTimeoutId = 0;
        this._presetRotationId = 0;
        this._enableIdleId = 0;
        this._spawnRetryId = 0;
        this._settingsSignals = [];
        this._paused = false;
        this._lastBeatCutTime = 0;
        this._lastNotificationTime = 0;
        this._enabled = false;
        this._disabling = false;
        this._strictRenderPathSupported = this._hasSettingKey('strict-render-path');
        this._pauseWhenFullscreenSupported = this._hasSettingKey('pause-when-fullscreen');
        this._presetRotationModeSupported = this._hasSettingKey('preset-rotation-mode');
        this._beatCutCooldownSupported = this._hasSettingKey('beat-cut-cooldown-sec');
        this._audioRestartMaxAttemptsSupported = this._hasSettingKey('audio-restart-max-attempts');
        this._audioReprobeDelaySupported = this._hasSettingKey('audio-reprobe-delay-ms');
        this._textOverlaySupported = this._hasSettingKey('text-overlay-enabled');
        this._sequentialRotationCursor = 0;

        this._evaluator.loadPreset(this._currentPreset);
    }

    enable() {
        this._enabled = true;
        this._disabling = false;
        this._paused = false;

        this._monitorSignals.push({
            owner: Main.layoutManager,
            id: Main.layoutManager.connect('monitors-changed', () => this._scheduleRestart('monitors-changed')),
        });
        this._windowManagerSignalId = global.window_manager.connect_after('map', (_manager, windowActor) => {
            if (this._disabling || !this._enabled)
                return;
            this._handleWindowMapped(windowActor.get_meta_window());
        });

        this._settingsSignals.push(
            this._settings.connect('changed::hide-when-maximized', () => this._checkVisibility()),
            this._settings.connect('changed::show-on-empty-desktop-only', () => this._checkVisibility()),
            this._settings.connect('changed::preset-rotation-interval', () => this._startPresetRotation()),
            this._settings.connect('changed::fps-limit', () => this._startFramePump()),
            this._settings.connect('changed::preset-directory', () => this._handlePresetDirectoryChanged()),
            this._settings.connect('changed::audio-source', () => this._handleAudioSettingChanged('audio-source'))
        );

        if (this._pauseWhenFullscreenSupported)
            this._settingsSignals.push(this._settings.connect('changed::pause-when-fullscreen', () => this._checkVisibility()));

        if (this._presetRotationModeSupported) {
            this._settingsSignals.push(
                this._settings.connect('changed::preset-rotation-mode', () => {
                    this._sequentialRotationCursor = 0;
                })
            );
        }

        if (this._audioRestartMaxAttemptsSupported) {
            this._settingsSignals.push(
                this._settings.connect('changed::audio-restart-max-attempts', () =>
                    this._handleAudioSettingChanged('audio-restart-max-attempts'))
            );
        }

        if (this._audioReprobeDelaySupported) {
            this._settingsSignals.push(
                this._settings.connect('changed::audio-reprobe-delay-ms', () =>
                    this._handleAudioSettingChanged('audio-reprobe-delay-ms'))
            );
        }

        if (this._textOverlaySupported) {
            this._settingsSignals.push(
                this._settings.connect('changed::text-overlay-enabled', () => this._applyTextOverlaySetting())
            );
        }

        if (this._strictRenderPathSupported) {
            this._settingsSignals.push(
                this._settings.connect('changed::strict-render-path', () => this._scheduleRestart('strict-render-path'))
            );
        } else {
            this._logger.info?.('milkdrop strict-render-path setting unavailable in current schema; keeping compatibility mode');
        }

        // Track window-focus changes for visibility policies
        this._focusWindowSignalId = global.display.connect('notify::focus-window', () => {
            if (this._enabled && !this._disabling)
                this._checkVisibility();
        });

        // Defer heavy work so enable() returns immediately and Shell/Extensions stay responsive
        this._enableIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._enableIdleId = 0;
            if (!this._enabled || this._disabling)
                return GLib.SOURCE_REMOVE;
            this._audioEngine.enable();
            this._spawnForCurrentMonitors();
            this._applyTextOverlaySetting();
            this._startFramePump();
            this._startPresetRotation();
            this._checkHelperAvailability();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkHelperAvailability() {
        const helperPath = GLib.build_filenamev([
            this._extensionPath, 'renderer', 'milkdrop-gl-helper',
        ]);
        const helperExists = Gio.File.new_for_path(helperPath).query_exists(null);
        if (!helperExists) {
            this._logger.warn?.(
                'milkdrop: native GL helper not found — renderer will use fallback visuals. '
                + 'Rebuild with EGL/epoxy to enable the full pipeline.'
            );
            this._notifyUser('GL Helper Missing',
                'Native GL helper not found. Rebuild with EGL/epoxy for the full pipeline.');
        }
    }

    _notifyUser(title, body) {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastNotificationTime < NOTIFICATION_COOLDOWN_MS)
            return;
        this._lastNotificationTime = now;
        notifyUser(title, body, this._logger);
    }

    disable() {
        this._disabling = true;
        this._enabled = false;
        this._paused = false;
        this._audioEngine.disable();

        if (this._enableIdleId) {
            GLib.source_remove(this._enableIdleId);
            this._enableIdleId = 0;
        }

        if (this._spawnRetryId) {
            GLib.source_remove(this._spawnRetryId);
            this._spawnRetryId = 0;
        }

        for (const {owner, id} of this._monitorSignals)
            owner.disconnect(id);
        this._monitorSignals = [];

        if (this._windowManagerSignalId) {
            global.window_manager.disconnect(this._windowManagerSignalId);
            this._windowManagerSignalId = 0;
        }

        if (this._focusWindowSignalId) {
            global.display.disconnect(this._focusWindowSignalId);
            this._focusWindowSignalId = 0;
        }

        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];

        if (this._restartTimeoutId) {
            GLib.source_remove(this._restartTimeoutId);
            this._restartTimeoutId = 0;
        }

        if (this._frameSourceId) {
            GLib.source_remove(this._frameSourceId);
            this._frameSourceId = 0;
        }

        if (this._presetRotationId) {
            GLib.source_remove(this._presetRotationId);
            this._presetRotationId = 0;
        }

        this._clearManagedWindows();
        this._stopAll();
        this._evaluator.destroy();
        this._disabling = false;
    }

    _scheduleRestart(reason) {
        if (!this._enabled || this._disabling)
            return;

        if (this._restartTimeoutId)
            GLib.source_remove(this._restartTimeoutId);

        this._logger.debug?.(`milkdrop scheduling renderer restart: ${reason}`);
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOTPLUG_RESTART_DEBOUNCE_MS, () => {
            this._restartTimeoutId = 0;
            this._restartAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restartAll() {
        if (!this._enabled || this._disabling)
            return;

        this._stopAll();
        this._spawnForCurrentMonitors();
    }

    _spawnForCurrentMonitors() {
        if (!this._enabled || this._disabling)
            return;

        const monitors = Main.layoutManager.monitors;
        const enabledMonitors = new Set(this._getStrvSetting('enabled-monitors', []));
        const msg = `[GNOME Milkdrop] _spawnForCurrentMonitors: ${monitors.length} monitor(s), enabledMonitors size=${enabledMonitors.size}`;
        this._logger.warn?.(msg);
        GLib.log_structured?.('GNOME Milkdrop', GLib.LogLevelFlags.LEVEL_WARNING, { MESSAGE: msg });

        if (monitors.length === 0) {
            if (this._spawnRetryId)
                GLib.source_remove(this._spawnRetryId);
            this._spawnRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._spawnRetryId = 0;
                if (!this._enabled || this._disabling)
                    return GLib.SOURCE_REMOVE;
                this._spawnForCurrentMonitors();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        for (const monitor of monitors) {
            if (enabledMonitors.size > 0 && !enabledMonitors.has(`${monitor.index}`))
                continue;

            if (this._rendererProcesses.has(monitor.index))
                continue;

            this._logger.warn?.(`[GNOME Milkdrop] spawning renderer for monitor index=${monitor.index}`);
            const process = new RendererProcess({
                extensionPath: this._extensionPath,
                monitor,
                logger: this._logger,
                strictRenderPath: this._strictRenderPathSupported
                    ? this._getBooleanSetting('strict-render-path', false)
                    : false,
                textOverlayVisible: this._getBooleanSetting('text-overlay-enabled', true),
                onNotify: (title, body) => this._notifyUser(title, body),
            });
            process.launch();
            process.queuePresetLoad(this._currentPreset);
            this._rendererProcesses.set(monitor.index, process);
        }
    }

    _applyTextOverlaySetting() {
        const visible = this._getBooleanSetting('text-overlay-enabled', true);
        for (const process of this._rendererProcesses.values())
            process.setTextOverlayVisible(visible);
    }

    _startFramePump() {
        if (this._frameSourceId)
            GLib.source_remove(this._frameSourceId);

        const fpsLimit = Math.max(1, this._getIntSetting('fps-limit', 60));
        const intervalMs = Math.max(16, Math.round(1000 / fpsLimit));
        this._frameSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            try {
                if (!this._enabled || this._disabling || this._frameSourceId === 0) {
                    this._frameSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                if (this._paused)
                    return GLib.SOURCE_CONTINUE;

                this._frameCounter += 1;

                const pumpToken = perfBegin('frame-pump');

                if (_debugIpc() && this._frameCounter % 60 === 0)
                    this._logger.info?.(`milkdrop [extension] pump tick frame=${this._frameCounter} processes=${this._rendererProcesses.size} paused=${this._paused}`);

                if (_debugIpc() && this._frameCounter % Math.max(1, fpsLimit) === 0) {
                    const f = this._audioEngine.getFeatures();
                    this._logger.info?.(
                        `milkdrop audio debug: source=${f.source} active=${f.active} energy=${(f.energy ?? 0).toFixed(3)} bass=${(f.bass ?? 0).toFixed(3)} mid=${(f.mid ?? 0).toFixed(3)} high=${(f.high ?? 0).toFixed(3)} beat=${f.beat ?? 0}`
                    );
                }

                for (const process of this._rendererProcesses.values()) {
                    try {
                        process.sendFrame(this._buildFrameState(process.monitorIndex, fpsLimit));
                    } catch (error) {
                        this._logger.warn?.(`milkdrop frame pump failed for process ${process.monitorIndex}: ${error.message}`);
                    }
                }

                perfEnd(pumpToken);
            } catch (outerError) {
                this._logger.warn?.(`milkdrop frame pump critical error: ${outerError.message}`);
            }

            return GLib.SOURCE_CONTINUE;
        });
        if (_debugIpc())
            this._logger.info?.(`milkdrop [extension] frame pump started fpsLimit=${fpsLimit} intervalMs=${intervalMs}`);
    }

    _startPresetRotation() {
        if (this._presetRotationId) {
            GLib.source_remove(this._presetRotationId);
            this._presetRotationId = 0;
        }

        const intervalSec = this._getIntSetting('preset-rotation-interval', 60);
        if (intervalSec <= 0)
            return;

        this._presetRotationId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSec, () => {
            if (!this._enabled || this._disabling) {
                this._presetRotationId = 0;
                return GLib.SOURCE_REMOVE;
            }

            this._rotatePreset();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _rotatePreset() {
        try {
            const index = await this._presetStore.loadIndex();
            if (!this._enabled || index.length <= 1)
                return;

            const nextPresetId = this._selectNextPresetId(index);
            if (!this._enabled || !nextPresetId)
                return;

            const preset = await this._presetStore.loadPreset(nextPresetId);
            if (!this._enabled)
                return;
            this._applyPreset(preset, 'rotated');
        } catch (error) {
            this._logger.debug?.(`milkdrop preset rotation failed: ${error.message}`);
        }
    }

    _selectNextPresetId(index) {
        const mode = this._getPresetRotationMode();
        if (mode === 'sequential') {
            let nextIndex = index.findIndex(entry => entry.id === this._currentPreset?.id);
            if (nextIndex >= 0)
                nextIndex = (nextIndex + 1) % index.length;
            else
                nextIndex = this._sequentialRotationCursor % index.length;

            this._sequentialRotationCursor = (nextIndex + 1) % index.length;
            return index[nextIndex]?.id ?? null;
        }

        const candidates = index.filter(entry => entry.id !== this._currentPreset?.id);
        if (candidates.length === 0)
            return null;

        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return pick.id;
    }

    _applyPreset(preset, reason = 'updated') {
        try {
            this._currentPreset = preset;
            const blendTime = Math.max(0, this._getDoubleSetting('blend-time', 0));
            this._evaluator.loadPreset(preset, blendTime);

            for (const process of this._rendererProcesses.values())
                process.queuePresetLoad(preset);

            this._logger.info?.(`milkdrop [TEST] Loading preset ID: ${preset.id} - Name: ${preset.name} - Reason: ${reason}`);
        } catch (error) {
            this._logger.warn?.(`milkdrop failed to apply preset "${preset?.name ?? 'unknown'}": ${error.message}`);
        }
    }

    async _handlePresetDirectoryChanged() {
        this._presetStore.handleSettingsChanged?.('preset-directory');
        this._sequentialRotationCursor = 0;

        if (!this._enabled || this._disabling)
            return;

        if (this._currentPreset?.source !== 'file')
            return;

        try {
            const reloaded = await this._presetStore.loadPreset(this._currentPreset.id);
            this._applyPreset(reloaded, 'reloaded after preset directory change');
        } catch (_error) {
            const fallbackPreset = this._presetStore.getBootstrapPreset();
            this._applyPreset(fallbackPreset, 'reset to bootstrap after preset directory change');
        }
    }

    _handleAudioSettingChanged(reason) {
        if (!this._enabled || this._disabling)
            return;

        this._audioEngine.handleSettingsChanged(reason);
    }

    _checkVisibility() {
        if (!this._enabled || this._disabling)
            return;

        const hideWhenMaximized = this._getBooleanSetting('hide-when-maximized', false);
        const emptyDesktopOnly = this._getBooleanSetting('show-on-empty-desktop-only', false);
        const pauseWhenFullscreen = this._getBooleanSetting('pause-when-fullscreen', false);

        let shouldPause = false;

        if (hideWhenMaximized) {
            const focusWindow = global.display.focus_window;
            if (focusWindow && !_isDisposed(focusWindow) && focusWindow.maximized_horizontally && focusWindow.maximized_vertically)
                shouldPause = true;
        }

        if (pauseWhenFullscreen && !shouldPause) {
            const focusWindow = global.display.focus_window;
            if (focusWindow && !_isDisposed(focusWindow) && focusWindow.fullscreen)
                shouldPause = true;
        }

        if (emptyDesktopOnly && !shouldPause) {
            // Check if any non-renderer windows exist on any active workspace
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = workspace.list_windows();
            const hasUserWindows = windows.some(w => {
                if (w.is_skip_taskbar?.())
                    return false;
                if (w.title?.startsWith(RENDERER_TITLE_PREFIX))
                    return false;
                if (w.get_window_type?.() === Meta.WindowType.DESKTOP)
                    return false;
                if (w.get_window_type?.() === Meta.WindowType.DOCK)
                    return false;
                return !w.minimized;
            });
            if (hasUserWindows)
                shouldPause = true;
        }

        this._paused = shouldPause;
    }

    _buildFrameState(monitorIndex, fpsLimit) {
        const baseFrameState = {
            type: 'frame',
            monitor: monitorIndex,
            t: GLib.get_monotonic_time() / 1000000,
            fps: fpsLimit,
            frame: this._frameCounter,
            audio: this._audioEngine.getFeatures(),
        };

        const evalToken = perfBegin('evaluator');
        const evaluated = this._evaluator.evaluateFrame(baseFrameState);
        perfEnd(evalToken);

        // Guarantee a plain, JSON-serializable audio object so the renderer always receives audio data
        const raw = evaluated.audio ?? this._audioEngine.getFeatures();
        evaluated.audio = {
            source: String(raw?.source ?? 'stub'),
            active: Boolean(raw?.active),
            energy: Number(raw?.energy ?? 0),
            bass: Number(raw?.bass ?? 0),
            mid: Number(raw?.mid ?? 0),
            high: Number(raw?.high ?? 0),
            beat: Number(raw?.beat ?? 0),
            decay: Number(raw?.decay ?? 0),
            waveData: raw?.waveData || [],
            pcmLeft: raw?.pcmLeft || [],
            pcmRight: raw?.pcmRight || [],
        };

        // Beat-cut: trigger immediate preset rotation on beat if enabled
        // Cooldown is configurable for beat-cut behavior.
        if (this._getBooleanSetting('beat-cuts-enabled', false) && evaluated.audio?.beat) {
            const now = GLib.get_monotonic_time() / 1000000;
            const cooldown = Math.max(0, this._getDoubleSetting('beat-cut-cooldown-sec', DEFAULT_BEAT_CUT_COOLDOWN_SEC));
            if (now - this._lastBeatCutTime > cooldown) {
                this._lastBeatCutTime = now;
                this._rotatePreset();
            }
        }

        return evaluated;
    }

    _handleWindowMapped(window) {
        if (this._disabling || !this._enabled || !window)
            return;

        if (_windowRefreshActive || !this._enabled)
            return;

        const process = this._findRendererProcessForWindow(window);
        if (!process && !this._isRendererWindow(window))
            return;

        try {
            if (!window.get_compositor_private?.())
                return;

            if (process?.windowManaged)
                return;

            if (this._managedWindows.has(window))
                return;

            this._managedWindows.set(window, {managedWindow: null, unmanagedId: 0});
            const managedWindow = new ManagedRendererWindow({window, logger: this._logger});
            const unmanagedId = window.connect('unmanaged', currentWindow => {
                this._clearManagedWindow(currentWindow);
            });
            process?.markWindowManaged();
            this._managedWindows.set(window, {managedWindow, unmanagedId, process});
        } catch (error) {
            this._managedWindows.delete(window);
            this._logger.debug?.(`milkdrop failed to configure mapped window: ${error.message}`);
        }
    }

    _findRendererProcessForWindow(window) {
        for (const process of this._rendererProcesses.values()) {
            if (process.ownsWindow(window))
                return process;
        }

        const parsedTitle = parseRendererWindowTitle(window?.title ?? null);
        if (!parsedTitle)
            return null;

        return this._rendererProcesses.get(parsedTitle.monitorIndex) ?? null;

    }

    _isRendererWindow(window) {
        try {
            if (window.title?.startsWith(RENDERER_TITLE_PREFIX))
                return true;
        } catch (_error) {
            return false;
        }

        for (const process of this._rendererProcesses.values()) {
            if (process.ownsWindow(window))
                return true;
        }

        return false;
    }

    _stopAll() {
        if (this._rendererProcesses.size === 0)
            return;

        for (const process of this._rendererProcesses.values())
            process.stop();
        this._rendererProcesses.clear();
    }

    _clearManagedWindow(window) {
        const entry = this._managedWindows.get(window);
        if (!entry)
            return;

        if (entry.unmanagedId) {
            try {
                window.disconnect(entry.unmanagedId);
            } catch (_error) {
            }
        }
        entry.managedWindow?.disconnect?.();
        entry.process?.clearWindowManaged?.();
        this._managedWindows.delete(window);
    }

    _clearManagedWindows() {
        for (const window of this._managedWindows.keys())
            this._clearManagedWindow(window);
    }

    _getPresetRotationMode() {
        const mode = this._getStringSetting('preset-rotation-mode', 'random');
        return VALID_ROTATION_MODES.has(mode) ? mode : 'random';
    }

    _getBooleanSetting(key, fallback) {
        if (!this._settings || !this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_boolean(key);
        } catch (_error) {
            return fallback;
        }
    }

    _getIntSetting(key, fallback) {
        if (!this._settings || !this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_int(key);
        } catch (_error) {
            return fallback;
        }
    }

    _getDoubleSetting(key, fallback) {
        if (!this._settings || !this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_double(key);
        } catch (_error) {
            return fallback;
        }
    }

    _getStringSetting(key, fallback) {
        if (!this._settings || !this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_string(key);
        } catch (_error) {
            return fallback;
        }
    }

    _getStrvSetting(key, fallback = []) {
        if (!this._settings || !this._hasSettingKey(key))
            return Array.isArray(fallback) ? fallback : [];

        try {
            return this._settings.get_strv(key) ?? fallback;
        } catch (_error) {
            return Array.isArray(fallback) ? fallback : [];
        }
    }

    _hasSettingKey(key) {
        if (!this._settings)
            return false;
        try {
            const schema = this._settings.settings_schema ?? this._settings.get_settings_schema?.();
            return Boolean(schema?.has_key?.(key));
        } catch (_error) {
            return false;
        }
    }
}
