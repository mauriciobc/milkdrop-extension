import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

import {AudioEngine} from '../../src/extension/audio.js';

function buildLogger(logs) {
    return {
        info: message => logs.push({level: 'info', message}),
        warn: message => logs.push({level: 'warn', message}),
        debug: message => logs.push({level: 'debug', message}),
    };
}

function makeStructuredSpectrum(values) {
    return {
        get_list(name) {
            if (name === 'magnitude') {
                return [true, {
                    n_values: values.length,
                    get_nth: i => {
                        const val = values[i];
                        if (Array.isArray(val)) {
                            return {
                                n_values: val.length,
                                get_nth: j => val[j],
                            };
                        }
                        return val;
                    },
                }];
            }
            return [false, null];
        },
        get_array(name) {
            if (name === 'magnitude')
                return values;
            return null;
        },
        to_string() {
            return 'magnitude=(float){-90.0,-90.0}';
        },
    };
}


function makeSpectrumMessage(structure) {
    return {
        get_structure() {
            return {
                ...structure,
                get_name() {
                    return 'spectrum';
                },
            };
        },
    };
}

export function run(assert) {
    // Stopping the pipeline clears beat history state to avoid stale carryover.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._energyHistory = [0.3, 0.4, 0.5];
        engine._bassHistory = [0.2, 0.25, 0.3];
        engine._beatCooldown = 2;
        engine._features = {
            ...engine._features,
            beat: 1,
        };

        engine._stopPipeline();

        assert(engine._histCount === 0, '_stopPipeline clears history sample count');
        assert(engine._beatCooldown === 0, '_stopPipeline resets beat cooldown');
        assert(engine._features.beat === 0, '_stopPipeline clears stale beat value');
    }

    // A long signal gap resets history before processing the next spectrum frame.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;
        engine._energyHistory = [0.7, 0.75, 0.72, 0.71, 0.74];
        engine._bassHistory = [0.6, 0.62, 0.63, 0.61, 0.64];
        engine._beatCooldown = 1;
        engine._features = {
            ...engine._features,
            beat: 1,
        };
        engine._lastUpdateUsec = GLib.get_monotonic_time() - 1_000_000;

        const message = makeSpectrumMessage(makeStructuredSpectrum([-40.0, -30.0, -20.0, -10.0, -20.0, -30.0]));
        engine._onSpectrum(message.get_structure());

        assert(engine._histCount === 1, 'spectrum after timeout starts a fresh history window');
        assert(engine._features.beat === 0, 'spectrum after timeout does not reuse stale beat state');
    }

    // History window stays bounded after many spectrum frames.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;
        const message = makeSpectrumMessage(makeStructuredSpectrum([-30.0, -20.0, -10.0, -20.0, -30.0, -40.0]));
        for (let i = 0; i < 100; i++)
            engine._onSpectrum(message.get_structure());

        const boundedLength = engine._histCount;
        for (let i = 0; i < 20; i++)
            engine._onSpectrum(message.get_structure());

        assert(boundedLength >= 5, 'history window has a warmup-capable minimum size');
        assert(engine._histCount === boundedLength, 'history window stays bounded over time');
    }

    // Structured parser returns expected band count and correct normalized values.
    // Mirrors the band shape GStreamer's spectrum element emits: an array of dB
    // magnitudes, each in [SPECTRUM_THRESHOLD_DB, 0]. Values at -80 are silence.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        const structured = makeStructuredSpectrum([-40.0, -20.0, -10.0]);

        const bands = engine._parseMagnitude(structured);
        const epsilon = 1e-6;

        assert(bands.length === 3, 'structured parser returns one band per magnitude element');
        // -40 dB → normalizeDecibels(-40, -80) = clamp01((-40 - -80) / 80) = 0.5
        assert(Math.abs(bands[0] - 0.5) <= epsilon, 'band at -40 dB normalizes to 0.5');
        // -20 dB → 0.75
        assert(Math.abs(bands[1] - 0.75) <= epsilon, 'band at -20 dB normalizes to 0.75');
        // -10 dB → 0.875
        assert(Math.abs(bands[2] - 0.875) <= epsilon, 'band at -10 dB normalizes to 0.875');
    }

    // Structured parser averages channelized (stereo) vectors into one value per band.
    // GStreamer's spectrum element can emit per-channel magnitude arrays; the parser
    // should average them into a single mono band array.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        const structured = makeStructuredSpectrum([[-40.0, -20.0, -10.0], [-30.0, -10.0, -30.0]]);
        const bands = engine._parseMagnitude(structured);
        const epsilon = 1e-6;

        assert(bands.length === 3, 'structured parser flattens channelized spectrum to band count');
        // Average of -40 and -30 = -35 dB → normalizeDecibels(-35, -80) = 45/80 = 0.5625
        assert(Math.abs(bands[0] - 0.5625) <= epsilon, 'band 0 matches normalized channel average for -35 dB');
        // Average of -20 and -10 = -15 dB → 65/80 = 0.8125
        assert(Math.abs(bands[1] - 0.8125) <= epsilon, 'band 1 matches normalized channel average for -15 dB');
        // Average of -10 and -30 = -20 dB → 60/80 = 0.75
        assert(Math.abs(bands[2] - 0.75) <= epsilon, 'band 2 matches normalized channel average for -20 dB');
    }

    // Structured parser accepts a single nested channel vector (mono GStreamer output).
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        const structured = makeStructuredSpectrum([[-40.0, -20.0, -10.0]]);
        const bands = engine._parseMagnitude(structured);

        assert(bands.length === 3, 'structured parser supports one nested vector of bands');
    }


    // Full 24-band GStreamer spectrum: silence bands produce 0, non-silence bands
    // are in (0, 1]. This validates the full pipeline that the real GStreamer
    // spectrum element would exercise at runtime.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        // Simulate a realistic GStreamer output: mostly silence (-80), with some
        // bass energy in the lower bands.
        const gstBands = [
            -30, -25, -35, -45, // bass region
            -55, -60, -65, -70, // low-mid
            -75, -78, -80, -80, // mid fading to threshold
            -80, -80, -80, -80, // silence
            -80, -80, -80, -80,
            -80, -80, -80, -80,
        ];
        const structured = makeStructuredSpectrum(gstBands);
        const bands = engine._parseMagnitude(structured);

        assert(bands.length === 24, 'parser returns all 24 bands for a full GStreamer spectrum');
        assert(bands.every(v => v >= 0 && v <= 1), 'all normalized bands are in [0, 1]');
        // Silence (-80 dB) must map to exactly 0
        assert(bands[11] === 0 && bands[23] === 0, 'threshold-level bands normalize to 0 (silence)');
        // Active bass bands must be strictly positive
        assert(bands[0] > 0 && bands[1] > 0, 'active bass bands normalize to positive values');
        // Frequency ordering: lower bands have more energy than upper silence bands
        assert(bands[0] > bands[23], 'bass energy exceeds silence-floor upper bands');
    }

    // Bus listener prefers add_watch and keeps polling disabled.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._bus = {
            add_watch(_priority, _callback) {
                return 42;
            },
        };

        engine._attachBus();

        assert(engine._busWatchId === 42, 'bus listener attaches add_watch when available');
        assert(engine._busPollId === 0, 'add_watch path does not start polling fallback');
    }

    // Bus listener falls back to signal watch and detaches cleanly.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        let signalWatches = 0;
        let signalRemovals = 0;
        let disconnectedId = 0;

        engine._bus = {
            add_signal_watch() {
                signalWatches += 1;
            },
            connect(_event, _callback) {
                return 13;
            },
            disconnect(id) {
                disconnectedId = id;
            },
            remove_signal_watch() {
                signalRemovals += 1;
            },
        };

        engine._attachBus();
        assert(engine._busSignalHandlerId === 13, 'signal watch path stores handler id');
        assert(engine._busSignalWatchEnabled, 'signal watch path marks signal watch as active');
        assert(signalWatches === 1, 'signal watch path enables signal emission once');

        engine._detachBus();
        assert(disconnectedId === 13, 'detaching bus listener disconnects message handler');
        assert(signalRemovals === 1, 'detaching bus listener removes signal watch');
        assert(engine._busSignalHandlerId === 0, 'detaching bus listener clears signal handler id');
        assert(!engine._busSignalWatchEnabled, 'detaching bus listener clears signal watch flag');
    }

    // Bus listener falls back to polling when watch APIs are missing.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        let pollStarted = false;
        engine._startBusPoll = () => {
            pollStarted = true;
        };
        engine._bus = {};

        engine._attachBus();

        assert(pollStarted, 'bus listener starts polling fallback when watch APIs are unavailable');
    }

    // Bus errors should include debug text in logs and restart reason.
    {
        const logs = [];
        const engine = new AudioEngine({logger: buildLogger(logs)});
        let restartReason = '';
        engine._schedulePipelineRestart = reason => {
            restartReason = reason;
        };

        engine._onBusMessage({
            type: Gst.MessageType.ERROR,
            parse_error() {
                return [{message: 'pipeline failed'}, 'Device or resource busy'];
            },
        });

        const hasDebugLog = logs.some(entry =>
            entry.level === 'warn' &&
            entry.message.includes('pipeline failed') &&
            entry.message.includes('Device or resource busy')
        );

        assert(hasDebugLog, 'bus error logging includes parse_error debug details');
        assert(restartReason.includes('Device or resource busy'), 'pipeline restart reason includes bus debug details');
    }

    // Structured/variant parser exceptions are logged in debug mode.
    {
        const logs = [];
        const engine = new AudioEngine({logger: buildLogger(logs)});

        engine._parseMagnitude({
            get_array() {
                throw new Error('broken array getter');
            },
        });
        engine._readVariant({
            n_children() {
                throw new Error('broken variant');
            },
        });

        const hasStructuredErrorLog = logs.some(entry =>
            entry.level === 'debug' &&
            entry.message.includes('structured parser error #1')
        );
        const hasVariantErrorLog = logs.some(entry =>
            entry.level === 'debug' &&
            entry.message.includes('variant parser error #1')
        );

        assert(hasStructuredErrorLog, 'structured parser exceptions emit throttled debug logs');
        assert(hasVariantErrorLog, 'variant parser exceptions emit throttled debug logs');
    }

    // Auto mode must only use output monitor capture and never generic mic-prone fallbacks.
    {
        const logs = [];
        const engine = new AudioEngine({logger: buildLogger(logs)});
        engine._getSourceBackendAvailability = () => ({
            hasPipewire: true,
            hasPulseSrc: true,
            hasAutoSource: true,
        });

        const candidates = engine._buildCandidates('auto');
        const hasMicProneFallback = candidates.some(candidate =>
            candidate.source === 'pipewiresrc:auto' || candidate.source === 'autoaudiosrc'
        );

        assert(candidates.length === 1, 'auto mode keeps only one safe monitor candidate when pulsesrc is available');
        assert(candidates[0].source === 'pulse:@DEFAULT_MONITOR@', 'auto mode prefers @DEFAULT_MONITOR@ capture');
        assert(!hasMicProneFallback, 'auto mode does not include pipewiresrc:auto or autoaudiosrc fallbacks');
    }

    // If monitor capture backend is unavailable, auto mode should choose safe silence fallback.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._getSourceBackendAvailability = () => ({
            hasPipewire: true,
            hasPulseSrc: false,
            hasAutoSource: true,
        });

        const candidates = engine._buildCandidates('auto');

        assert(candidates.length === 1 && candidates[0].source === 'stub', 'auto mode falls back to stub when no monitor backend exists');
    }

    // Repeated fallback notifications are deduplicated until source recovers.
    {
        const fallbackCalls = [];
        const engine = new AudioEngine({
            logger: buildLogger([]),
            onFallback: (title, body) => fallbackCalls.push({title, body}),
        });

        engine._notify('output-monitor-unavailable', 'Output Monitor Unavailable', 'first');
        engine._notify('output-monitor-unavailable', 'Output Monitor Unavailable', 'second');
        engine._notify('audio-unavailable', 'Audio Unavailable', 'third');

        assert(fallbackCalls.length === 2, 'fallback notifications are emitted once per fallback key');
        assert(fallbackCalls[0].body === 'first', 'first fallback notification is preserved');
        assert(fallbackCalls[1].title === 'Audio Unavailable', 'changing fallback key emits a new notification');
    }

    // Auto mode enters reprobe mode after restart budget exhaustion.
    {
        const engine = new AudioEngine({
            logger: buildLogger([]),
            settings: {get_string: () => 'auto'},
        });

        let reprobeScheduled = false;
        let fallbackKey = '';

        engine._enabled = true;
        engine._restartWindowStartUsec = Number.MAX_SAFE_INTEGER;
        engine._restartAttempts = 3;
        engine._stopPipeline = () => {};
        engine._scheduleSourceReprobe = () => {
            reprobeScheduled = true;
        };
        engine._notify = key => {
            fallbackKey = key;
        };

        engine._scheduleRestart('test error');

        assert(reprobeScheduled, 'auto mode schedules source reprobe when restart budget is exhausted');
        assert(fallbackKey === 'audio-reprobe-mode', 'auto mode reports reprobe-mode fallback reason');
    }

    // Configured restart budget should be respected when present in settings.
    {
        const engine = new AudioEngine({
            logger: buildLogger([]),
            settings: {
                settings_schema: {
                    has_key: key => key === 'audio-restart-max-attempts' || key === 'audio-source',
                },
                get_int: () => 1,
                get_string: () => 'auto',
            },
        });

        let fallbackKey = '';
        let reprobeScheduled = false;
        engine._enabled = true;
        engine._restartWindowStartUsec = Number.MAX_SAFE_INTEGER;
        engine._restartAttempts = 1;
        engine._stopPipeline = () => {};
        engine._scheduleSourceReprobe = () => {
            reprobeScheduled = true;
        };
        engine._notify = key => {
            fallbackKey = key;
        };

        engine._scheduleRestart('budget test');

        assert(reprobeScheduled, 'custom restart budget triggers reprobe when exhausted');
        assert(fallbackKey === 'audio-reprobe-mode', 'custom restart budget exhaustion enters reprobe mode');
    }

    // Runtime settings changes should force a clean audio restart and reset counters.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        let stopped = 0;
        let started = 0;
        engine._enabled = true;
        engine._restartAttempts = 7;
        engine._restartWindowStartUsec = 1234;
        engine._stopPipeline = () => {
            stopped += 1;
        };
        engine._startPipeline = () => {
            started += 1;
        };

        engine.handleSettingsChanged('audio-source');

        assert(stopped === 1, 'handleSettingsChanged stops current pipeline once');
        assert(started === 1, 'handleSettingsChanged starts pipeline once');
        assert(engine._restartAttempts === 0, 'handleSettingsChanged resets restart attempts');
        assert(engine._restartWindowStartUsec === 0, 'handleSettingsChanged resets restart window marker');
    }

    // Non-auto mode remains disabled after restart budget exhaustion.
    {
        const engine = new AudioEngine({
            logger: buildLogger([]),
            settings: {get_string: () => 'pulse:custom'},
        });

        let reprobeScheduled = false;
        let fallbackKey = '';

        engine._enabled = true;
        engine._restartWindowStartUsec = Number.MAX_SAFE_INTEGER;
        engine._restartAttempts = 3;
        engine._stopPipeline = () => {};
        engine._scheduleSourceReprobe = () => {
            reprobeScheduled = true;
        };
        engine._notify = key => {
            fallbackKey = key;
        };

        engine._scheduleRestart('test error');

        assert(!reprobeScheduled, 'explicit source mode does not schedule auto reprobe');
        assert(fallbackKey === 'audio-disabled', 'explicit source mode reports disabled fallback reason');
    }

    // Beat detection fires when a loud transient follows steady-state audio.
    // The engine converts dB-normalized values to linear amplitude internally,
    // so a moderate dB jump produces a large amplitude ratio that exceeds the
    // adaptive threshold.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;

        // 24 bands at a steady -40 dB (normalized 0.5) for warmup
        const steadyBands = new Array(24).fill(-40.0);
        const steadyMessage = makeSpectrumMessage(makeStructuredSpectrum(steadyBands));
        for (let i = 0; i < 10; i++)
            engine._onSpectrum(steadyMessage.get_structure());

        assert(engine._histCount >= 5, 'beat warmup: history has enough samples');
        assert(engine._features.beat === 0, 'beat warmup: no false positive during steady state');

        // Spike: 24 bands at -15 dB (normalized 0.8125) — a ~16x amplitude jump
        const spikeBands = new Array(24).fill(-15.0);
        const spikeMessage = makeSpectrumMessage(makeStructuredSpectrum(spikeBands));
        engine._onSpectrum(spikeMessage.get_structure());

        assert(engine._features.beat === 1, 'beat detection fires on loud transient after steady state');
    }

    // Beat cooldown prevents rapid re-triggering.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;

        const steadyBands = new Array(24).fill(-40.0);
        const steadyMessage = makeSpectrumMessage(makeStructuredSpectrum(steadyBands));
        for (let i = 0; i < 10; i++)
            engine._onSpectrum(steadyMessage.get_structure());

        const spikeBands = new Array(24).fill(-15.0);
        const spikeMessage = makeSpectrumMessage(makeStructuredSpectrum(spikeBands));

        engine._onSpectrum(spikeMessage.get_structure());
        assert(engine._features.beat === 1, 'first spike triggers beat');
        assert(engine._beatCooldown > 0, 'beat sets cooldown counter');

        engine._onSpectrum(spikeMessage.get_structure());
        assert(engine._features.beat === 0, 'second spike during cooldown does not trigger beat');
    }

    // No beat fires when signal is below noise floor.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;

        // Very quiet: -75 dB (normalized 0.0625, linear ~0.000018)
        const quietBands = new Array(24).fill(-75.0);
        const quietMessage = makeSpectrumMessage(makeStructuredSpectrum(quietBands));
        for (let i = 0; i < 10; i++)
            engine._onSpectrum(quietMessage.get_structure());

        // -65 dB normalises to linear ~0.00056, still below BEAT_NOISE_FLOOR (0.001)
        const belowFloorBands = new Array(24).fill(-65.0);
        const belowFloorMessage = makeSpectrumMessage(makeStructuredSpectrum(belowFloorBands));
        engine._onSpectrum(belowFloorMessage.get_structure());
        assert(engine._features.beat === 0, 'spike below noise floor does not trigger beat');
    }

    // Public audio contract exposes treb alias and attenuated scaled bands.
    {
        const engine = new AudioEngine({
            logger: buildLogger([]),
            settings: {
                settings_schema: {
                    has_key: key => key === 'audio-sensitivity',
                },
                get_double: () => 0.5,
            },
        });

        engine._enabled = true;
        engine._lastUpdateUsec = GLib.get_monotonic_time();
        engine._features = {
            ...engine._features,
            source: 'pulse:test',
            active: true,
            energy: 0.8,
            bass: 0.9,
            mid: 0.4,
            high: 0.6,
            beat: 1,
            decay: 0.5,
        };

        const features = engine.getFeatures();
        const epsilon = 1e-9;

        assert(features.treb === features.high, 'getFeatures exposes treb as an alias of high');
        assert(Math.abs(features.bass - 0.45) <= epsilon, 'getFeatures scales public bass with sensitivity');
        assert(Math.abs(features.mid - 0.2) <= epsilon, 'getFeatures scales public mid with sensitivity');
        assert(Math.abs(features.high - 0.3) <= epsilon, 'getFeatures scales public high with sensitivity');
        assert(Math.abs(features.bass_att - (features.bass * 0.7)) <= epsilon,
            'getFeatures derives bass_att from scaled bass');
        assert(Math.abs(features.mid_att - (features.mid * 0.7)) <= epsilon,
            'getFeatures derives mid_att from scaled mid');
        assert(Math.abs(features.treb_att - (features.high * 0.7)) <= epsilon,
            'getFeatures derives treb_att from scaled high');
    }

    // Public audio contract exposes waveform sample payload for renderer waveform pass.
    {
        const engine = new AudioEngine({logger: buildLogger([])});
        engine._enabled = true;
        engine._lastUpdateUsec = GLib.get_monotonic_time();
        engine._features = {
            ...engine._features,
            source: 'pulse:test',
            active: true,
            energy: 0.5,
            bass: 0.4,
            mid: 0.3,
            high: 0.2,
            beat: 0,
            decay: 0.1,
            waveData: [0.0, 0.5, 1.0, 0.25],
        };

        const features = engine.getFeatures();
        assert(Array.isArray(features.waveData), 'getFeatures exposes waveData payload');
        assert(features.waveData.length === 4, 'getFeatures preserves waveData payload length');
        assert(Math.abs(features.waveData[2] - 1.0) < 1e-9,
            'getFeatures preserves waveData payload values');
    }
}