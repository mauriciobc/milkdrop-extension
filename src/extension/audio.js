import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

const SIGNAL_TIMEOUT_USEC = 750_000;
const DEFAULT_PULSE_MONITOR = '@DEFAULT_MONITOR@';
const DEFAULT_MAX_PIPELINE_RESTARTS = 3;
const RESTART_WINDOW_USEC = 15_000_000;
const RESTART_DELAY_MSEC = 400;
const DEFAULT_SOURCE_REPROBE_DELAY_MSEC = 2500;
const MIN_SOURCE_REPROBE_DELAY_MSEC = 250;
const MAX_REPROBE_DELAY_MSEC = 60_000;
const MAX_REPROBE_FAILURES = 10;
const BUS_POLL_MAX_MESSAGES = 20;
const SETTINGS_DEBOUNCE_MSEC = 500;
const PCM_SAMPLES = 576;
const STUB_SOURCE = {source: 'stub', element: 'audiotestsrc wave=silence is-live=true'};
const PIPELINE_KEYS = new Set(['audio-source', 'audio-restart-max-attempts', 'audio-reprobe-delay-ms']);

let gstInitialized = false;

function ensureGstInit() {
    if (!gstInitialized) {
        Gst.init(null);
        gstInitialized = true;
    }
}

function escapePipeline(value) {
    return `${value ?? ''}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// Safely remove a GLib source id and return 0.
function clearGSource(id) {
    if (id)
        GLib.source_remove(id);
    return 0;
}

function gstTupleOrScalar(value, scalarOk) {
    return Array.isArray(value) ? value : [scalarOk(value), value];
}

export class AudioEngine {
    constructor({settings = null, logger = console, onFallback = null} = {}) {
        this._settings = settings;
        this._log = logger;
        this._onFallback = onFallback;
        this._enabled = false;
        this._pipeline = null;
        this._bus = null;
        this._appsink = null;
        this._busPollId = 0;
        this._busWatchId = 0;
        this._busSignalHandlerId = 0;
        this._busSignalWatchEnabled = false;
        this._restartTimeoutId = 0;
        this._reprobeTimeoutId = 0;
        this._settingsDebounceId = 0;
        this._appsinkPollId = 0;
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._totalReprobeFailures = 0;
        this._activeSource = 'stub';
        this._lastUpdateUsec = 0;
        this._notifiedKeys = new Set();

        this._features = this._defaultFeatures('stub');
    }

    // ── Public API ──────────────────────────────────────────────

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._startPipeline('enable');
    }

    disable() {
        this._enabled = false;
        this._stopPipeline();
        this._features = this._defaultFeatures(this._features.source);
        this._notifiedKeys.clear();
        this._totalReprobeFailures = 0;
        this._settingsDebounceId = clearGSource(this._settingsDebounceId);
    }

    get enabled() {
        return this._enabled;
    }

    getDiagnostics() {
        const availability = this._getSourceBackendAvailability();
        const configuredSource = this._getSetting('string', 'audio-source', 'auto')?.trim?.() || 'auto';
        return {
            enabled: this._enabled,
            configuredSource,
            activeSource: this._activeSource,
            autoMode: configuredSource === 'auto',
            hasRecentSignal: this._hasRecentSignal(),
            restartAttempts: this._restartAttempts,
            totalReprobeFailures: this._totalReprobeFailures,
            backends: availability,
        };
    }

    getFeatures() {
        const active = this._enabled && this._hasRecentSignal();
        const f = this._features;
        return {
            source: f.source,
            active,
            pcmLeft: f.pcmLeft,
            pcmRight: f.pcmRight,
        };
    }

    handleSettingsChanged(key) {
        if (!this._enabled)
            return;
        if (typeof key === 'string' && !PIPELINE_KEYS.has(key))
            return;

        this._settingsDebounceId = clearGSource(this._settingsDebounceId);
        if (this._log.info)
            this._log.info(`milkdrop audio settings change: ${key || 'unknown'}`);
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._totalReprobeFailures = 0;
        this._notifiedKeys.clear();
        this._stopPipeline();
        this._startPipeline('settings-changed');
    }

    // ── Pipeline lifecycle ──────────────────────────────────────

    _startPipeline(reason = 'unknown') {
        this._stopPipeline();
        ensureGstInit();

        const configuredSource = this._getSetting('string', 'audio-source', 'auto');
        const sourceName = configuredSource?.trim?.() || 'auto';
        const candidates = this._buildCandidates(configuredSource);
        if (this._log.info) {
            this._log.info(
                `milkdrop audio source plan configured="${sourceName}" candidates=[${candidates.map(c => c.source).join(', ')}]`
            );
        }

        if (sourceName === 'auto' && candidates.length === 1 && candidates[0].source === 'stub') {
            this._notify('output-monitor-unavailable', 'Output Monitor Unavailable',
                'No output monitor source found. Automatic mode will keep retrying and will not fall back to microphone capture.');
        }

        for (const c of candidates) {
            const desc = this._pipelineDesc(c.element);
            try {
                if (this._log.info)
                    this._log.info(`milkdrop audio pipeline starting (${reason}): ${desc}`);
                const pipeline = Gst.parse_launch(desc);
                if (pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) {
                        if (this._log.warn)
                        this._log.warn(`milkdrop audio state change failed for source=${c.source}`);
                    pipeline.set_state(Gst.State.NULL);
                    continue;
                }

                this._pipeline = pipeline;
                this._bus = pipeline.get_bus();
                this._appsink = pipeline.get_by_name('waveform_appsink');
                if (this._appsink)
                    this._startAppsinkPoll();
                this._activeSource = c.source;
                this._features.source = c.source;
                this._features.active = false;
                if (this._log.warn)
                    this._log.warn(`milkdrop audio pipeline started source=${c.source} → PLAYING`);

                if (c.source === 'stub') {
                    this._scheduleReprobe();
                } else {
                    this._clearReprobe();
                }

                this._attachBus();
                return;
            } catch (e) {
                if (this._log.warn)
                    this._log.warn(`milkdrop audio candidate failed source=${c.source}: ${e.message}`);
            }
        }

        // All candidates failed
        this._activeSource = 'stub';
        this._features = this._defaultFeatures('stub');
        this._pipeline = null;
        this._bus = null;
        this._scheduleReprobe();
        this._notify('audio-unavailable', 'Audio Unavailable',
            'Unable to start any audio source candidate. Visuals will run without audio reactivity.');
    }

    _stopPipeline() {
        this._stopAppsinkPoll();
        this._detachBus();
        this._restartTimeoutId = clearGSource(this._restartTimeoutId);
        this._clearReprobe();

        if (this._pipeline)
            this._pipeline.set_state(Gst.State.NULL);
        this._pipeline = null;
        this._bus = null;
        this._appsink = null;
        this._lastUpdateUsec = 0;
    }

    _pipelineDesc(srcElement) {
        return `${srcElement} ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! appsink name=waveform_appsink emit-signals=false sync=false max-buffers=2 drop=true`;
    }

    _scheduleRestart(reason) {
        if (!this._enabled)
            return;

        const budget = this._getSetting('int', 'audio-restart-max-attempts', DEFAULT_MAX_PIPELINE_RESTARTS, 0, 100);
        const now = GLib.get_monotonic_time();

        if (!this._restartWindowStartUsec || now - this._restartWindowStartUsec > RESTART_WINDOW_USEC) {
            this._restartWindowStartUsec = now;
            this._restartAttempts = 0;
        }

        this._restartAttempts += 1;

        if (this._restartAttempts > budget) {
            if (this._log.warn)
                this._log.warn('milkdrop audio restart budget exhausted; entering reprobe mode');
            this._stopPipeline();
            this._restartAttempts = 0;
            this._restartWindowStartUsec = 0;
            this._activeSource = 'stub';
            this._features = this._defaultFeatures('stub');
            this._totalReprobeFailures += 1;

            if (this._isAutoMode() && this._totalReprobeFailures < MAX_REPROBE_FAILURES) {
                this._scheduleSourceReprobe();
                this._notify('audio-reprobe-mode', 'Audio Reprobe Mode',
                    'Audio monitor source is currently unavailable. Automatic mode will keep retrying in the background.');
            } else {
                this._notify('audio-disabled', 'Audio Disabled',
                    'Audio pipeline repeatedly failed and was disabled for safety. Visuals will continue without audio reactivity.');
            }
            return;
        }

        if (this._restartTimeoutId)
            return;

        if (this._log.warn)
            this._log.warn(`milkdrop audio scheduling restart #${this._restartAttempts}: ${reason}`);
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY_MSEC, () => {
            this._restartTimeoutId = 0;
            if (this._enabled)
                this._startPipeline('scheduled-restart');
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Source candidates ───────────────────────────────────────

    _getSourceBackendAvailability() {
        return {
            hasPipewire: Boolean(Gst.ElementFactory.find('pipewiresrc')),
            hasPulseSrc: Boolean(Gst.ElementFactory.find('pulsesrc')),
            hasAutoSource: Boolean(Gst.ElementFactory.find('autoaudiosrc')),
        };
    }

    _buildCandidates(configuredSource) {
        const name = configuredSource?.trim?.() || 'auto';
        const {hasPipewire: pw, hasPulseSrc: pa, hasAutoSource: auto} = this._getSourceBackendAvailability();
        const candidates = [];

        if (this._log.warn)
            this._log.warn(`milkdrop audio probe: pw=${pw} pa=${pa} auto=${auto} configured="${name}"`);

        if (name !== 'auto') {
            const pulseFirst = name.endsWith('.monitor') || name.startsWith('alsa_output.');
            const escaped = escapePipeline(name);
            const order = pulseFirst ? ['pa', 'pw'] : ['pw', 'pa'];

            for (const b of order) {
                if (b === 'pw' && pw)
                    candidates.push({source: `pipewire:${name}`, element: `pipewiresrc target-object="${escaped}" autoconnect=true do-timestamp=true`});
                if (b === 'pa' && pa)
                    candidates.push({source: `pulse:${name}`, element: `pulsesrc device="${escaped}"`});
            }

            return candidates.length > 0 ? candidates : [STUB_SOURCE];
        }

        // Auto mode: only monitor source (no mic fallback)
        if (pa) {
            candidates.push({source: 'pulse:@DEFAULT_MONITOR@', element: `pulsesrc device="${escapePipeline(DEFAULT_PULSE_MONITOR)}"`});
        } else if (pw || auto) {
            if (this._log.warn)
                this._log.warn('milkdrop audio auto: monitor unavailable; mic fallbacks disabled');
        }

        return candidates.length > 0 ? candidates : [STUB_SOURCE];
    }

    // ── Bus handling ────────────────────────────────────────────

    _attachBus() {
        this._detachBus();
        if (!this._bus)
            return;

        // Strategy 1: add_watch
        if (typeof this._bus.add_watch === 'function') {
            try {
                const id = this._bus.add_watch(GLib.PRIORITY_DEFAULT, (bus, msg) => {
                    if (!this._enabled || bus !== this._bus) {
                        this._busWatchId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._onBusMessage(msg);
                    return GLib.SOURCE_CONTINUE;
                });
                if (id) {
                    this._busWatchId = id;
                        if (this._log.warn)
                        this._log.warn('milkdrop audio bus: add_watch attached');
                    return;
                }
            } catch (e) {
                if (this._log.warn)
                    this._log.warn(`milkdrop audio add_watch unavailable: ${e.message}`);
            }
        }

        // Strategy 2: signal watch
        if (typeof this._bus.add_signal_watch === 'function' && typeof this._bus.connect === 'function') {
            try {
                this._bus.add_signal_watch();
                this._busSignalWatchEnabled = true;
                this._busSignalHandlerId = this._bus.connect('message', (bus, msg) => {
                    if (this._enabled && bus === this._bus)
                        this._onBusMessage(msg);
                });
                if (this._busSignalHandlerId) {
                        if (this._log.warn)
                        this._log.warn('milkdrop audio bus: signal watch attached');
                    return;
                }
                this._bus.remove_signal_watch?.();
                this._busSignalWatchEnabled = false;
            } catch (e) {
                if (this._log.warn)
                    this._log.warn(`milkdrop audio signal watch unavailable: ${e.message}`);
                if (this._busSignalWatchEnabled) {
                    try { this._bus.remove_signal_watch?.(); } catch (_) {}
                    this._busSignalWatchEnabled = false;
                }
                this._busSignalHandlerId = 0;
            }
        }

        // Strategy 3: polling fallback
        if (this._log.warn)
            this._log.warn('milkdrop audio bus: using polling fallback');
        this._startBusPoll();
    }

    _startBusPoll() {
        this._busPollId = clearGSource(this._busPollId);
        this._busPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._enabled || !this._bus) {
                this._busPollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let msg = this._bus.pop();
            let n = BUS_POLL_MAX_MESSAGES;
            while (msg && n-- > 0) {
                this._onBusMessage(msg);
                msg = this._bus.pop();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _detachBus() {
        this._busPollId = clearGSource(this._busPollId);
        this._busWatchId = clearGSource(this._busWatchId);
        if (this._bus && this._busSignalHandlerId) {
            try { this._bus.disconnect(this._busSignalHandlerId); } catch (e) {
                this._log.debug?.(`milkdrop audio bus disconnect error: ${e.message}`);
            }
        }
        this._busSignalHandlerId = 0;
        if (this._bus && this._busSignalWatchEnabled) {
            try { this._bus.remove_signal_watch?.(); } catch (e) {
                this._log.debug?.(`milkdrop audio bus remove_signal_watch error: ${e.message}`);
            }
        }
        this._busSignalWatchEnabled = false;
    }

    _onBusMessage(message) {
        switch (message.type) {
        case Gst.MessageType.ERROR: {
            const [err, dbg] = message.parse_error();
            const msg = err?.message ?? 'unknown';
            if (this._log.warn)
                this._log.warn(`milkdrop audio bus error: ${msg}${dbg ? ` debug=${dbg}` : ''}`);
            this._features = this._defaultFeatures(this._activeSource || 'stub');
            this._lastUpdateUsec = 0;
            this._scheduleRestart(dbg ? `${msg} (${dbg})` : msg);
            break;
        }
        case Gst.MessageType.STATE_CHANGED:
            if (message.src === this._pipeline) {
                const [, s] = message.parse_state_changed();
                if (this._log.info)
                    this._log.info(`milkdrop audio state → ${Gst.Element.state_get_name(s)}`);
            }
            break;
        default:
            break;
        }
    }

    // ── Appsink PCM waveform ────────────────────────────────────

    _startAppsinkPoll() {
        this._stopAppsinkPoll();
        if (!this._appsink || !this._enabled)
            return;
        this._appsinkPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (!this._enabled || !this._appsink) {
                this._appsinkPollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const sample = this._appsink.try_pull_sample(0);
            if (sample)
                this._readPcm(sample);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAppsinkPoll() {
        this._appsinkPollId = clearGSource(this._appsinkPollId);
    }

    _readPcm(sample) {
        const buffer = sample.get_buffer();
        if (!buffer)
            return;
        const [ok, map] = buffer.map(Gst.MapFlags.READ);
        if (!ok)
            return;

        try {
            const caps = sample.get_caps();
            const st = caps?.get_structure(0);
            if (!st) return;

            const [okF, fmt] = gstTupleOrScalar(st.get_string('format'), v => v !== null);
            const [okC, ch] = gstTupleOrScalar(st.get_int('channels'), v => v !== null);
            if (!okF || !okC) return;

            const isFloat = fmt === 'F32LE';
            if (!isFloat && fmt !== 'S16LE') return;

            const bps = isFloat ? 4 : 2;
            const count = (map.size / (bps * ch)) | 0;
            if (count <= 0) return;

            const raw = map.data.buffer ?? map.data;
            const off = map.data.byteOffset ?? map.offset ?? 0;
            const data = isFloat
                ? new Float32Array(raw, off, (map.size / 4) | 0)
                : new Int16Array(raw, off, (map.size / 2) | 0);

            const left = this._features.pcmLeft;
            const right = this._features.pcmRight;
            if (!(left instanceof Float32Array) || left.length !== PCM_SAMPLES) return;

            const scale = isFloat ? 1 : 1 / 32768.0;
            for (let i = 0; i < PCM_SAMPLES; i++) {
                const src = ((i * count) / PCM_SAMPLES) | 0;
                if (src < count) {
                    const idx = src * ch;
                    const lv = data[idx] * scale;
                    const rv = (ch >= 2 ? data[idx + 1] : data[idx]) * scale;
                    left[i] = Number.isFinite(lv) ? lv : 0;
                    right[i] = Number.isFinite(rv) ? rv : 0;
                }
            }

            // Mark signal received
            this._lastUpdateUsec = GLib.get_monotonic_time();
            this._features.active = true;
        } finally {
            buffer.unmap(map);
        }
    }

    // ── Reprobe logic ───────────────────────────────────────────

    _clearReprobe() {
        this._reprobeTimeoutId = clearGSource(this._reprobeTimeoutId);
    }

    _scheduleSourceReprobe() {
        this._scheduleReprobe();
    }

    _scheduleReprobe() {
        if (!this._enabled || !this._isAutoMode() || this._reprobeTimeoutId)
            return;

        const base = this._getSetting('int', 'audio-reprobe-delay-ms', DEFAULT_SOURCE_REPROBE_DELAY_MSEC, MIN_SOURCE_REPROBE_DELAY_MSEC, 120000);
        // Bit-shift for 2^n, capped to avoid overflow
        const delay = Math.min(MAX_REPROBE_DELAY_MSEC, base * (1 << Math.min(this._totalReprobeFailures, 15)));
        if (this._log.info)
            this._log.info(
                `milkdrop audio reprobe in ${delay}ms (failures=${this._totalReprobeFailures} activeSource=${this._activeSource})`
            );

        this._reprobeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reprobeTimeoutId = 0;
            if (!this._enabled || this._activeSource !== 'stub')
                return GLib.SOURCE_REMOVE;
            if (this._pipeline && this._hasRecentSignal())
                return GLib.SOURCE_REMOVE;
            if (this._log.info)
                this._log.info('milkdrop audio reprobe: retrying source selection');
            this._startPipeline('source-reprobe');
            return GLib.SOURCE_REMOVE;
        });
    }

    _isAutoMode() {
        return (this._getSetting('string', 'audio-source', 'auto')?.trim?.() || 'auto') === 'auto';
    }

    // ── Utilities ───────────────────────────────────────────────

    _hasRecentSignal() {
        return this._lastUpdateUsec > 0 && GLib.get_monotonic_time() - this._lastUpdateUsec < SIGNAL_TIMEOUT_USEC;
    }

    _defaultFeatures(source) {
        return {
            source,
            active: false,
            pcmLeft: new Float32Array(PCM_SAMPLES),
            pcmRight: new Float32Array(PCM_SAMPLES),
        };
    }

    _notify(key, title, body) {
        if (!this._onFallback || this._notifiedKeys.has(key))
            return;
        this._notifiedKeys.add(key);
        this._onFallback(title, body);
    }

    // Unified settings accessor — collapses three typed getters into one.
    _getSetting(type, key, fallback, min = null, max = null) {
        if (!this._hasSetting(key))
            return fallback;
        try {
            let v;
            if (type === 'int') v = this._settings.get_int(key);
            else if (type === 'double') v = this._settings.get_double(key);
            else if (type === 'string') v = this._settings.get_string(key);
            else return fallback;
            if (min !== null && v < min) v = min;
            if (max !== null && v > max) v = max;
            return v;
        } catch (_) {
            return fallback;
        }
    }

    _hasSetting(key) {
        try {
            const schema = this._settings?.settings_schema ?? this._settings?.get_settings_schema?.();
            return schema?.has_key ? Boolean(schema.has_key(key)) : Boolean(this._settings);
        } catch (_) {
            return false;
        }
    }
}
