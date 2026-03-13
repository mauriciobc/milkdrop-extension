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

function makeRegexOnlySpectrum(serialized) {
    return {
        get_array() {
            return null;
        },
        get_value() {
            return null;
        },
        to_string() {
            return serialized;
        },
    };
}

export function run(assert) {
    // Structured parser mode stays locked and does not bounce to regex fallback.
    {
        const logs = [];
        const engine = new AudioEngine({logger: buildLogger(logs)});
        const structured = makeStructuredSpectrum([-40.0, -20.0, -10.0]);
        const regexOnly = makeRegexOnlySpectrum('magnitude=(float){-40.0,-20.0,-10.0}');

        const first = engine._parseSpectrumBands(structured);
        const second = engine._parseSpectrumBands(regexOnly);

        assert(first.length === 3, 'structured spectrum parser returns expected band count');
        assert(engine._spectrumParserMode === 'structured', 'structured parser locks parser mode to structured');
        assert(second.length === 0, 'structured mode avoids regex fallback once capability is known');
    }

    // Regex fallback mode activates once and tracks usage.
    {
        const logs = [];
        const engine = new AudioEngine({logger: buildLogger(logs)});
        const regexOnly = makeRegexOnlySpectrum('magnitude=(double){-30.0,-20.0,-10.0}');

        const first = engine._parseSpectrumBands(regexOnly);
        const second = engine._parseSpectrumBands(regexOnly);

        const fallbackWarned = logs.some(entry =>
            entry.level === 'warn' &&
            entry.message.includes('falling back to regex spectrum parser')
        );
        const usageWarned = logs.some(entry =>
            entry.level === 'warn' &&
            entry.message.includes('regex spectrum fallback active count=1')
        );

        assert(engine._spectrumParserMode === 'regex-fallback', 'regex parser fallback locks parser mode');
        assert(first.length === 3 && second.length === 3, 'regex fallback parser keeps returning magnitude bands');
        assert(engine._regexFallbackCount === 2, 'regex fallback usage counter increments per successful parse');
        assert(fallbackWarned, 'regex fallback transition emits warning log');
        assert(usageWarned, 'regex fallback usage emits warning log');
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

        const candidates = engine._buildSourceCandidates('auto');
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

        const candidates = engine._buildSourceCandidates('auto');

        assert(candidates.length === 1 && candidates[0].source === 'stub', 'auto mode falls back to stub when no monitor backend exists');
    }

    // Repeated fallback notifications are deduplicated until source recovers.
    {
        const fallbackCalls = [];
        const engine = new AudioEngine({
            logger: buildLogger([]),
            onFallback: (title, body) => fallbackCalls.push({title, body}),
        });

        engine._notifyFallbackOnce('output-monitor-unavailable', 'Output Monitor Unavailable', 'first');
        engine._notifyFallbackOnce('output-monitor-unavailable', 'Output Monitor Unavailable', 'second');
        engine._notifyFallbackOnce('audio-unavailable', 'Audio Unavailable', 'third');

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
        engine._notifyFallbackOnce = key => {
            fallbackKey = key;
        };

        engine._schedulePipelineRestart('test error');

        assert(reprobeScheduled, 'auto mode schedules source reprobe when restart budget is exhausted');
        assert(fallbackKey === 'audio-reprobe-mode', 'auto mode reports reprobe-mode fallback reason');
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
        engine._notifyFallbackOnce = key => {
            fallbackKey = key;
        };

        engine._schedulePipelineRestart('test error');

        assert(!reprobeScheduled, 'explicit source mode does not schedule auto reprobe');
        assert(fallbackKey === 'audio-disabled', 'explicit source mode reports disabled fallback reason');
    }
}