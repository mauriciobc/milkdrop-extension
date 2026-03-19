import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import GstApp from 'gi://GstApp?version=1.0';

const SPECTRUM_THRESHOLD_DB = -80;
const SPECTRUM_THRESHOLD_DB_ABS = 80;
const FEATURE_DECAY = 0.82;
const FEATURE_SMOOTHING = 0.35;
const SPECTRUM_BANDS = 24;
const SPECTRUM_INTERVAL_NS = 50_000_000;
const SPECTRUM_INTERVAL_MS = SPECTRUM_INTERVAL_NS / 1_000_000;
const BEAT_HISTORY_SIZE = Math.max(5, Math.ceil(1000 / SPECTRUM_INTERVAL_MS));
const BEAT_COOLDOWN_FRAMES = Math.max(1, Math.ceil(100 / SPECTRUM_INTERVAL_MS));
const BEAT_WARMUP_FRAMES = 5;
const BEAT_NOISE_FLOOR = 0.001;
const BEAT_THRESHOLD_LOW = 1.2;
const BEAT_THRESHOLD_HIGH = 1.55;
const BEAT_THRESHOLD_VARIANCE_SLOPE = -15;
const SIGNAL_TIMEOUT_USEC = 750_000;
const DEFAULT_PULSE_MONITOR = '@DEFAULT_MONITOR@';
const DEFAULT_MAX_PIPELINE_RESTARTS = 3;
const RESTART_WINDOW_USEC = 15_000_000;
const RESTART_DELAY_MSEC = 400;
const DEFAULT_SOURCE_REPROBE_DELAY_MSEC = 2500;
const MIN_SOURCE_REPROBE_DELAY_MSEC = 250;
const MAX_REPROBE_DELAY_MSEC = 60_000;
const MAX_REPROBE_FAILURES = 10;
const PARSER_ERROR_LOG_INTERVAL = 120;
const BUS_POLL_MAX_MESSAGES = 20;
const SETTINGS_DEBOUNCE_MSEC = 500;
const PCM_SAMPLES = 576;
const SNAPSHOT_INTERVAL_USEC = 5_000_000;
const STUB_SOURCE = {source: 'stub', element: 'audiotestsrc wave=silence is-live=true'};
const PIPELINE_KEYS = new Set(['audio-source', 'audio-restart-max-attempts', 'audio-reprobe-delay-ms']);

let gstInitialized = false;

function ensureGstInit() {
    if (!gstInitialized) {
        Gst.init(null);
        gstInitialized = true;
    }
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Converts a normalised [0,1] spectrum value back to linear amplitude.
function normToLinear(n) {
    return n <= 0 ? 0 : Math.pow(10, (n * SPECTRUM_THRESHOLD_DB_ABS + SPECTRUM_THRESHOLD_DB) / 20);
}

// Normalise a dB value into [0,1] clamped range.
function normDb(value) {
    if (!Number.isFinite(value))
        return 0;
    const n = (value - SPECTRUM_THRESHOLD_DB) / SPECTRUM_THRESHOLD_DB_ABS;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

function avgSlice(values, start, end) {
    if (!values || end <= start)
        return 0;
    const safeEnd = end > values.length ? values.length : end;
    let sum = 0;
    for (let i = start; i < safeEnd; i++)
        sum += values[i];
    return safeEnd > start ? sum / (safeEnd - start) : 0;
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

// Throttled error counter — returns true when the message should be logged.
function shouldLogError(count) {
    return count === 1 || count % PARSER_ERROR_LOG_INTERVAL === 0;
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
        this._noSpectrumWarnId = 0;
        this._appsinkPollId = 0;
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._totalReprobeFailures = 0;
        this._activeSource = 'stub';
        this._lastUpdateUsec = 0;
        this._spectrumCount = 0;
        this._spectrumEmptyCount = 0;
        this._lastSnapshotUsec = 0;
        this._parserErrors = 0;
        this._variantErrors = 0;
        this._loggedNonSpectrumElement = false;
        this._notifiedKeys = new Set();

        // Beat detection ring buffers — Float64Array avoids boxing overhead
        this._energyHist = new Float64Array(BEAT_HISTORY_SIZE);
        this._bassHist = new Float64Array(BEAT_HISTORY_SIZE);
        this._histCount = 0;
        this._histWrite = 0;
        this._beatCooldown = 0;

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
        if (this._log.info)
            this._log.info(`milkdrop audio disabling after ${this._spectrumCount} spectrum messages`);
        this._enabled = false;
        this._spectrumCount = 0;
        this._spectrumEmptyCount = 0;
        this._lastSnapshotUsec = 0;
        this._resetBeat();
        this._stopPipeline();
        this._features = this._defaultFeatures(this._features.source);
        this._notifiedKeys.clear();
        this._totalReprobeFailures = 0;
        this._settingsDebounceId = clearGSource(this._settingsDebounceId);
    }

    get enabled() {
        return this._enabled;
    }

    getFeatures() {
        const s = Math.max(0.1, this._getSetting('double', 'audio-sensitivity', 1.0));
        const active = this._enabled && this._hasRecentSignal();
        if (!active && this._histCount > 0)
            this._resetBeat();

        const f = this._features;
        const s07 = s * 0.7;
        return {
            source: f.source,
            active,
            energy: clamp01(f.energy * s),
            bass: clamp01(f.bass * s),
            mid: clamp01(f.mid * s),
            high: clamp01(f.high * s),
            treb: clamp01(f.high * s),
            bass_att: clamp01(f.bass * s07),
            mid_att: clamp01(f.mid * s07),
            treb_att: clamp01(f.high * s07),
            beat: active ? clamp01(f.beat) : 0,
            decay: clamp01(f.decay * s),
            waveData: f.waveData,
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
                this._loggedNonSpectrumElement = false;
                this._activeSource = c.source;
                this._features.source = c.source;
                this._features.active = false;
                if (this._log.warn)
                    this._log.warn(`milkdrop audio pipeline started source=${c.source} → PLAYING`);

                if (c.source === 'stub') {
                    this._scheduleReprobe();
                } else {
                    this._clearReprobe();
                    this._spectrumCount = 0;
                    this._spectrumEmptyCount = 0;
                }

                this._attachBus();
                this._noSpectrumWarnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._noSpectrumWarnId = 0;
                    if (!this._enabled)
                        return GLib.SOURCE_REMOVE;
                        if (this._log.warn)
                        this._log.warn(`milkdrop audio: 2s check — pipeline=${!!this._pipeline} spectrumCount=${this._spectrumCount}`);
                    if (this._pipeline && this._spectrumCount === 0)
                                if (this._log.warn)
                            this._log.warn('milkdrop audio: no spectrum messages received after 2s');
                    return GLib.SOURCE_REMOVE;
                });
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
        this._noSpectrumWarnId = clearGSource(this._noSpectrumWarnId);
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
        this._resetBeat();
    }

    _pipelineDesc(srcElement) {
        return `${srcElement} ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! tee name=t ! queue leaky=downstream max-size-buffers=2 ! spectrum bands=${SPECTRUM_BANDS} threshold=${SPECTRUM_THRESHOLD_DB} post-messages=true interval=${SPECTRUM_INTERVAL_NS} ! fakesink sync=false t. ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! appsink name=waveform_appsink emit-signals=false sync=false max-buffers=2 drop=true`;
    }

    _schedulePipelineRestart(reason) {
        this._scheduleRestart(reason);
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
                this._logger.debug?.(`milkdrop audio bus disconnect error: ${e.message}`);
            }
        }
        this._busSignalHandlerId = 0;
        if (this._bus && this._busSignalWatchEnabled) {
            try { this._bus.remove_signal_watch?.(); } catch (e) {
                this._logger.debug?.(`milkdrop audio bus remove_signal_watch error: ${e.message}`);
            }
        }
        this._busSignalWatchEnabled = false;
    }

    _onBusMessage(message) {
        switch (message.type) {
        case Gst.MessageType.ELEMENT: {
            const st = message.get_structure();
            if (!st || st.get_name() !== 'spectrum') {
                if (!this._loggedNonSpectrumElement) {
                    this._loggedNonSpectrumElement = true;
                        if (this._log.warn)
                        this._log.warn(`milkdrop audio: unexpected ELEMENT name="${st?.get_name() ?? 'null'}"`);
                }
                break;
            }
            this._onSpectrum(st);
            break;
        }
        case Gst.MessageType.ERROR: {
            const [err, dbg] = message.parse_error();
            const msg = err?.message ?? 'unknown';
            if (this._log.warn)
                this._log.warn(`milkdrop audio bus error: ${msg}${dbg ? ` debug=${dbg}` : ''}`);
            this._resetBeat();
            this._features = this._defaultFeatures(this._activeSource || 'stub');
            this._lastUpdateUsec = 0;
            this._schedulePipelineRestart(dbg ? `${msg} (${dbg})` : msg);
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

    // ── Spectrum processing (hot path) ──────────────────────────

    _onSpectrum(structure) {
        if (!this._enabled)
            return;

        const bands = this._parseMagnitude(structure);
        if (!bands) {
            this._spectrumEmptyCount += 1;
            if (this._spectrumEmptyCount === 1 || this._spectrumEmptyCount % 60 === 0)
                if (this._log.info)
                    this._log.info(`milkdrop audio spectrum empty count=${this._spectrumEmptyCount}`);
            return;
        }

        const now = GLib.get_monotonic_time();
        if (this._lastUpdateUsec && now - this._lastUpdateUsec >= SIGNAL_TIMEOUT_USEC)
            this._resetBeat();

        const len = bands.length;
        const third = Math.max(1, (len / 3) | 0);
        const bass = avgSlice(bands, 0, third);
        const mid = avgSlice(bands, third, third * 2);
        const high = avgSlice(bands, third * 2, len);

        // Full-band energy — inline sum avoids a second iteration
        let eSum = 0;
        for (let i = 0; i < len; i++)
            eSum += bands[i];
        const energy = eSum / len;

        // Linear amplitude for beat detection
        const linE = normToLinear(energy);
        const linB = normToLinear(bass);
        this._pushHist(linE, linB);

        let beat = 0;
        if (this._beatCooldown > 0) {
            this._beatCooldown -= 1;
        } else if (this._histCount >= BEAT_WARMUP_FRAMES) {
            beat = this._detectBeat(linE, linB);
        }

        const f = this._features;
        const decay = energy > f.decay * FEATURE_DECAY ? energy : f.decay * FEATURE_DECAY;

        this._spectrumCount += 1;

        // First spectrum: confirm audio is real, reset budgets
        if (this._spectrumCount === 1) {
            this._restartAttempts = 0;
            this._restartWindowStartUsec = 0;
            this._totalReprobeFailures = 0;
            const src = this._activeSource || 'stub';
            if (this._log.warn)
                this._log.warn(`milkdrop audio first spectrum source=${src} bands=${len}`);
            const raw = structure.to_string?.() ?? '';
            if (this._log.warn)
                this._log.warn(`milkdrop audio first spectrum raw (300): ${raw.slice(0, 300)}`);
        }

        // Periodic snapshot
        if (now - this._lastSnapshotUsec >= SNAPSHOT_INTERVAL_USEC) {
            this._lastSnapshotUsec = now;
            if (this._log.debug)
                this._log.debug(`milkdrop audio #${this._spectrumCount} E=${energy.toFixed(3)} B=${bass.toFixed(3)} M=${mid.toFixed(3)} H=${high.toFixed(3)} beat=${beat}`);
        }

        // Smoothed feature update (mutate in place — no object spread on hot path)
        const sm = FEATURE_SMOOTHING;
        f.source = this._activeSource || 'stub';
        f.active = true;
        f.energy += (energy - f.energy) * sm;
        f.bass += (bass - f.bass) * sm;
        f.mid += (mid - f.mid) * sm;
        f.high += (high - f.high) * sm;
        f.beat = beat;
        f.decay = decay;
        this._lastUpdateUsec = now;

        // Debug sample every 50 frames
        if (this._spectrumCount % 50 === 0) {
            const out = this.getFeatures();
            if (this._log.warn)
                this._log.warn(
                    `milkdrop audio #${this._spectrumCount} raw E=${energy.toFixed(3)} B=${bass.toFixed(3)} M=${mid.toFixed(3)} H=${high.toFixed(3)} → out E=${out.energy.toFixed(3)} B=${out.bass.toFixed(3)} M=${out.mid.toFixed(3)} H=${out.high.toFixed(3)}`
                );
        }

        // Beat debug logging (restored from Version 1)
        if (beat && GLib.getenv('MILKDROP_DEBUG_BEAT') === '1') {
            if (this._log.warn)
                this._log.warn(`milkdrop beat #${this._spectrumCount} detected`);
        }
    }

    // ── Beat detection ──────────────────────────────────────────

    _detectBeat(linE, linB) {
        const avgE = this._avgHist(this._energyHist);
        const avgB = this._avgHist(this._bassHist);
        if (avgE <= BEAT_NOISE_FLOOR && avgB <= BEAT_NOISE_FLOOR)
            return 0;

        const varE = this._varHist(this._energyHist, avgE);
        const varB = this._varHist(this._bassHist, avgB);
        const cvE = avgE > 0 ? varE / (avgE * avgE) : 0;
        const cvB = avgB > 0 ? varB / (avgB * avgB) : 0;

        const thE = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * cvE + BEAT_THRESHOLD_HIGH));
        const thB = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * cvB + BEAT_THRESHOLD_HIGH));

        const eBeat = (linE - BEAT_NOISE_FLOOR) > thE * avgE && avgE > BEAT_NOISE_FLOOR;
        const bBeat = (linB - BEAT_NOISE_FLOOR) > thB * avgB && avgB > BEAT_NOISE_FLOOR;

        // Debug logging for beat detection analysis
        if (GLib.getenv('MILKDROP_DEBUG_BEAT') === '1') {
            const debugBeat = eBeat || bBeat;
            if (debugBeat || this._spectrumCount % 20 === 0) {
                if (this._log.warn)
                    this._log.warn(
                        `milkdrop beat debug #${this._spectrumCount}: ` +
                        `linE=${linE.toFixed(6)} linB=${linB.toFixed(6)} ` +
                        `avgE=${avgE.toFixed(6)} avgB=${avgB.toFixed(6)} ` +
                        `cvE=${cvE.toFixed(4)} cvB=${cvB.toFixed(4)} ` +
                        `thE=${thE.toFixed(3)} thB=${thB.toFixed(3)} ` +
                        `eBeat=${eBeat} bBeat=${bBeat}`
                    );
            }
        }

        if (eBeat || bBeat) {
            this._beatCooldown = BEAT_COOLDOWN_FRAMES;
            if (this._log.info)
                this._log.info(`milkdrop beat #${this._spectrumCount} (energy=${eBeat} bass=${bBeat})`);
            return 1;
        }
        return 0;
    }

    _pushHist(energy, bass) {
        this._energyHist[this._histWrite] = energy;
        this._bassHist[this._histWrite] = bass;
        this._histWrite = (this._histWrite + 1) % BEAT_HISTORY_SIZE;
        if (this._histCount < BEAT_HISTORY_SIZE)
            this._histCount += 1;
    }

    _avgHist(buf) {
        const n = this._histCount;
        if (n === 0) return 0;
        let sum = 0;
        const base = (this._histWrite - n + BEAT_HISTORY_SIZE) % BEAT_HISTORY_SIZE;
        for (let i = 0; i < n; i++)
            sum += buf[(base + i) % BEAT_HISTORY_SIZE];
        return sum / n;
    }

    _varHist(buf, mean) {
        const n = this._histCount;
        if (n === 0) return 0;
        let sum = 0;
        const base = (this._histWrite - n + BEAT_HISTORY_SIZE) % BEAT_HISTORY_SIZE;
        for (let i = 0; i < n; i++) {
            const d = buf[(base + i) % BEAT_HISTORY_SIZE] - mean;
            sum += d * d;
        }
        return sum / n;
    }

    _resetBeat() {
        this._energyHist.fill(0);
        this._bassHist.fill(0);
        this._histCount = 0;
        this._histWrite = 0;
        this._beatCooldown = 0;
        this._features.beat = 0;
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

            const fmtResult = st.get_string('format');
            const [okF, fmt] = Array.isArray(fmtResult) ? fmtResult : [fmtResult !== null, fmtResult];
            const chResult = st.get_int('channels');
            const [okC, ch] = Array.isArray(chResult) ? chResult : [chResult !== null, chResult];
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
        } finally {
            buffer.unmap(map);
        }
    }

    // ── Spectrum magnitude parsing ──────────────────────────────

    _parseMagnitude(structure) {
        try {
            // Strategy 1: get_list (modern GJS)
            if (typeof structure.get_list === 'function') {
                const result = structure.get_list('magnitude');
                if (result?.[0] === true && result[1]?.n_values > 0)
                    return this._channelsToNorm(this._readValueArray(result[1]));
            }

            // Strategy 2: get_array (older GJS)
            if (typeof structure.get_array === 'function') {
                let arr = structure.get_array('magnitude');
                if (Array.isArray(arr) && arr.length === 2 && typeof arr[0] === 'boolean')
                    arr = arr[0] ? arr[1] : null;
                if (arr?.length > 0)
                    return this._channelsToNorm(Array.from(arr).map(v => this._readVariant(v)).filter(a => a.length > 0));
            }

            // Strategy 3: get_value (GVariant)
            const val = structure.get_value?.('magnitude');
            if (val && typeof val.n_children === 'function') {
                const channels = [];
                for (let i = 0, n = val.n_children(); i < n; i++) {
                    const child = val.get_child(i);
                    if (child !== null) {
                        const floats = this._readVariant(child);
                        if (floats.length > 0)
                            channels.push(floats);
                    }
                }
                return channels.length > 0 ? this._mergeAndNorm(channels) : null;
            }
        } catch (e) {
            this._parserErrors += 1;
            if (shouldLogError(this._parserErrors))
                if (this._log.debug)
                    this._log.debug(`milkdrop audio structured parser error #${this._parserErrors}: ${e.message}`);
        }
        return null;
    }

    // Read a GLib.ValueArray, detecting nested (multi-channel) vs flat layout.
    _readValueArray(valArray) {
        const first = valArray.get_nth(0);
        if (first && typeof first.get_nth === 'function') {
            const channels = [];
            for (let i = 0; i < valArray.n_values; i++) {
                const ch = this._extractFloats(valArray.get_nth(i));
                if (ch.length > 0) channels.push(ch);
            }
            return channels;
        }
        const flat = this._extractFloats(valArray);
        return flat.length > 0 ? [flat] : [];
    }

    _extractFloats(valArray) {
        const out = [];
        if (!valArray?.n_values) return out;
        for (let i = 0; i < valArray.n_values; i++) {
            try {
                const v = Number(valArray.get_nth(i));
                if (Number.isFinite(v)) out.push(v);
            } catch (e) {
                this._variantErrors += 1;
                if (shouldLogError(this._variantErrors))
                        if (this._log.debug)
                        this._log.debug(`milkdrop audio value_array error #${this._variantErrors}: ${e.message}`);
            }
        }
        return out;
    }

    _readVariant(variant) {
        const out = [];
        try {
            if (typeof variant?.n_children === 'function') {
                const n = variant.n_children();
                const get = typeof variant.get_child_value === 'function'
                    ? i => variant.get_child_value(i)
                    : i => variant.get_child(i);
                for (let i = 0; i < n; i++) {
                    try {
                        const c = get.call(variant, i);
                        if (c != null) {
                            const v = Number(typeof c.get_double === 'function' ? c.get_double() : c);
                            if (Number.isFinite(v)) out.push(v);
                        }
                    } catch (e) {
                        this._variantErrors += 1;
                        if (shouldLogError(this._variantErrors))
                                        if (this._log.debug)
                                this._log.debug(`milkdrop audio variant child error #${this._variantErrors}: ${e.message}`);
                    }
                }
                return out;
            }
            if (Array.isArray(variant))
                return variant.map(v => Number(v)).filter(Number.isFinite);
            const v = Number(variant?.get_double?.() ?? variant);
            if (Number.isFinite(v)) out.push(v);
        } catch (e) {
            this._variantErrors += 1;
            if (shouldLogError(this._variantErrors))
                if (this._log.debug)
                    this._log.debug(`milkdrop audio variant parser error #${this._variantErrors}: ${e.message}`);
        }
        return out;
    }

    // Convert parsed channel bands → normalised merged output (or null).
    _channelsToNorm(channels) {
        if (!channels || channels.length === 0) return [];  // Return [] not null for empty
        if (channels.length > 1 && channels.some(c => c.length > 1))
            return this._mergeAndNorm(channels);
        if (channels.length > 1)
            return channels.map(c => normDb(c[0])).filter(Number.isFinite);
        return channels[0].map(normDb).filter(Number.isFinite);
    }

    _mergeAndNorm(channels) {
        const len = Math.min(...channels.map(c => c.length));
        if (len === 0) return [];
        const out = new Array(len);
        for (let i = 0; i < len; i++) {
            let sum = 0, n = 0;
            for (const ch of channels) {
                if (Number.isFinite(ch[i])) { sum += ch[i]; n += 1; }
            }
            out[i] = normDb(n > 0 ? sum / n : 0);
        }
        return out;
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
            this._log.info(`milkdrop audio reprobe in ${delay}ms (failures=${this._totalReprobeFailures})`);

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
            energy: 0, bass: 0, mid: 0, high: 0,
            beat: 0, decay: 0,
            waveData: [],
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