import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {AudioEngine} from './audio.js';
import {Evaluator} from './evaluator.js';
import {attachAudioSnapshot, attachPresetPathForHelper, snapshotAudioForFrame} from './frame-state.js';
import {IpcServer} from './ipc.js';
import {MprisWatcher} from './mpris-watcher.js';
import {perfBegin, perfEnd} from './perf.js';
import {PresetStore} from './presets.js';
import {PresetCrashQuarantine} from './preset-crash-quarantine.js';
import {shouldCommitByFrames, shouldCommitByTimeout} from './preset-probe-policy.js';
import {parseRendererWindowTitle, RENDERER_TITLE_PREFIX} from './windowTitle.js';

const HOTPLUG_RESTART_DEBOUNCE_MS = 150;
const MAX_CONSECUTIVE_CRASHES = 5;
const CRASH_WINDOW_MS = 30000;
const NOTIFICATION_COOLDOWN_MS = 10000;
const DEFAULT_BEAT_CUT_COOLDOWN_SEC = 2.0;
const MEDIA_OVERLAY_FADE_MS = 400;
const VALID_ROTATION_MODES = new Set(['random', 'sequential']);
const PROBE_MIN_STABLE_FRAMES = 20;
const PROBE_TIMEOUT_MS = 5000;
/** When MILKDROP_DEBUG_HANG=1, warn if frame pump or evaluator exceeds this (µs). */
const SLOW_FRAME_THRESHOLD_US = 50000;

const DBUS_STATUS_NAME = 'io.github.mauriciobc.Milkdrop';
const DBUS_STATUS_PATH = '/io/github/mauriciobc/Milkdrop';
const DBUS_STATUS_INTERFACE_XML = `
<node>
  <interface name="io.github.mauriciobc.Milkdrop">
    <method name="GetWindowStatus">
      <arg type="a{sv}" direction="out" name="status"/>
    </method>
  </interface>
</node>`;

function _debugIpc() {
    return GLib.getenv('MILKDROP_DEBUG_IPC') === '1';
}

function _debugHang() {
    return GLib.getenv('MILKDROP_DEBUG_HANG') === '1';
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

function _clearGlibSource(self, fieldName) {
    const id = self[fieldName];
    if (!id)
        return;
    GLib.source_remove(id);
    self[fieldName] = 0;
}

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
        _clearGlibSource(this, '_refreshSourceId');

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
    constructor({extensionPath, monitor, logger, strictRenderPath = false, textOverlayVisible = true, onNotify = null, onExit = null, onHelperCrashed = null}) {
        this._extensionPath = extensionPath;
        this._monitor = monitor;
        this._logger = logger;
        this._strictRenderPath = strictRenderPath;
        this._textOverlayVisible = Boolean(textOverlayVisible);
        this._pendingTextOverlayVisible = this._textOverlayVisible;
        this._onNotify = onNotify;
        this._onExit = onExit;
        this._onHelperCrashed = onHelperCrashed;
        this._waylandClient = null;
        this._stdout = null;
        this._cancellable = new Gio.Cancellable();
        this._running = false;
        this._stopping = false;
        this._launchPath = 'uninitialized';
        this._pendingPresetLoad = null;
        this._lastQueuedPreset = null;
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
            _clearGlibSource(this, '_killTimeoutId');
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
            const wasExpected = this._stopping;
            this._logger.warn?.(`milkdrop renderer exited monitor=${this._monitor.index} code=${code} expected=${wasExpected}`);
            this._running = false;
            this._stopping = false;
            if (!wasExpected)
                this._onExit?.(this._monitor.index);
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

        _clearGlibSource(this, '_stopIdleId');

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
            path: preset.path ?? null,
            frame: preset.frame,
            // Preserve expression payload so downstream protocol consumers can
            // access it without reloading the preset from disk.
            baseVals: preset.baseVals,
            init_eqs: preset.init_eqs,
            frame_eqs: preset.frame_eqs,
            pixel_eqs: preset.pixel_eqs,
            shapes: preset.shapes ?? preset.customShapes,
            waves: preset.waves ?? preset.customWaves,
        } : null;
        this._lastQueuedPreset = this._pendingPresetLoad;
        this._flushPendingPresetLoad();
    }

    setTextOverlayVisible(visible) {
        this._textOverlayVisible = Boolean(visible);
        this._pendingTextOverlayVisible = this._textOverlayVisible;
        this._flushPendingTextOverlaySetting();
    }

    _handleIpcMessage(message) {
        if (this._stopping || !message || typeof message !== 'object')
            return;

        switch (message.type) {
        case 'ready':
            this._logger.warn?.(`[GNOME Milkdrop] renderer IPC ready monitor=${this._monitor.index}`);
            if (!this._pendingPresetLoad && this._lastQueuedPreset)
                this._pendingPresetLoad = this._lastQueuedPreset;
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
            if (this._lastFrameStat.frameCount === 1 || this._lastFrameStat.frameCount % 300 === 0) {
                this._logger.warn?.(
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
            this._onHelperCrashed?.(message);
            break;
        case 'fps':
            this._logger.debug?.(`milkdrop renderer FPS monitor ${this._monitor.index}: ${message.value}`);
            break;
        case 'telemetry': {
            const lvl = message.level ?? 'info';
            const text = `milkdrop renderer telemetry monitor=${this._monitor.index} stage=${message.stage} ok=${message.ok ?? true} msg=${message.msg ?? ''}`;
            if (lvl === 'warn' || lvl === 'error')
                this._logger.warn?.(text);
            else
                this._logger.info?.(text);
            break;
        }
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
    constructor({extensionPath, settings, logger, gnomeShellOverride = null}) {
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._gnomeShellOverride = gnomeShellOverride ?? null;
        this._presetStore = new PresetStore({settings: this._settings, logger: this._logger, extensionPath: this._extensionPath});
        this._evaluator = new Evaluator();
        this._audioEngine = new AudioEngine({
            settings: this._settings,
            logger: this._logger,
            onFallback: (title, body) => this._notifyUser(title, body),
        });
        // Preset selection is based on external `.milk` files from
        // `preset-directory`. When none are available, we keep the renderer's
        // helper default preset and disable automatic rotation.
        this._currentPreset = null;
        // Only enable passing `presetPath` to the helper after the preset
        // has been accepted by the evaluator (prevents feeding presets that
        // may be incompatible with the evaluator/parser).
        this._helperPresetEnabled = false;
        this._crashQuarantine = new PresetCrashQuarantine();
        // Probe/graceful commit state:
        this._probeActive = false;
        this._probePresetId = null;
        this._probePreset = null;
        this._probeCrashed = false;
        this._probeFrameTarget = 0;
        this._probeTimeoutId = 0;
        this._lastStablePreset = null;
        this._presetFileCount = 0;
        this._presetEligibleFileCount = 0;
        this._quarantineDebugLoggedIds = new Set();
        // Session-only set to avoid repeated probe attempts on presets that
        // the evaluator rejects (syntax/parser/expr compilation errors).
        this._evaluatorRejectedPresetIds = new Set();
        // Fallback: last rejected preset id for selection skipping.
        this._lastRejectedPresetId = null;
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
        this._spawnedMonitorFingerprints = new Map();
        this._strictRenderPathSupported = this._hasSettingKey('strict-render-path');
        this._pauseWhenFullscreenSupported = this._hasSettingKey('pause-when-fullscreen');
        this._presetRotationModeSupported = this._hasSettingKey('preset-rotation-mode');
        this._beatCutCooldownSupported = this._hasSettingKey('beat-cut-cooldown-sec');
        this._audioRestartMaxAttemptsSupported = this._hasSettingKey('audio-restart-max-attempts');
        this._audioReprobeDelaySupported = this._hasSettingKey('audio-reprobe-delay-ms');
        this._textOverlaySupported = this._hasSettingKey('text-overlay-enabled');
        this._showOnlyWhenMediaPlayingSupported = this._hasSettingKey('show-only-when-media-playing');
        this._sequentialRotationCursor = 0;
        this._crashTimestamps = [];
        this._lastOverlayVisible = null;
        this._stopAfterFadeId = 0;
        this._dbusOwnerId = 0;
        this._dbusExportedObject = null;

        this._mprisWatcher = new MprisWatcher({
            logger: this._logger,
            onPlayingChanged: () => {
                if (this._enabled && !this._disabling)
                    this._checkVisibility();
            },
        });

        this._evaluator.loadPreset(this._currentPreset);
    }

    enable() {
        this._enabled = true;
        this._disabling = false;
        this._paused = false;
        this._crashTimestamps = [];
        this._lastOverlayVisible = null;

        this._monitorSignals.push({
            owner: Main.layoutManager,
            id: Main.layoutManager.connect('monitors-changed', () => {
                if (this._monitorsActuallyChanged())
                    this._scheduleRestart('monitors-changed');
            }),
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

        if (this._showOnlyWhenMediaPlayingSupported)
            this._settingsSignals.push(this._settings.connect('changed::show-only-when-media-playing', () => this._checkVisibility()));

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
            this._mprisWatcher.enable();
            this._exportDbusStatus();
            // Async preset-directory scan so we can initialize the renderer
            // with an actual file-backed preset (the helper only switches
            // when it receives a `presetPath` with a real file path).
            (async () => {
                const filePresetCount = await this._initialisePresetSelection();

                // When "only when media playing" is on, don't spawn until there's playback.
                const showOnlyWhenMedia = this._getBooleanSetting('show-only-when-media-playing', false);
                const shouldShowNow = !showOnlyWhenMedia || this._mprisWatcher?.hasActivePlayback;
                if (shouldShowNow)
                    this._spawnForCurrentMonitors();

                this._applyTextOverlaySetting();
                this._startFramePump();

                // Only rotate when we have at least 2 external presets.
                if (filePresetCount >= 2)
                    this._startPresetRotation();

                this._checkHelperAvailability();
                this._checkVisibility();
            })().catch(error => {
                this._logger.debug?.(`milkdrop preset init failed: ${error.message}`);
                // Still keep the renderer running with helper defaults.
                this._applyTextOverlaySetting();
                this._startFramePump();
                this._checkHelperAvailability();
                this._checkVisibility();
            });
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

        _clearGlibSource(this, '_stopAfterFadeId');
        _clearGlibSource(this, '_enableIdleId');
        _clearGlibSource(this, '_spawnRetryId');

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

        _clearGlibSource(this, '_restartTimeoutId');
        _clearGlibSource(this, '_frameSourceId');
        _clearGlibSource(this, '_presetRotationId');

        this._unexportDbusStatus();
        this._mprisWatcher?.disable();
        this._clearManagedWindows();
        this._stopAll();
        this._evaluator.destroy();
        this._crashTimestamps = [];
        this._lastOverlayVisible = null;
        this._disabling = false;
    }

    _onRendererExit(monitorIndex) {
        const process = this._rendererProcesses.get(monitorIndex);
        process?.stop();
        this._rendererProcesses.delete(monitorIndex);
        this._spawnedMonitorFingerprints.delete(monitorIndex);
        if (!this._enabled || this._disabling)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        this._crashTimestamps.push(now);
        const windowStart = now - CRASH_WINDOW_MS;
        this._crashTimestamps = this._crashTimestamps.filter(t => t >= windowStart);

        if (this._crashTimestamps.length >= MAX_CONSECUTIVE_CRASHES) {
            this._logger.warn?.(
                `milkdrop: ${this._crashTimestamps.length} crashes in ${CRASH_WINDOW_MS / 1000}s — stopping restart attempts`
            );
            return;
        }

        this._scheduleRestart('renderer-exit');
    }

    _scheduleRestart(reason) {
        if (!this._enabled || this._disabling)
            return;

        _clearGlibSource(this, '_restartTimeoutId');

        this._logger.warn?.(`milkdrop scheduling renderer restart: ${reason}`);
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOTPLUG_RESTART_DEBOUNCE_MS, () => {
            this._restartTimeoutId = 0;
            this._restartAll();
            return GLib.SOURCE_REMOVE;
        });
        if (!this._restartTimeoutId)
            this._logger.warn?.('milkdrop failed to schedule renderer restart');
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
        this._logger.warn?.(`[GNOME Milkdrop] _spawnForCurrentMonitors: ${monitors.length} monitor(s), enabledMonitors size=${enabledMonitors.size}`);

        if (monitors.length === 0) {
            _clearGlibSource(this, '_spawnRetryId');
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
                onExit: (monitorIndex) => this._onRendererExit(monitorIndex),
                onHelperCrashed: message => this._handleHelperCrashed(message),
            });
            process.launch();
            process.queuePresetLoad(this._currentPreset);
            this._rendererProcesses.set(monitor.index, process);
            this._spawnedMonitorFingerprints.set(monitor.index, `${monitor.x},${monitor.y},${monitor.width}x${monitor.height}`);
        }
    }

    _applyTextOverlaySetting() {
        const visible = this._getBooleanSetting('text-overlay-enabled', true);
        for (const process of this._rendererProcesses.values())
            process.setTextOverlayVisible(visible);
    }

    _startFramePump() {
        _clearGlibSource(this, '_frameSourceId');

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

                if (shouldCommitByFrames({
                    probeActive: this._probeActive,
                    probeCrashed: this._probeCrashed,
                    frameCounter: this._frameCounter,
                    probeFrameTarget: this._probeFrameTarget,
                })) {
                    this._commitProbe('frames');
                }

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

                const pumpEndUs = GLib.get_monotonic_time();
                perfEnd(pumpToken);
                if (_debugHang() && pumpToken && (pumpEndUs - pumpToken.start) > SLOW_FRAME_THRESHOLD_US)
                    this._logger.warn?.(`milkdrop [extension] slow frame pump: ${((pumpEndUs - pumpToken.start) / 1000).toFixed(1)}ms (may block main loop)`);
            } catch (outerError) {
                this._logger.warn?.(`milkdrop frame pump critical error: ${outerError.message}`);
            }

            return GLib.SOURCE_CONTINUE;
        });
        if (_debugIpc())
            this._logger.info?.(`milkdrop [extension] frame pump started fpsLimit=${fpsLimit} intervalMs=${intervalMs}`);
    }

    _cancelProbeTimers() {
        _clearGlibSource(this, '_probeTimeoutId');
    }

    _abortProbeAfterEvaluatorRejected(preset) {
        // Treat evaluator rejection as "bad preset" for session-only
        // quarantine. Otherwise sequential rotation can keep selecting
        // the same candidate and never progress.
        const debugId = String(preset.id);
        this._evaluatorRejectedPresetIds.add(debugId);
        this._lastRejectedPresetId = debugId;
        if (!this._quarantineDebugLoggedIds.has(debugId)) {
            this._logger.warn?.(`milkdrop quarantine debug marker: evaluator-rejected presetId=${debugId}`);
            this._quarantineDebugLoggedIds.add(debugId);
        }

        try {
            this._crashQuarantine.recordCrash(preset.id);
            const nowBlacklisted = this._crashQuarantine.isBlacklisted(preset.id);
            if (!nowBlacklisted)
                this._logger.warn?.(`milkdrop quarantine debug: evaluator-rejected presetId=${debugId} isBlacklisted=false`);
        } catch (_e) {}

        this._cancelProbeTimers();
        this._probeActive = false;
        this._probePreset = null;
        this._probePresetId = null;
        this._probeCrashed = false;
        this._probeFrameTarget = 0;

        if (this._lastStablePreset)
            this._applyPreset(this._lastStablePreset, 'probe-eval-failed');
        else {
            this._currentPreset = null;
            this._evaluator.loadPreset(null);
        }

        this._logger.warn?.(`milkdrop probe ended early: evaluator rejected presetId=${preset.id}`);

        // Important for rotation progress:
        // - helper/evaluator should remain on the last stable preset,
        // - but preset selection should move past the rejected candidate.
        this._currentPreset = preset;
        this._helperPresetEnabled = false;
    }

    _beginProbe(preset, reason = 'probe') {
        if (!preset || !preset.id)
            return false;

        if (this._probeActive) {
            // Never stack probes; caller should have checked.
            return false;
        }

        this._probeActive = true;
        this._probePreset = preset;
        this._probePresetId = preset.id;
        this._probeCrashed = false;
        this._probeFrameTarget = this._frameCounter + PROBE_MIN_STABLE_FRAMES;

        // Timeout safety: if we don't get a crash signal, still commit
        // after PROBE_TIMEOUT_MS to avoid waiting indefinitely.
        this._cancelProbeTimers();
        const startedAt = GLib.get_monotonic_time() / 1000;
        this._probeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROBE_TIMEOUT_MS, () => {
            if (!this._probeActive)
                return GLib.SOURCE_REMOVE;
            const now = GLib.get_monotonic_time() / 1000;
            if (shouldCommitByTimeout({
                probeActive: this._probeActive,
                probeCrashed: this._probeCrashed,
                nowMs: now,
                probeStartMs: startedAt,
                probeTimeoutMs: PROBE_TIMEOUT_MS,
            })) {
                this._commitProbe('timeout');
            }
            return GLib.SOURCE_REMOVE;
        });

        this._logger.warn?.(
            `milkdrop probe started presetId=${preset.id} reason=${reason} frameTarget=${this._probeFrameTarget}`
        );

        // Apply candidate as provisional; helper will load it based on
        // `evaluated.presetPath` produced by `_buildFrameState()`.
        this._applyPreset(preset, `probe:${reason}`);

        // If the evaluator rejected the preset, the helper won't load it
        // (no `presetPath`). In that case, end the probe without committing.
        if (!this._helperPresetEnabled) {
            this._abortProbeAfterEvaluatorRejected(preset);
            return false;
        }
        return true;
    }

    _commitProbe(reason = 'commit') {
        if (!this._probeActive || this._probeCrashed)
            return;

        this._cancelProbeTimers();
        this._lastStablePreset = this._probePreset;

        this._probeActive = false;
        this._probePreset = null;
        this._probePresetId = null;
        this._probeCrashed = false;
        this._probeFrameTarget = 0;

        if (this._lastStablePreset)
            this._logger.warn?.(`milkdrop probe committed stable presetId=${this._lastStablePreset.id} reason=${reason}`);
    }

    _rollbackProbe(meta = {}) {
        if (!this._probeActive)
            return;

        const crashedPresetId = this._probePresetId;

        this._probeCrashed = true;
        this._cancelProbeTimers();

        try {
            this._crashQuarantine.recordCrash(crashedPresetId);
        } catch (_e) {}

        const rollbackPreset = this._lastStablePreset ?? null;
        this._probeActive = false;
        this._probePreset = null;
        this._probePresetId = null;
        this._probeFrameTarget = 0;

        if (rollbackPreset)
            this._applyPreset(rollbackPreset, 'probe-rollback');
        else {
            this._currentPreset = null;
            this._helperPresetEnabled = false;
            this._evaluator.loadPreset(null);
        }

        this._logger.warn?.(
            `milkdrop probe rollback crashedPresetId=${crashedPresetId} stage=${meta?.stage ?? 'unknown'} msg=${meta?.msg ?? ''}`
        );
    }

    _handleHelperCrashed(message) {
        if (!this._probeActive)
            return;

        this._rollbackProbe(message);
    }

    /**
     * Initialize the selected preset based on `preset-directory` contents.
     * Returns the number of external presets found so rotation can be enabled
     * only when there are enough entries.
     */
    async _initialisePresetSelection() {
        const index = await this._presetStore.loadIndex();
        const filePresets = index.filter(entry => entry?.source === 'file');

        this._presetFileCount = filePresets.length;
        this._presetEligibleFileCount = 0;
        this._sequentialRotationCursor = 0;
        this._logger.info?.(`milkdrop presets available (external .milk): ${this._presetFileCount}`);

        // Reset probe/stability for a fresh selection pass.
        this._cancelProbeTimers();
        this._probeActive = false;
        this._probePreset = null;
        this._probePresetId = null;
        this._probeCrashed = false;
        this._probeFrameTarget = 0;
        this._lastStablePreset = null;

        if (filePresets.length === 0) {
            this._currentPreset = null;
            this._helperPresetEnabled = false;
            this._evaluator.loadPreset(null);
            return 0;
        }

        const eligiblePresets = this._crashQuarantine
            .filterEligible(filePresets)
            .filter(entry => entry?.id != null && !this._evaluatorRejectedPresetIds.has(String(entry.id)));
        this._presetEligibleFileCount = eligiblePresets.length;

        if (eligiblePresets.length === 0) {
            this._currentPreset = null;
            this._helperPresetEnabled = false;
            this._evaluator.loadPreset(null);
            return 0;
        }

        const mode = this._getPresetRotationMode();
        const initialEntry = mode === 'sequential'
            ? eligiblePresets[0]
            : eligiblePresets[Math.floor(Math.random() * eligiblePresets.length)];

        const initialPreset = await this._presetStore.loadPreset(initialEntry.id);
        // Start probe immediately. Commit happens once the helper stays alive
        // for PROBE_MIN_STABLE_FRAMES (or timeout).
        this._beginProbe(initialPreset, 'initial');
        return eligiblePresets.length;
    }

    _startPresetRotation() {
        _clearGlibSource(this, '_presetRotationId');

        // Avoid timer churn when there aren't enough eligible presets.
        if ((this._presetEligibleFileCount ?? 0) < 2)
            return;

        const intervalSec = this._getIntSetting('preset-rotation-interval', 60);
        if (intervalSec <= 0)
            return;

        this._logger.info?.(
            `milkdrop preset rotation enabled eligibleCount=${this._presetEligibleFileCount} intervalSec=${intervalSec} mode=${this._getPresetRotationMode()}`
        );

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

            if (this._probeActive)
                return;

            const fileIndex = index.filter(entry => entry?.source === 'file');
            const rotationIndex = fileIndex.length > 0 ? fileIndex : index;

            const eligibleIndex = this._crashQuarantine
                .filterEligible(rotationIndex)
                .filter(entry => entry?.id != null && !this._evaluatorRejectedPresetIds.has(String(entry.id)));
            if (eligibleIndex.length <= 1)
                return;

            const nextPresetId = this._selectNextPresetId(eligibleIndex);
            if (!this._enabled || !nextPresetId)
                return;

            this._logger.info?.(`milkdrop preset rotation tick eligible=${eligibleIndex.length} nextPresetId=${nextPresetId}`);

            const preset = await this._presetStore.loadPreset(nextPresetId);
            if (!this._enabled)
                return;

            // Probe/graceful-commit: avoid committing a preset that can crash the helper.
            this._beginProbe(preset, 'rotated');
        } catch (error) {
            this._logger.debug?.(`milkdrop preset rotation failed: ${error.message}`);
        }
    }

    _selectNextPresetId(index) {
        const mode = this._getPresetRotationMode();
        const currentId = this._currentPreset?.id != null ? String(this._currentPreset.id) : null;
        const lastRejectedId = this._lastRejectedPresetId != null ? String(this._lastRejectedPresetId) : null;
        if (mode === 'sequential') {
            let nextIndex = index.findIndex(entry => entry?.id != null && String(entry.id) === currentId);
            if (nextIndex >= 0)
                nextIndex = (nextIndex + 1) % index.length;
            else
                nextIndex = this._sequentialRotationCursor % index.length;

            this._sequentialRotationCursor = (nextIndex + 1) % index.length;

            // Skip the most recently rejected preset to avoid immediate ping-pong.
            if (lastRejectedId && index[nextIndex]?.id != null) {
                const start = nextIndex;
                do {
                    if (String(index[nextIndex].id) !== lastRejectedId)
                        return index[nextIndex]?.id ?? null;
                    nextIndex = (nextIndex + 1) % index.length;
                } while (nextIndex !== start);
            }

            return index[nextIndex]?.id ?? null;
        }

        let candidates = index.filter(entry => entry?.id != null && String(entry.id) !== currentId);
        if (lastRejectedId)
            candidates = candidates.filter(entry => String(entry.id) !== lastRejectedId);
        if (candidates.length === 0)
            candidates = index.filter(entry => entry?.id != null && String(entry.id) !== currentId);

        if (candidates.length === 0)
            return null;

        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return pick.id;
    }

    _applyPreset(preset, reason = 'updated') {
        try {
            const presetForHelper = preset ?? null;

            const blendTime = Math.max(0, this._getDoubleSetting('blend-time', 0));
            this._evaluator.loadPreset(presetForHelper, blendTime);

            this._currentPreset = presetForHelper;
            this._helperPresetEnabled = presetForHelper?.source === 'file';

            // projectM/helper will switch on the next rendered frame when
            // `presetPath` is present (derived from _currentPreset).
            for (const process of this._rendererProcesses.values())
                process.queuePresetLoad(presetForHelper);

            if (presetForHelper)
                this._logger.info?.(`milkdrop loading preset ID: ${presetForHelper.id} Name: ${presetForHelper.name} Reason: ${reason}`);
        } catch (error) {
            this._currentPreset = null;
            this._helperPresetEnabled = false;
            this._logger.warn?.(`milkdrop failed to apply preset "${preset?.name ?? 'unknown'}": ${error.message}`);
        }
    }

    async _handlePresetDirectoryChanged() {
        this._presetStore.handleSettingsChanged?.('preset-directory');
        this._sequentialRotationCursor = 0;

        if (!this._enabled || this._disabling)
            return;

        try {
            await this._initialisePresetSelection();

            if (!this._enabled || this._disabling)
                return;

            // Rotation enablement depends on preset count.
            this._startPresetRotation();
        } catch (error) {
            this._logger.debug?.(`milkdrop preset directory re-init failed: ${error.message}`);
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

        const showOnlyWhenMedia = this._getBooleanSetting('show-only-when-media-playing', false);
        if (showOnlyWhenMedia && !shouldPause) {
            if (!this._mprisWatcher?.hasActivePlayback)
                shouldPause = true;
        }

        this._paused = shouldPause;
        this._applyMediaOverlayVisibility();

        // Spawn when overlay should be visible but we have no renderers yet (e.g. first playback with "only when media", or setting turned off after deferred spawn)
        const overlayVisible = !showOnlyWhenMedia || this._mprisWatcher?.hasActivePlayback;
        if (overlayVisible && this._rendererProcesses.size === 0)
            this._spawnForCurrentMonitors();
    }

    _applyMediaOverlayVisibility() {
        if (!this._enabled || this._disabling)
            return;
        const showOnlyWhenMedia = this._getBooleanSetting('show-only-when-media-playing', false);
        const visible = !showOnlyWhenMedia || this._mprisWatcher?.hasActivePlayback;
        if (visible === this._lastOverlayVisible)
            return;
        this._lastOverlayVisible = visible;

        if (visible)
            _clearGlibSource(this, '_stopAfterFadeId');

        const targetOpacity = visible ? 255 : 0;
        const duration = MEDIA_OVERLAY_FADE_MS;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;

        /* Use opacity-only on the window actor — never set visible=false.
         * Setting visible=false on a Meta.WindowActor stops Mutter from
         * updating the compositor texture, which breaks the Clutter.Clone
         * inside LiveWallpaper (it would show a stale/black frame on re-show).
         * opacity=0 hides it visually while keeping texture updates running. */
        let matchCount = 0;
        for (const [metaWindow] of this._managedWindows) {
            try {
                const actor = metaWindow.get_compositor_private?.();
                if (!actor || _isDisposed(actor))
                    continue;
                matchCount++;
                actor.remove_all_transitions?.();
                if (typeof actor.ease === 'function') {
                    actor.ease({ opacity: targetOpacity, duration, mode });
                } else {
                    actor.opacity = targetOpacity;
                }
            } catch (_e) {}
        }

        this._logger.warn?.(`milkdrop applyVisibility: visible=${visible} matchedWindows=${matchCount} managedWindows=${this._managedWindows.size}`);
        this._gnomeShellOverride?.setMediaOverlayVisibility?.(visible);

        if (!visible && showOnlyWhenMedia && this._rendererProcesses.size > 0) {
            _clearGlibSource(this, '_stopAfterFadeId');
            this._stopAfterFadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                this._stopAfterFadeId = 0;
                if (!this._enabled || this._disabling)
                    return GLib.SOURCE_REMOVE;
                const stillVisible = !showOnlyWhenMedia || this._mprisWatcher?.hasActivePlayback;
                if (stillVisible)
                    return GLib.SOURCE_REMOVE;
                this._stopAll();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * D-Bus: return current window/overlay status (a{sv}).
     * Used by io.github.mauriciobc.Milkdrop.GetWindowStatus.
     */
    GetWindowStatus() {
        const showOnlyWhenMedia = this._getBooleanSetting('show-only-when-media-playing', false);
        const hasActivePlayback = !!this._mprisWatcher?.hasActivePlayback;
        const overlayVisible = !showOnlyWhenMedia || hasActivePlayback;
        const audioDiagnostics = this._audioEngine.getDiagnostics?.() ?? {};
        const titles = [];
        for (const [metaWindow] of this._managedWindows) {
            try {
                if (metaWindow?.get_title)
                    titles.push(metaWindow.get_title());
            } catch (e) {
                this._logger.debug?.(`milkdrop GetWindowStatus: skipped disposed window: ${e.message}`);
            }
        }
        const status = {
            Paused: GLib.Variant.new_boolean(this._paused),
            OverlayVisible: GLib.Variant.new_boolean(overlayVisible),
            ShowOnlyWhenMediaPlaying: GLib.Variant.new_boolean(showOnlyWhenMedia),
            HasActivePlayback: GLib.Variant.new_boolean(hasActivePlayback),
            RendererCount: GLib.Variant.new_uint32(this._rendererProcesses.size),
            PresetCount: GLib.Variant.new_uint32(this._presetFileCount ?? 0),
            AudioEnabled: GLib.Variant.new_boolean(Boolean(audioDiagnostics.enabled)),
            AudioConfiguredSource: GLib.Variant.new_string(String(audioDiagnostics.configuredSource ?? 'auto')),
            AudioActiveSource: GLib.Variant.new_string(String(audioDiagnostics.activeSource ?? 'stub')),
            AudioHasRecentSignal: GLib.Variant.new_boolean(Boolean(audioDiagnostics.hasRecentSignal)),
            AudioRestartAttempts: GLib.Variant.new_int32(Number(audioDiagnostics.restartAttempts ?? 0)),
            AudioReprobeFailures: GLib.Variant.new_int32(Number(audioDiagnostics.totalReprobeFailures ?? 0)),
            WindowTitles: GLib.Variant.new_strv(titles),
        };
        return new GLib.Variant('a{sv}', status);
    }

    _exportDbusStatus() {
        if (this._dbusOwnerId)
            return;
        this._dbusOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DBUS_STATUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (connection) => {
                this._dbusExportedObject = Gio.DBusExportedObject.wrapJSObject(
                    DBUS_STATUS_INTERFACE_XML,
                    this
                );
                this._dbusExportedObject.export(connection, DBUS_STATUS_PATH);
            },
            () => {},
            () => { this._logger.warn?.('milkdrop D-Bus status name lost or could not be acquired'); }
        );
    }

    _unexportDbusStatus() {
        if (this._dbusExportedObject) {
            try {
                this._dbusExportedObject.unexport();
            } catch (_e) {}
            this._dbusExportedObject = null;
        }
        if (this._dbusOwnerId) {
            Gio.bus_unown_name(this._dbusOwnerId);
            this._dbusOwnerId = 0;
        }
    }

    _readTypedSetting(key, fallback, readFn) {
        if (!this._settings || !this._hasSettingKey(key))
            return fallback;
        try {
            return readFn(this._settings, key);
        } catch (_error) {
            return fallback;
        }
    }

    _maybeRotateOnBeat(evaluated) {
        if (this._probeActive || !this._getBooleanSetting('beat-cuts-enabled', false) || !evaluated.audio?.beat)
            return;
        const now = GLib.get_monotonic_time() / 1000000;
        const cooldown = Math.max(0, this._getDoubleSetting('beat-cut-cooldown-sec', DEFAULT_BEAT_CUT_COOLDOWN_SEC));
        if (now - this._lastBeatCutTime > cooldown) {
            this._lastBeatCutTime = now;
            this._rotatePreset();
        }
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

        const audioSnapshot = snapshotAudioForFrame(baseFrameState.audio);
        const evalToken = perfBegin('evaluator');
        const evaluated = this._evaluator.evaluateFrame(baseFrameState);
        const evalEndUs = GLib.get_monotonic_time();
        perfEnd(evalToken);
        if (_debugHang() && evalToken && (evalEndUs - evalToken.start) > SLOW_FRAME_THRESHOLD_US)
            this._logger.warn?.(`milkdrop [extension] slow evaluator: ${((evalEndUs - evalToken.start) / 1000).toFixed(1)}ms (may block main loop)`);

        attachAudioSnapshot(evaluated, audioSnapshot);

        // Preset path for projectM backend.
        attachPresetPathForHelper(evaluated, this._helperPresetEnabled, this._currentPreset);

        // Beat-cut: trigger immediate preset rotation on beat if enabled.
        // Gated on !_probeActive to avoid interrupting an ongoing probe/commit sequence.
        // Cooldown is configurable for beat-cut behavior.
        this._maybeRotateOnBeat(evaluated);

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
            this._applyMediaOverlayVisibility();
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
        this._spawnedMonitorFingerprints.clear();
    }

    _monitorsActuallyChanged() {
        if (this._spawnedMonitorFingerprints.size === 0)
            return false;   // nothing spawned yet; idle callback will spawn correctly
        const monitors = Main.layoutManager.monitors;
        if (monitors.length !== this._spawnedMonitorFingerprints.size)
            return true;
        for (const monitor of monitors) {
            const fp = `${monitor.x},${monitor.y},${monitor.width}x${monitor.height}`;
            if (this._spawnedMonitorFingerprints.get(monitor.index) !== fp)
                return true;
        }
        return false;
    }

    _clearManagedWindow(window) {
        const entry = this._managedWindows.get(window);
        if (!entry)
            return;

        // Remove from map immediately so we don't double-process if re-entered.
        this._managedWindows.delete(window);

        // Defer disconnect and cleanup. Calling window.disconnect(entry.unmanagedId) from
        // within the 'unmanaged' signal callback causes g_closure_unref double-unref
        // (the emission holds a ref; we unref on disconnect; emission unrefs again).
        const capturedWindow = window;
        const capturedEntry = entry;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                if (capturedEntry.unmanagedId && !_isDisposed(capturedWindow))
                    capturedWindow.disconnect(capturedEntry.unmanagedId);
            } catch (_error) {
                this._logger.debug?.(`milkdrop window disconnect ignored: ${_error?.message}`);
            }
            capturedEntry.managedWindow?.disconnect?.();
            capturedEntry.process?.clearWindowManaged?.();
            return GLib.SOURCE_REMOVE;
        });
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
        return this._readTypedSetting(key, fallback, (s, k) => s.get_boolean(k));
    }

    _getIntSetting(key, fallback) {
        return this._readTypedSetting(key, fallback, (s, k) => s.get_int(k));
    }

    _getDoubleSetting(key, fallback) {
        return this._readTypedSetting(key, fallback, (s, k) => s.get_double(k));
    }

    _getStringSetting(key, fallback) {
        return this._readTypedSetting(key, fallback, (s, k) => s.get_string(k));
    }

    _getStrvSetting(key, fallback = []) {
        const fb = Array.isArray(fallback) ? fallback : [];
        return this._readTypedSetting(key, fb, (s, k) => s.get_strv(k) ?? fallback);
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
