import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import GstApp from 'gi://GstApp?version=1.0';

const SPECTRUM_THRESHOLD_DB = -80;
const FEATURE_DECAY = 0.82;
const FEATURE_SMOOTHING = 0.35;
const SPECTRUM_BANDS = 24;
const SPECTRUM_INTERVAL_NS = 50_000_000;
const BEAT_HISTORY_MS = 1000;
const BEAT_COOLDOWN_MS = 100;
const BEAT_WARMUP_FRAMES = 5;
// History size and cooldown are derived from SPECTRUM_INTERVAL_NS so wall-clock behaviour is stable if the interval changes.
// transients that are significant in real amplitude trigger reliably.
const BEAT_NOISE_FLOOR = 0.001;
const BEAT_THRESHOLD_LOW = 1.2;
const BEAT_THRESHOLD_HIGH = 1.55;
const BEAT_THRESHOLD_VARIANCE_SLOPE = -15;
const SPECTRUM_INTERVAL_MS = SPECTRUM_INTERVAL_NS / 1_000_000;
const BEAT_HISTORY_SIZE = Math.max(5, Math.ceil(BEAT_HISTORY_MS / SPECTRUM_INTERVAL_MS));
const BEAT_COOLDOWN_FRAMES = Math.max(1, Math.ceil(BEAT_COOLDOWN_MS / SPECTRUM_INTERVAL_MS));
const SIGNAL_TIMEOUT_USEC = 750000;
const DEFAULT_PULSE_MONITOR = '@DEFAULT_MONITOR@';
const DEFAULT_MAX_PIPELINE_RESTARTS = 3;
const RESTART_WINDOW_USEC = 15_000_000;
const RESTART_DELAY_MSEC = 400;
const DEFAULT_SOURCE_REPROBE_DELAY_MSEC = 2500;
const MIN_SOURCE_REPROBE_DELAY_MSEC = 250;
const PARSER_ERROR_LOG_INTERVAL = 120;

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

function normalizedToLinear(n) {
    if (n <= 0)
        return 0;
    return Math.pow(10, (n * Math.abs(SPECTRUM_THRESHOLD_DB) + SPECTRUM_THRESHOLD_DB) / 20);
}

function average(values) {
    if (!values || values.length === 0)
        return 0;

    let sum = 0;
    for (let i = 0; i < values.length; i++)
        sum += values[i];
    return sum / values.length;
}

function averageRange(values, start, end) {
    if (!values || values.length === 0 || end <= start)
        return 0;

    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
        sum += values[i];
        count += 1;
    }
    return count > 0 ? sum / count : 0;
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
        this._busWatchId = 0;
        this._busSignalHandlerId = 0;
        this._busSignalWatchEnabled = false;
        this._restartTimeoutId = 0;
        this._sourceReprobeTimeoutId = 0;
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._activeSourceName = 'stub';
        this._lastUpdateUsec = 0;
        this._spectrumCount = 0;
        this._spectrumEmptyCount = 0;
        this._lastSnapshotUsec = 0;
        this._parserErrorCount = 0;
        this._variantErrorCount = 0;
        this._features = this._buildDefaultFeatures('stub', false);
        this._noSpectrumWarnId = 0;
        this._loggedNonSpectrumElement = false;
        this._appsinkPollId = 0;
        this._energyHistory = new Array(BEAT_HISTORY_SIZE).fill(0);
        this._bassHistory = new Array(BEAT_HISTORY_SIZE).fill(0);
        this._historyCount = 0;
        this._historyWriteIndex = 0;
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
        this._resetBeatHistory();
        this._stopPipeline();
        this._features = this._buildDefaultFeatures(this._features.source, false);
    }

    get enabled() {
        return this._enabled;
    }

    getFeatures() {
        const sensitivity = Math.max(0.1, this._getDoubleSetting('audio-sensitivity', 1.0));
        const hasRecentSignal = this._enabled && this._hasRecentSignal();
        if (!hasRecentSignal && this._historyCount > 0)
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
            treb: clamp01(features.high * sensitivity),
            bass_att: clamp01(features.bass * sensitivity * 0.7),
            mid_att: clamp01(features.mid * sensitivity * 0.7),
            treb_att: clamp01(features.high * sensitivity * 0.7),
            beat: clamp01(features.beat),
            decay: clamp01(features.decay * sensitivity),
            waveData: features.waveData || [],
            pcmLeft: features.pcmLeft || [],
            pcmRight: features.pcmRight || [],
        };
    }

    _startPipeline() {
        this._stopPipeline();
        ensureGstInitialized();

        const configuredSource = this._getStringSetting('audio-source', 'auto');
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
                this._appsink = pipeline.get_by_name('waveform_appsink');
                if (this._appsink) {
                    this._startAppsinkPoll();
                }
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
                this._attachBusListener();
                this._noSpectrumWarnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._noSpectrumWarnId = 0;
                    if (!this._enabled)
                        return GLib.SOURCE_REMOVE;
                    this._logger.warn?.(
                        `milkdrop audio: 2s check fired enabled=${this._enabled} pipeline=${!!this._pipeline} spectrumCount=${this._spectrumCount}`
                    );
                    if (this._pipeline && this._spectrumCount === 0)
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

    _attachBusListener() {
        this._detachBusListener();
        if (!this._bus)
            return;

        if (typeof this._bus.add_watch === 'function') {
            try {
                const watchId = this._bus.add_watch(GLib.PRIORITY_DEFAULT, (bus, message) => {
                    if (!this._enabled || !this._bus || bus !== this._bus) {
                        this._busWatchId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._handleBusMessage(message);
                    return GLib.SOURCE_CONTINUE;
                });
                if (watchId) {
                    this._busWatchId = watchId;
                    this._logger.warn?.('milkdrop audio bus watch attached (add_watch)');
                    return;
                }
            } catch (error) {
                this._logger.warn?.(`milkdrop audio add_watch unavailable: ${error.message}`);
            }
        }

        if (typeof this._bus.add_signal_watch === 'function' && typeof this._bus.connect === 'function') {
            try {
                this._bus.add_signal_watch();
                this._busSignalWatchEnabled = true;
                this._busSignalHandlerId = this._bus.connect('message', (bus, message) => {
                    if (!this._enabled || !this._bus || bus !== this._bus)
                        return;
                    this._handleBusMessage(message);
                });
                if (this._busSignalHandlerId) {
                    this._logger.warn?.('milkdrop audio bus watch attached (signal)');
                    return;
                }
                this._bus.remove_signal_watch?.();
                this._busSignalWatchEnabled = false;
            } catch (error) {
                this._logger.warn?.(`milkdrop audio signal watch unavailable: ${error.message}`);
                if (this._busSignalWatchEnabled) {
                    try {
                        this._bus.remove_signal_watch?.();
                    } catch (_removeError) {}
                    this._busSignalWatchEnabled = false;
                }
                this._busSignalHandlerId = 0;
            }
        }

        this._logger.warn?.('milkdrop audio bus watch unavailable; using polling fallback');
        this._startBusPoll();
    }

    _detachBusListener() {
        if (this._busPollId) {
            GLib.source_remove(this._busPollId);
            this._busPollId = 0;
        }

        if (this._busWatchId) {
            GLib.source_remove(this._busWatchId);
            this._busWatchId = 0;
        }

        if (this._bus && this._busSignalHandlerId) {
            try {
                this._bus.disconnect(this._busSignalHandlerId);
            } catch (_error) {}
        }
        this._busSignalHandlerId = 0;

        if (this._bus && this._busSignalWatchEnabled) {
            try {
                this._bus.remove_signal_watch?.();
            } catch (_error) {}
        }
        this._busSignalWatchEnabled = false;
    }

    _startAppsinkPoll() {
        this._stopAppsinkPoll();
        if (!this._appsink || !this._enabled)
            return;

        const pollIntervalMs = 20;
        this._appsinkPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollIntervalMs, () => {
            if (!this._enabled || !this._appsink) {
                this._appsinkPollId = 0;
                return GLib.SOURCE_REMOVE;
            }

            // Safe main-thread, non-blocking pull
            const sample = this._appsink.try_pull_sample(0);
            if (sample)
                this._processAppsinkSample(sample);

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAppsinkPoll() {
        if (this._appsinkPollId) {
            GLib.source_remove(this._appsinkPollId);
            this._appsinkPollId = 0;
        }
    }

    _stopPipeline() {
        if (this._noSpectrumWarnId) {
            GLib.source_remove(this._noSpectrumWarnId);
            this._noSpectrumWarnId = 0;
            this._logger.warn?.('milkdrop audio: 2s spectrum timeout cancelled (pipeline stopping)');
        }
        this._stopAppsinkPoll();
        this._detachBusListener();

        if (this._restartTimeoutId) {
            GLib.source_remove(this._restartTimeoutId);
            this._restartTimeoutId = 0;
        }

        this._clearSourceReprobe();

        if (this._pipeline)
            this._pipeline.set_state(Gst.State.NULL);

        this._pipeline = null;
        this._bus = null;
        this._appsink = null;
        this._lastUpdateUsec = 0;
        this._resetBeatHistory();
    }

    _buildPipelineDescription(sourceElement) {
        return `${sourceElement} ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! tee name=t ! queue leaky=downstream max-size-buffers=2 ! spectrum bands=${SPECTRUM_BANDS} threshold=${SPECTRUM_THRESHOLD_DB} post-messages=true interval=${SPECTRUM_INTERVAL_NS} ! fakesink sync=false t. ! queue leaky=downstream max-size-buffers=2 ! audioconvert ! audioresample ! appsink name=waveform_appsink emit-signals=false sync=false max-buffers=2 drop=true`;
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
            const [error, debug] = message.parse_error();
            const errorMessage = error?.message ?? 'unknown error';
            const debugMessage = debug ? ` debug=${debug}` : '';
            this._logger.warn?.(`milkdrop audio bus error: ${errorMessage}${debugMessage}`);
            this._resetBeatHistory();
            this._features = this._buildDefaultFeatures(this._resolveActiveSourceName(), false);
            this._lastUpdateUsec = 0;
            this._schedulePipelineRestart(debug ? `${errorMessage} (${debug})` : errorMessage);
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
        if (!this._enabled)
            return;

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
        const midStart = third;
        const highStart = third * 2;
        const bass = averageRange(bands, 0, midStart);
        const mid = averageRange(bands, midStart, highStart);
        const high = averageRange(bands, highStart, bands.length);
        const energy = average(bands);

        // Convert to linear amplitude for beat detection — dB normalization
        // compresses dynamic range so much that real transients (which are
        // large in amplitude) appear as tiny variations in [0,1] space.
        const beatEnergy = normalizedToLinear(energy);
        const beatBass = normalizedToLinear(bass);
        this._appendBeatHistory(beatEnergy, beatBass);

        let beat = 0;
        let beatDebug = null;
        const beatDebugEnabled = GLib.getenv('MILKDROP_DEBUG_BEAT') === '1';
        if (this._beatCooldown > 0) {
            this._beatCooldown -= 1;
        } else if (this._historyCount >= BEAT_WARMUP_FRAMES) {
            const avgE = this._averageHistory(this._energyHistory);
            const avgB = this._averageHistory(this._bassHistory);
            const varE = this._varianceHistory(this._energyHistory, avgE);
            const varB = this._varianceHistory(this._bassHistory, avgB);
            // Use coefficient of variation (variance / mean²) so the adaptive
            // threshold responds to *relative* dynamics, not absolute scale.
            const cvSqE = avgE > 0 ? varE / (avgE * avgE) : 0;
            const cvSqB = avgB > 0 ? varB / (avgB * avgB) : 0;
            const threshE = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * cvSqE + BEAT_THRESHOLD_HIGH));
            const threshB = Math.max(BEAT_THRESHOLD_LOW, Math.min(BEAT_THRESHOLD_HIGH, BEAT_THRESHOLD_VARIANCE_SLOPE * cvSqB + BEAT_THRESHOLD_HIGH));
            const needE = threshE * avgE;
            const needB = threshB * avgB;
            const energyBeat = (beatEnergy - BEAT_NOISE_FLOOR) > needE && avgE > BEAT_NOISE_FLOOR;
            const bassBeat = (beatBass - BEAT_NOISE_FLOOR) > needB && avgB > BEAT_NOISE_FLOOR;
            if (energyBeat || bassBeat) {
                beat = 1;
                this._beatCooldown = BEAT_COOLDOWN_FRAMES;
                this._logger.info?.(`milkdrop beat detected #${this._spectrumCount} (energyBeat=${energyBeat} bassBeat=${bassBeat})`);
            }
            if (beatDebugEnabled)
                beatDebug = { beatEnergy, beatBass, avgE, avgB, varE, varB, cvSqE, cvSqB, threshE, threshB, needE, needB, energyBeat, bassBeat, beat };
        }

        const decay = Math.max(energy, this._features.decay * FEATURE_DECAY);

        this._spectrumCount += 1;

        if (beatDebug && beatDebugEnabled) {
            const d = beatDebug;
            const show = d.beat === 1 || this._spectrumCount % 20 === 0;
            if (show)
                this._logger.warn?.(
                    `milkdrop beat #${this._spectrumCount} beat=${d.beat} linE=${d.beatEnergy.toFixed(6)} linB=${d.beatBass.toFixed(6)} avgE=${d.avgE.toFixed(6)} avgB=${d.avgB.toFixed(6)} cvE=${d.cvSqE.toFixed(4)} cvB=${d.cvSqB.toFixed(4)} threshE=${d.threshE.toFixed(3)} threshB=${d.threshB.toFixed(3)} needE=${d.needE.toFixed(6)} needB=${d.needB.toFixed(6)} E_beat=${d.energyBeat} B_beat=${d.bassBeat}`
                );
        }

        const sourceName = this._resolveActiveSourceName();
        if (this._spectrumCount === 1) {
            this._logger.warn?.(`milkdrop audio first spectrum received source=${sourceName} bands=${bands.length}`);
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

        const prevEnergy = this._features.energy;
        const prevBass = this._features.bass;
        const prevMid = this._features.mid;
        const prevHigh = this._features.high;
        this._features.source = sourceName;
        this._features.active = true;
        this._features.energy = this._smooth(prevEnergy, energy);
        this._features.bass = this._smooth(prevBass, bass);
        this._features.mid = this._smooth(prevMid, mid);
        this._features.high = this._smooth(prevHigh, high);
        this._features.beat = beat;
        this._features.decay = decay;
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

    _processAppsinkSample(sample) {
        if (!this._enabled || !sample)
            return;

        const buffer = sample.get_buffer();
        if (!buffer)
            return;

        const [success, mapInfo] = buffer.map(Gst.MapFlags.READ);
        if (!success)
            return;

        try {
            const caps = sample.get_caps();
            if (!caps)
                return;

            const structure = caps.get_structure(0);
            if (!structure)
                return;

            const formatResult = structure.get_string('format');
            const [okFormat, format] = Array.isArray(formatResult) ? formatResult : [formatResult !== null, formatResult];

            const channelsResult = structure.get_int('channels');
            const [okChannels, channels] = Array.isArray(channelsResult) ? channelsResult : [channelsResult !== null, channelsResult];

            if (!okFormat || !okChannels)
                return;

            const isFloat = format === 'F32LE';
            const isInt = format === 'S16LE';

            if (!isFloat && !isInt)
                return;

            const bytesPerSample = isFloat ? 4 : 2;
            const sampleCount = Math.floor(mapInfo.size / (bytesPerSample * channels));
            if (sampleCount <= 0)
                return;

            // Zero-copy view of GStreamer buffer (support both ArrayBuffer and TypedArray bindings)
            const rawBuffer = mapInfo.data.buffer ?? mapInfo.data;
            const rawOffset = mapInfo.data.byteOffset ?? mapInfo.offset ?? 0;
            const rawData = isFloat
                ? new Float32Array(rawBuffer, rawOffset, mapInfo.size / 4)
                : new Int16Array(rawBuffer, rawOffset, mapInfo.size / 2);

            const numSamples = Math.floor(sampleCount);
            const left = this._features.pcmLeft;
            const right = this._features.pcmRight;

            if (!(left instanceof Float32Array) || left.length !== 576 ||
                !(right instanceof Float32Array) || right.length !== 576)
                return;

            for (let i = 0; i < 576; i++) {
                const srcIdx = Math.floor((i * numSamples) / 576);
                if (srcIdx < numSamples) {
                    const lVal = rawData[srcIdx * channels];
                    const rVal = (channels >= 2) ? rawData[srcIdx * channels + 1] : lVal;
                    left[i] = isFloat ? lVal : (lVal / 32768.0);
                    right[i] = isFloat ? rVal : (rVal / 32768.0);
                }
            }
        } finally {
            buffer.unmap(mapInfo);
        }
    }

    _parseSpectrumBands(structure) {
        return this._getMagnitudeFromStructure(structure) ?? [];
    }

    _getMagnitudeFromStructure(structure) {
        try {
            if (typeof structure.get_list === 'function') {
                const listResult = structure.get_list('magnitude');
                if (listResult && listResult[0] === true) {
                    const valArray = listResult[1];
                    if (valArray && valArray.n_values > 0) {
                        const channelBands = [];
                        // Check if it's a nested array (multi-channel) or flat (single channel / merged)
                        const first = valArray.get_nth(0);
                        if (first && typeof first.get_nth === 'function') {
                            // Multi-channel (nested ValueArrays)
                            for (let i = 0; i < valArray.n_values; i++) {
                                const chArray = valArray.get_nth(i);
                                const vals = this._extractFloatsFromValueArray(chArray);
                                if (vals.length > 0)
                                    channelBands.push(vals);
                            }
                        } else {
                            // Single channel / merged (flat ValueArray)
                            const vals = this._extractFloatsFromValueArray(valArray);
                            if (vals.length > 0)
                                channelBands.push(vals);
                        }

                        if (channelBands.length === 0)
                            return null;
                        
                        const isMultiChannel = channelBands.length > 1 && channelBands.some(values => values.length > 1);
                        if (isMultiChannel)
                            return this._mergeChannelBands(channelBands);
                        if (channelBands.length > 1)
                            return channelBands.map(values => normalizeDecibels(values[0], SPECTRUM_THRESHOLD_DB)).filter(Number.isFinite);
                        return channelBands[0].map(v => normalizeDecibels(v, SPECTRUM_THRESHOLD_DB)).filter(Number.isFinite);
                    }
                }
            }

            // Fallback to get_array for older/different GJS environments
            if (typeof structure.get_array === 'function') {
                let arr = structure.get_array('magnitude');
                if (Array.isArray(arr) && arr.length === 2 && typeof arr[0] === 'boolean')
                    arr = arr[0] ? arr[1] : null;

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
        } catch (error) {
            this._parserErrorCount += 1;
            if (this._parserErrorCount === 1 || this._parserErrorCount % PARSER_ERROR_LOG_INTERVAL === 0)
                this._logger.debug?.(`milkdrop audio structured parser error #${this._parserErrorCount}: ${error.message}`);
        }
        return null;
    }

    _extractFloatsFromValueArray(valArray) {
        const out = [];
        try {
            if (valArray && valArray.n_values > 0) {
                for (let i = 0; i < valArray.n_values; i++) {
                    const v = Number(valArray.get_nth(i));
                    if (Number.isFinite(v))
                        out.push(v);
                }
            }
        } catch (error) {
            this._variantErrorCount += 1;
            if (this._variantErrorCount === 1 || this._variantErrorCount % PARSER_ERROR_LOG_INTERVAL === 0)
                this._logger.debug?.(`milkdrop audio value_array parser error #${this._variantErrorCount}: ${error.message}`);
        }
        return out;
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
        } catch (error) {
            this._variantErrorCount += 1;
            if (this._variantErrorCount === 1 || this._variantErrorCount % PARSER_ERROR_LOG_INTERVAL === 0)
                this._logger.debug?.(`milkdrop audio variant parser error #${this._variantErrorCount}: ${error.message}`);
        }
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

    _appendBeatHistory(energy, bass) {
        this._energyHistory[this._historyWriteIndex] = energy;
        this._bassHistory[this._historyWriteIndex] = bass;
        this._historyWriteIndex = (this._historyWriteIndex + 1) % BEAT_HISTORY_SIZE;
        this._historyCount = Math.min(this._historyCount + 1, BEAT_HISTORY_SIZE);
    }

    _averageHistory(history) {
        if (this._historyCount === 0)
            return 0;

        let sum = 0;
        const base = (this._historyWriteIndex - this._historyCount + BEAT_HISTORY_SIZE) % BEAT_HISTORY_SIZE;
        for (let i = 0; i < this._historyCount; i++) {
            const idx = (base + i) % BEAT_HISTORY_SIZE;
            sum += history[idx];
        }
        return sum / this._historyCount;
    }

    _varianceHistory(history, mean) {
        if (this._historyCount === 0)
            return 0;

        let sum = 0;
        const base = (this._historyWriteIndex - this._historyCount + BEAT_HISTORY_SIZE) % BEAT_HISTORY_SIZE;
        for (let i = 0; i < this._historyCount; i++) {
            const idx = (base + i) % BEAT_HISTORY_SIZE;
            const delta = history[idx] - mean;
            sum += delta * delta;
        }
        return sum / this._historyCount;
    }

    _schedulePipelineRestart(reason) {
        if (!this._enabled)
            return;

        const restartBudget = this._getIntSetting(
            'audio-restart-max-attempts',
            DEFAULT_MAX_PIPELINE_RESTARTS,
            0,
            100
        );
        const nowUsec = GLib.get_monotonic_time();
        if (!this._restartWindowStartUsec || nowUsec - this._restartWindowStartUsec > RESTART_WINDOW_USEC) {
            this._restartWindowStartUsec = nowUsec;
            this._restartAttempts = 0;
        }

        this._restartAttempts += 1;
        if (this._restartAttempts > restartBudget) {
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
            waveData: [],
            pcmLeft: new Float32Array(576),
            pcmRight: new Float32Array(576),
        };
    }

    _resetBeatHistory() {
        this._energyHistory = new Array(BEAT_HISTORY_SIZE).fill(0);
        this._bassHistory = new Array(BEAT_HISTORY_SIZE).fill(0);
        this._historyCount = 0;
        this._historyWriteIndex = 0;
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

        const reprobeDelay = this._getIntSetting(
            'audio-reprobe-delay-ms',
            DEFAULT_SOURCE_REPROBE_DELAY_MSEC,
            MIN_SOURCE_REPROBE_DELAY_MSEC,
            120000
        );

        this._sourceReprobeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, reprobeDelay, () => {
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
        const configuredSource = this._getStringSetting('audio-source', 'auto');
        return (configuredSource?.trim?.() || 'auto') === 'auto';
    }

    handleSettingsChanged(reason = 'settings-changed') {
        if (!this._enabled)
            return;

        this._logger.info?.(`milkdrop audio applying settings change: ${reason}`);
        this._restartAttempts = 0;
        this._restartWindowStartUsec = 0;
        this._stopPipeline();
        this._startPipeline();
    }

    _getIntSetting(key, fallback, min = null, max = null) {
        if (!this._hasSettingKey(key))
            return fallback;

        try {
            let value = this._settings.get_int(key);
            if (min !== null)
                value = Math.max(min, value);
            if (max !== null)
                value = Math.min(max, value);
            return value;
        } catch (_error) {
            return fallback;
        }
    }

    _getDoubleSetting(key, fallback) {
        if (!this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_double(key);
        } catch (_error) {
            return fallback;
        }
    }

    _getStringSetting(key, fallback) {
        if (!this._hasSettingKey(key))
            return fallback;

        try {
            return this._settings.get_string(key);
        } catch (_error) {
            return fallback;
        }
    }

    _hasSettingKey(key) {
        try {
            const schema = this._settings?.settings_schema ?? this._settings?.get_settings_schema?.();
            if (schema?.has_key)
                return Boolean(schema.has_key(key));
            return Boolean(this._settings);
        } catch (_error) {
            return false;
        }
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
