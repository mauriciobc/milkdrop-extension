import { Evaluator } from '../../src/extension/evaluator.js';

function _normalizeAudio(raw) {
    return {
        source: String(raw?.source ?? 'stub'),
        active: Boolean(raw?.active),
        energy: Number(raw?.energy ?? 0),
        bass: Number(raw?.bass ?? 0),
        mid: Number(raw?.mid ?? 0),
        high: Number(raw?.high ?? 0),
        beat: Number(raw?.beat ?? 0),
        decay: Number(raw?.decay ?? 0),
        waveData: raw?.waveData || [],
        pcmLeft: raw?.active ? (raw?.pcmLeft || []) : [],
        pcmRight: raw?.active ? (raw?.pcmRight || []) : [],
    };
}

function _buildFrameState({preset = null, audio = null, currentPresetForPath = null} = {}) {
    const evaluator = new Evaluator();
    if (preset)
        evaluator.loadPreset(preset, 0);

    const baseFrameState = {
        type: 'frame',
        monitor: 0,
        t: 123.456,
        fps: 60,
        frame: 42,
        audio: audio ?? {
            source: 'test',
            active: true,
            energy: 0.25,
            bass: 0.5,
            mid: 0.75,
            high: 0.125,
            beat: 0,
            decay: 0.1,
            waveData: [],
            pcmLeft: [0, 0.1, -0.1],
            pcmRight: [0, -0.1, 0.1],
        },
    };

    const evaluated = evaluator.evaluateFrame(baseFrameState);
    const rawAudio = evaluated.audio ?? baseFrameState.audio;
    evaluated.audio = _normalizeAudio(rawAudio);

    if (currentPresetForPath?.source === 'file' && typeof currentPresetForPath?.id === 'string' && currentPresetForPath.id.startsWith('file:'))
        evaluated.presetPath = currentPresetForPath.id.replace(/^file:/, '');
    else
        evaluated.presetPath = undefined;

    return evaluated;
}

function _assertFiniteNumber(assert, value, message) {
    assert(typeof value === 'number' && Number.isFinite(value), message);
}

export function run(assert) {
    {
        const frameState = _buildFrameState();

        assert(frameState.type === 'frame', 'frameState.type === frame');
        _assertFiniteNumber(assert, frameState.t, 'frameState.t is a finite number');
        assert(typeof frameState.frame === 'number', 'frameState.frame is a number');

        // Fallback renderer path consumes these when helper is unavailable.
        _assertFiniteNumber(assert, frameState.zoom, 'frameState.zoom is a finite number');
        _assertFiniteNumber(assert, frameState.rot, 'frameState.rot is a finite number');

        // GL helper path consumes PCM arrays and time.
        assert(frameState.audio && typeof frameState.audio === 'object', 'frameState.audio is an object');
        assert(typeof frameState.audio.source === 'string', 'frameState.audio.source is a string');
        assert(typeof frameState.audio.active === 'boolean', 'frameState.audio.active is a boolean');
        _assertFiniteNumber(assert, frameState.audio.energy, 'frameState.audio.energy is a finite number');
        _assertFiniteNumber(assert, frameState.audio.bass, 'frameState.audio.bass is a finite number');
        _assertFiniteNumber(assert, frameState.audio.mid, 'frameState.audio.mid is a finite number');
        _assertFiniteNumber(assert, frameState.audio.high, 'frameState.audio.high is a finite number');
        _assertFiniteNumber(assert, frameState.audio.beat, 'frameState.audio.beat is a finite number');
        _assertFiniteNumber(assert, frameState.audio.decay, 'frameState.audio.decay is a finite number');
        assert(Array.isArray(frameState.audio.waveData), 'frameState.audio.waveData is an array');
        assert(Array.isArray(frameState.audio.pcmLeft), 'frameState.audio.pcmLeft is an array');
        assert(Array.isArray(frameState.audio.pcmRight), 'frameState.audio.pcmRight is an array');

        assert(frameState.presetPath === undefined, 'frameState.presetPath is undefined for non-file preset');
    }

    {
        const inactiveAudio = {
            source: 'test',
            active: false,
            energy: 0,
            bass: 0,
            mid: 0,
            high: 0,
            beat: 0,
            decay: 0,
            waveData: [],
            pcmLeft: [1, 2, 3],
            pcmRight: [4, 5, 6],
        };
        const frameState = _buildFrameState({audio: inactiveAudio});
        assert(frameState.audio.active === false, 'inactive audio preserves active=false');
        assert(frameState.audio.pcmLeft.length === 0, 'inactive audio clears pcmLeft');
        assert(frameState.audio.pcmRight.length === 0, 'inactive audio clears pcmRight');
    }

    {
        const currentPresetForPath = {
            id: 'file:/tmp/example.milk',
            source: 'file',
        };
        const frameState = _buildFrameState({currentPresetForPath});
        assert(frameState.presetPath === '/tmp/example.milk', 'file preset exposes presetPath stripped from id');
    }
}

