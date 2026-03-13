import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

const SPECTRUM_THRESHOLD_DB = -80;
const FEATURE_DECAY = 0.82;
const FEATURE_SMOOTHING = 0.35;
const SPECTRUM_BANDS = 24;
const BEAT_HISTORY_SIZE = 20;
const BEAT_NOISE_FLOOR = 0.02;
const BEAT_THRESHOLD_LOW = 1.2;
const BEAT_THRESHOLD_HIGH = 1.55;
const BEAT_THRESHOLD_VARIANCE_SLOPE = -15;
const BEAT_COOLDOWN_FRAMES = 2;
const SIGNAL_TIMEOUT_USEC = 750000;
const DEFAULT_PULSE_MONITOR = '@DEFAULT_MONITOR@';
const MAX_PIPELINE_RESTARTS = 3;
const RESTART_WINDOW_USEC = 15_000_000;
const RESTART_DELAY_MSEC = 400;
const SOURCE_REPROBE_DELAY_MSEC = 2500;
const REGEX_FALLBACK_LOG_INTERVAL = 120;

let gstInitialized = false;

function ensureGstInitialized() {
    if (gstInitialized)
        return;

    Gst.init(null);
    gstInitialized = true;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function average(values) {
    if (!values || values.length === 0)
        return 0;

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, mean) {
    if (!values || values.length === 0)
        return 0;

    const m = mean ?? average(values);
    return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
}

function normalizeDecibels(value, thresholdDb) {
    if (!Number.isFinite(value))
        return 0;

    return clamp01((value - thresholdDb) / Math.abs(thresholdDb));
}

function escapePipelineString(value) {
    return `${value ?? ''}`.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export class AudioEngine {
    constructor({settings = null, logger = console, onFallback = null} = {}) {
        this._settings = settings;
        this._logger = logger;
        this._onFallback = onFallback;
        this._enabled = false;
        this._pipeline = null;
        this._bus = null;
        this._busPollId = 0;
        this._restartTimeoutId = 0;
        this._sourceReprobeTimeoutId = 0;
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._activeSourceName = 'stub';
        this._lastUpdateUsec = 0;
        this._spectrumCount = 0;
        this._spectrumEmptyCount = 0;
        this._lastSnapshotUsec = 0;
        this._spectrumParserMode = 'auto';
        this._regexFallbackCount = 0;
        this._fallbackNoticeKey = null;
        this._features = this._buildDefaultFeatures('stub', false);
        this._noSpectrumWarnId = 0;
        this._loggedNonSpectrumElement = false;
        this._energyHistory = [];
        this._bassHistory = [];
        this._beatCooldown = 0;
    }

    enable() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._startPipeline();
    }

    disable() {
        this._logger.info?.(`milkdrop audio disabling after ${this._spectrumCount} spectrum messages`);
        this._enabled = false;
        this._spectrumCount = 0;
        this._spectrumEmptyCount = 0;
        this._lastSnapshotUsec = 0;
        this._spectrumParserMode = 'auto';
        this._regexFallbackCount = 0;
        this._fallbackNoticeKey = null;
        this._resetBeatHistory();
        this._stopPipeline();
        this._features = this._buildDefaultFeatures(this._features.source, false);
    }

    getFeatures() {
        const sensitivity = Math.max(0.1, this._settings?.get_double?.('audio-sensitivity') ?? 1.0);
        const hasRecentSignal = this._enabled && this._hasRecentSignal();
        if (!hasRecentSignal && this._energyHistory.length > 0)
            this._resetBeatHistory();

        const features = {
            ...this._features,
            active: hasRecentSignal,
            beat: hasRecentSignal ? this._features.beat : 0,
        };

        return {
            source: features.source,
            active: features.active,
            energy: clamp01(features.energy * sensitivity),
            bass: clamp01(features.bass * sensitivity),
            mid: clamp01(features.mid * sensitivity),
            high: clamp01(features.high * sensitivity),
            beat: clamp01(features.beat),
            decay: clamp01(features.decay * sensitivity),
        };
    }

    _startPipeline() {
        this._stopPipeline();
        ensureGstInitialized();

        const configuredSource = this._settings?.get_string?.('audio-source') ?? 'auto';
        const sourceName = configuredSource?.trim?.() || 'auto';
        const candidates = this._buildSourceCandidates(configuredSource);
        const autoModeOnlyStub = sourceName === 'auto' && candidates.length === 1 && candidates[0].source === 'stub';

        if (autoModeOnlyStub) {
            this._notifyFallbackOnce(
                'output-monitor-unavailable',
                'Output Monitor Unavailable',
                'No output monitor source found. Automatic mode will keep retrying and will not fall back to microphone capture.'
            );
        }

        for (const candidate of candidates) {
            const description = this._buildPipelineDescription(candidate.element);

            try {
                this._logger.info?.(`milkdrop audio pipeline starting: ${description}`);
                const pipeline = Gst.parse_launch(description);
                const stateChange = pipeline.set_state(Gst.State.PLAYING);
                if (stateChange === Gst.StateChangeReturn.FAILURE) {
                    this._logger.warn?.(`milkdrop audio pipeline state change failed for source=${candidate.source}`);
                    pipeline.set_state(Gst.State.NULL);
                    continue;
                }

                this._pipeline = pipeline;
                this._bus = pipeline.get_bus();
                this._loggedNonSpectrumElement = false;
                this._activeSourceName = candidate.source;
                this._features = {
                    ...this._features,
                    source: candidate.source,
                    active: false,
                };
                this._logger.warn?.(`milkdrop audio pipeline started source=${candidate.source} → PLAYING`);
                if (candidate.source === 'stub') {
                    this._scheduleSourceReprobe();
                } else {
                    this._clearSourceReprobe();
                    this._fallbackNoticeKey = null;
                }
                this._logger.warn?.('milkdrop audio bus poll started');
                this._startBusPoll();
                this._noSpectrumWarnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._noSpectrumWarnId = 0;
                    this._logger.warn?.(
                        `milkdrop audio: 2s check fired enabled=${this._enabled} pipeline=${!!this._pipeline} spectrumCount=${this._spectrumCount}`
                    );
                    if (this._enabled && this._pipeline && this._spectrumCount === 0)
                        this._logger.warn?.('milkdrop audio: no spectrum messages received after 2s');
                    return GLib.SOURCE_REMOVE;
                });
                return;
            } catch (error) {
                this._logger.warn?.(`milkdrop audio pipeline candidate failed source=${candidate.source}: ${error.message}`);
            }
        }

        this._activeSourceName = 'stub';
        this._features = this._buildDefaultFeatures('stub', false);
        this._pipeline = null;
        this._bus = null;
        this._scheduleSourceReprobe();
        this._notifyFallbackOnce('audio-unavailable', 'Audio Unavailable',
            'Unable to start any audio source candidate. Visuals will run without audio reactivity.');
    }

    _startBusPoll() {
        if (this._busPollId)
            GLib.source_remove(this._busPollId);

        this._busPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._enabled || !this._bus) {
                this._busPollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let message = this._bus.pop();
            while (message) {
                this._handleBusMessage(message);
                message = this._bus.pop();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPipeline() {
        if (this._noSpectrumWarnId) {
            GLib.source_remove(this._noSpectrumWarnId);
            this._noSpectrumWarnId = 0;
            this._logger.warn?.('milkdrop audio: 2s spectrum timeout cancelled (pipeline stopping)');
        }
        if (this._busPollId) {
            GLib.source_remove(this._busPollId);
            this._busPollId = 0;
        }

        if (this._restartTimeoutId) {
            GLib.source_remove(this._restartTimeoutId);
            this._restartTimeoutId = 0;
        }

        this._clearSourceReprobe();

        if (this._pipeline)
            this._pipeline.set_state(Gst.State.NULL);

        this._pipeline = null;
        this._bus = null;
        this._lastUpdateUsec = 0;
        this._resetBeatHistory();
    }

    _buildPipelineDescription(sourceElement) {
        return `${sourceElement} ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! spectrum bands=${SPECTRUM_BANDS} threshold=${SPECTRUM_THRESHOLD_DB} post-messages=true interval=50000000 ! fakesink sync=false`;
    }

    _getSourceBackendAvailability() {
        return {
            hasPipewire: Boolean(Gst.ElementFactory.find('pipewiresrc')),
            hasPulseSrc: Boolean(Gst.ElementFactory.find('pulsesrc')),
            hasAutoSource: Boolean(Gst.ElementFactory.find('autoaudiosrc')),
        };
    }

    _buildSourceCandidates(configuredSource) {
        const sourceName = configuredSource?.trim?.() || 'auto';
        const {hasPipewire, hasPulseSrc, hasAutoSource} = this._getSourceBackendAvailability();
        const candidates = [];

        this._logger.warn?.(`milkdrop audio source probe: pipewiresrc=${hasPipewire} pulsesrc=${hasPulseSrc} autoaudiosrc=${hasAutoSource} configured="${sourceName}"`);

        if (sourceName !== 'auto') {
            const looksLikePulseMonitor = sourceName.endsWith('.monitor') || sourceName.startsWith('alsa_output.');
            const preferredOrder = looksLikePulseMonitor ? ['pulse', 'pipewire'] : ['pipewire', 'pulse'];

            for (const backend of preferredOrder) {
                if (backend === 'pipewire' && hasPipewire) {
                    candidates.push({
                        source: `pipewire:${sourceName}`,
                        element: `pipewiresrc target-object="${escapePipelineString(sourceName)}" autoconnect=true do-timestamp=true`,
                    });
                }
                if (backend === 'pulse' && hasPulseSrc) {
                    candidates.push({
                        source: `pulse:${sourceName}`,
                        element: `pulsesrc device="${escapePipelineString(sourceName)}"`,
                    });
                }
            }

            if (candidates.length === 0) {
                this._logger.warn?.('milkdrop audio capture unavailable: no backend available for explicit source');
                candidates.push({
                    source: 'stub',
                    element: 'audiotestsrc wave=silence is-live=true',
                });
            }

            return candidates;
        }

        // Auto mode: monitor source captures output audio (what you hear).
        if (hasPulseSrc) {
            this._logger.warn?.(`milkdrop audio using pulsesrc output monitor: ${DEFAULT_PULSE_MONITOR}`);
            candidates.push({
                source: 'pulse:@DEFAULT_MONITOR@',
                element: `pulsesrc device="${escapePipelineString(DEFAULT_PULSE_MONITOR)}"`,
            });
        }

        // Auto mode is intentionally strict: do not fall back to generic capture
        // sources because WirePlumber may route those to microphone devices.
        if (!hasPulseSrc && (hasPipewire || hasAutoSource)) {
            this._logger.warn?.('milkdrop audio auto mode: monitor capture backend unavailable; microphone fallbacks are disabled');
        }

        if (candidates.length === 0) {
            this._logger.warn?.('milkdrop audio capture unavailable: no output monitor source found');
            candidates.push({
                source: 'stub',
                element: 'audiotestsrc wave=silence is-live=true',
            });
        }

        return candidates;
    }

    _handleBusMessage(message) {
        switch (message.type) {
        case Gst.MessageType.ELEMENT: {
            const structure = message.get_structure();
            const name = structure ? structure.get_name() : null;
            if (name !== 'spectrum') {
                if (!this._loggedNonSpectrumElement) {
                    this._loggedNonSpectrumElement = true;
                    this._logger.warn?.(`milkdrop audio: ELEMENT message structure name="${name ?? 'null'}" (expected "spectrum")`);
                }
                break;
            }
            this._handleSpectrumMessage(message);
            break;
        }
        case Gst.MessageType.ERROR: {
            const [error] = message.parse_error();
            this._logger.warn?.(`milkdrop audio bus error: ${error.message}`);
            this._resetBeatHistory();
            this._features = this._buildDefaultFeatures(this._resolveActiveSourceName(), false);
            this._lastUpdateUsec = 0;
            this._schedulePipelineRestart(error.message);
            break;
        }
        case Gst.MessageType.STATE_CHANGED: {
            if (message.src === this._pipeline) {
                const [, newState] = message.parse_state_changed();
                this._logger.info?.(`milkdrop audio pipeline state → ${Gst.Element.state_get_name(newState)}`);
            }
            break;
        }
        default:
            break;
        }
    }

    _handleSpectrumMessage(message) {
        const structure = message.get_structure();
        if (!structure || structure.get_name() !== 'spectrum')
            return;

        const bands = this._parseSpectrumBands(structure);
        if (bands.length === 0) {
            // Diagnostic: spectrum message received but parsing returned no bands → _features never updated (plan: audio monitor data renderer)
            this._spectrumEmptyCount = (this._spectrumEmptyCount ?? 0) + 1;
            if (this._spectrumEmptyCount === 1 || this._spectrumEmptyCount % 60 === 0)
                this._logger.info?.(`milkdrop audio spectrum message ignored: bands.length=0 (parse failed or wrong format) count=${this._spectrumEmptyCount}`);
            return;
        }

        const nowUsec = GLib.get_monotonic_time();
        if (this._lastUpdateUsec && nowUsec - this._lastUpdateUsec >= SIGNAL_TIMEOUT_USEC)
            this._resetBeatHistory();

        const third = Math.max(1, Math.floor(bands.length / 3));
        const bass = average(bands.slice(0, third));
        const mid = average(bands.slice(third, third * 2));
        const high = average(bands.slice(third * 2));
        const energy = average(bands);

        this._energyHistory.push(energy);
        this._bassHistory.push(bass);
        if (this._energyHistory.length > BEAT_HISTORY_SIZE) {
            this._energyHistory.shift();
            this._bassHistory.shift();
        }

        let beat = 0;
        if (this._beatCooldown > 0) {
            this._beatCooldown -= 1;
        } else if (this._energyHistory.length >= 5) {
            const avgE = average(this._energyHistory);
            const avgB = average(this._bassHistory);
            const varE = variance(this._energyHistory, avgE);
            const varB = variance(this._bassHistory, avgB);
            const threshE = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * varE + BEAT_THRESHOLD_HIGH));
            const threshB = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * varB + BEAT_THRESHOLD_HIGH));
            const energyBeat = (energy - BEAT_NOISE_FLOOR) > threshE * avgE && avgE > BEAT_NOISE_FLOOR;
            const bassBeat = (bass - BEAT_NOISE_FLOOR) > threshB * avgB && avgB > BEAT_NOISE_FLOOR;
            if (energyBeat || bassBeat) {
                beat = 1;
                this._beatCooldown = BEAT_COOLDOWN_FRAMES;
            }
        }

        const decay = Math.max(energy, this._features.decay * FEATURE_DECAY);

        this._spectrumCount += 1;

        if (this._spectrumCount === 1) {
            this._logger.warn?.(`milkdrop audio first spectrum received source=${this._resolveActiveSourceName()} bands=${bands.length}`);
            const rawStruct = structure?.to_string?.() ?? '';
            this._logger.warn?.(`milkdrop audio first spectrum raw (first 300 chars): ${rawStruct.slice(0, 300)}`);
        }

        // Periodic audio snapshot every 5 seconds
        if (nowUsec - this._lastSnapshotUsec >= 5_000_000) {
            this._lastSnapshotUsec = nowUsec;
            this._logger.debug?.(
                `milkdrop audio snapshot #${this._spectrumCount} energy=${energy.toFixed(3)} bass=${bass.toFixed(3)} mid=${mid.toFixed(3)} high=${high.toFixed(3)} beat=${beat}`
            );
        }

        this._features = {
            source: this._resolveActiveSourceName(),
            active: true,
            energy: this._smooth(this._features.energy, energy),
            bass: this._smooth(this._features.bass, bass),
            mid: this._smooth(this._features.mid, mid),
            high: this._smooth(this._features.high, high),
            beat,
            decay,
        };
        this._lastUpdateUsec = nowUsec;

        if (this._spectrumCount % 50 === 0) {
            const out = this.getFeatures();
            const rawStruct = structure?.to_string?.() ?? '';
            const magnitudeSnippet = rawStruct.includes('magnitude=')
                ? rawStruct.slice(rawStruct.indexOf('magnitude='), rawStruct.indexOf('magnitude=') + 120)
                : '(no magnitude in structure)';
            this._logger.warn?.(
                `milkdrop audio sample #${this._spectrumCount} raw E=${energy.toFixed(3)} B=${bass.toFixed(3)} M=${mid.toFixed(3)} H=${high.toFixed(3)} → out E=${(out.energy ?? 0).toFixed(3)} B=${(out.bass ?? 0).toFixed(3)} M=${(out.mid ?? 0).toFixed(3)} H=${(out.high ?? 0).toFixed(3)} magnitude_snippet=${magnitudeSnippet}`
            );
        }
    }

    _parseSpectrumBands(structure) {
        if (this._spectrumParserMode === 'structured') {
            const bands = this._getMagnitudeFromStructure(structure) ?? [];
            if (bands.length >= SPECTRUM_BANDS)
                return bands;
            const fromString = this._parseSpectrumBandsFromString(structure?.to_string?.() ?? '');
            if (fromString.length >= SPECTRUM_BANDS) {
                this._spectrumParserMode = 'regex-fallback';
                this._logger.warn?.('milkdrop audio structured parser returned few bands; using regex parser');
                this._recordRegexFallbackUse(true);
                return fromString;
            }
            return bands;
        }

        if (this._spectrumParserMode === 'regex-fallback') {
            const parsed = this._parseSpectrumBandsFromString(structure?.to_string?.() ?? '');
            this._recordRegexFallbackUse(parsed.length > 0);
            return parsed;
        }

        const fromStructure = this._getMagnitudeFromStructure(structure);
        if (fromStructure && fromStructure.length >= SPECTRUM_BANDS) {
            this._spectrumParserMode = 'structured';
            return fromStructure;
        }
        if (fromStructure && fromStructure.length > 0) {
            const fromString = this._parseSpectrumBandsFromString(structure?.to_string?.() ?? '');
            if (fromString.length >= SPECTRUM_BANDS) {
                this._spectrumParserMode = 'regex-fallback';
                this._logger.warn?.('milkdrop audio structured parser returned few bands; using regex parser');
                this._recordRegexFallbackUse(true);
                return fromString;
            }
            this._spectrumParserMode = 'structured';
            return fromStructure;
        }

        this._spectrumParserMode = 'regex-fallback';
        this._logger.warn?.('milkdrop audio falling back to regex spectrum parser; performance may be reduced');
        const parsed = this._parseSpectrumBandsFromString(structure?.to_string?.() ?? '');
        this._recordRegexFallbackUse(parsed.length > 0);
        return parsed;
    }

    _parseSpectrumBandsFromString(structureString) {
        const match = structureString.match(/magnitude=\((?:float|double)\)\{([^}]*)\}/);
        if (!match)
            return [];

        return match[1]
            .split(',')
            .map(part => normalizeDecibels(Number.parseFloat(part.trim()), SPECTRUM_THRESHOLD_DB))
            .filter(value => Number.isFinite(value));
    }

    _recordRegexFallbackUse(hadBands) {
        if (!hadBands)
            return;

        this._regexFallbackCount += 1;
        if (this._regexFallbackCount === 1 || this._regexFallbackCount % REGEX_FALLBACK_LOG_INTERVAL === 0) {
            this._logger.warn?.(
                `milkdrop audio regex spectrum fallback active count=${this._regexFallbackCount}`
            );
        }
    }

    _getMagnitudeFromStructure(structure) {
        try {
            if (typeof structure.get_array === 'function') {
                const arr = structure.get_array('magnitude');
                if (!arr || arr.length === 0)
                    return null;
                const channelBands = Array.from(arr)
                    .map(value => this._extractFloatsFromVariant(value))
                    .filter(values => values.length > 0);
                if (channelBands.length === 0)
                    return null;
                const isMultiChannel = channelBands.length > 1 && channelBands.some(values => values.length > 1);
                if (isMultiChannel)
                    return this._mergeChannelBands(channelBands);
                if (channelBands.length > 1)
                    return channelBands.map(values => normalizeDecibels(values[0], SPECTRUM_THRESHOLD_DB)).filter(Number.isFinite);
                return channelBands[0].map(v => normalizeDecibels(v, SPECTRUM_THRESHOLD_DB)).filter(Number.isFinite);
            }
            const value = structure.get_value?.('magnitude');
            if (value && typeof value.n_children === 'function') {
                const n = value.n_children();
                const channelBands = [];
                for (let i = 0; i < n; i++) {
                    const child = value.get_child(i);
                    if (child === null)
                        continue;
                    const vals = this._extractFloatsFromVariant(child);
                    if (vals.length > 0)
                        channelBands.push(vals);
                }
                if (channelBands.length === 0)
                    return null;
                return this._mergeChannelBands(channelBands);
            }
        } catch (_e) {}
        return null;
    }

    _extractFloatsFromVariant(variant) {
        const out = [];
        try {
            if (typeof variant?.n_children === 'function') {
                const n = variant.n_children();
                const getChild = typeof variant.get_child_value === 'function' ? i => variant.get_child_value(i) : i => variant.get_child(i);
                for (let i = 0; i < n; i++) {
                    const c = getChild.call(variant, i);
                    if (c !== null && c !== undefined) {
                        const v = Number(typeof c?.get_double === 'function' ? c.get_double() : c);
                        if (Number.isFinite(v))
                            out.push(v);
                    }
                }
                return out;
            }
            if (Array.isArray(variant))
                return variant.map(v => Number(v)).filter(Number.isFinite);
            const v = Number(variant?.get_double?.() ?? variant);
            if (Number.isFinite(v))
                out.push(v);
        } catch (_) {}
        return out;
    }

    _mergeChannelBands(channelBands) {
        const len = Math.min(...channelBands.map(b => b.length));
        if (len === 0)
            return [];
        const merged = [];
        for (let i = 0; i < len; i++) {
            let sum = 0;
            let count = 0;
            for (const ch of channelBands) {
                if (Number.isFinite(ch[i])) {
                    sum += ch[i];
                    count += 1;
                }
            }
            merged.push(normalizeDecibels(count > 0 ? sum / count : 0, SPECTRUM_THRESHOLD_DB));
        }
        return merged.filter(Number.isFinite);
    }

    _resolveActiveSourceName() {
        return this._activeSourceName || 'stub';
    }

    _schedulePipelineRestart(reason) {
        if (!this._enabled)
            return;

        const nowUsec = GLib.get_monotonic_time();
        if (!this._restartWindowStartUsec || nowUsec - this._restartWindowStartUsec > RESTART_WINDOW_USEC) {
            this._restartWindowStartUsec = nowUsec;
            this._restartAttempts = 0;
        }

        this._restartAttempts += 1;
        if (this._restartAttempts > MAX_PIPELINE_RESTARTS) {
            this._logger.warn?.('milkdrop audio restart budget exhausted; entering monitor reprobe mode');
            this._stopPipeline();
            this._activeSourceName = 'stub';
            this._features = this._buildDefaultFeatures('stub', false);
            if (this._shouldAutoReprobe()) {
                this._scheduleSourceReprobe();
                this._notifyFallbackOnce(
                    'audio-reprobe-mode',
                    'Audio Reprobe Mode',
                    'Audio monitor source is currently unavailable. Automatic mode will keep retrying in the background.'
                );
            } else {
                this._notifyFallbackOnce(
                    'audio-disabled',
                    'Audio Disabled',
                    'Audio pipeline repeatedly failed and was disabled for safety. Visuals will continue without audio reactivity.'
                );
            }
            return;
        }

        if (this._restartTimeoutId)
            return;

        this._logger.warn?.(`milkdrop audio scheduling pipeline restart #${this._restartAttempts}: ${reason}`);
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY_MSEC, () => {
            this._restartTimeoutId = 0;
            if (!this._enabled)
                return GLib.SOURCE_REMOVE;

            this._startPipeline();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hasRecentSignal() {
        if (!this._lastUpdateUsec)
            return false;

        return GLib.get_monotonic_time() - this._lastUpdateUsec < SIGNAL_TIMEOUT_USEC;
    }

    _smooth(previous, next) {
        return previous + (next - previous) * FEATURE_SMOOTHING;
    }

    _buildDefaultFeatures(source, active) {
        return {
            source,
            active,
            energy: 0,
            bass: 0,
            mid: 0,
            high: 0,
            beat: 0,
            decay: 0,
        };
    }

    _resetBeatHistory() {
        this._energyHistory = [];
        this._bassHistory = [];
        this._beatCooldown = 0;
        this._features = {
            ...this._features,
            beat: 0,
        };
    }

    _clearSourceReprobe() {
        if (!this._sourceReprobeTimeoutId)
            return;

        GLib.source_remove(this._sourceReprobeTimeoutId);
        this._sourceReprobeTimeoutId = 0;
    }

    _scheduleSourceReprobe() {
        if (!this._enabled || !this._shouldAutoReprobe() || this._sourceReprobeTimeoutId)
            return;

        this._sourceReprobeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SOURCE_REPROBE_DELAY_MSEC, () => {
            this._sourceReprobeTimeoutId = 0;

            if (!this._enabled)
                return GLib.SOURCE_REMOVE;

            if (this._activeSourceName !== 'stub')
                return GLib.SOURCE_REMOVE;

            this._logger.info?.('milkdrop audio reprobe: retrying output monitor source selection');
            this._startPipeline();
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldAutoReprobe() {
        const configuredSource = this._settings?.get_string?.('audio-source') ?? 'auto';
        return (configuredSource?.trim?.() || 'auto') === 'auto';
    }

    _notifyFallbackOnce(key, title, body) {
        if (!this._onFallback)
            return;

        if (this._fallbackNoticeKey === key)
            return;

        this._fallbackNoticeKey = key;
        this._onFallback(title, body);
    }
}
