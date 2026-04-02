import { Evaluator } from '../../src/extension/evaluator.js';

function _normalizeAudio(raw) {
    return {
        source: String(raw?.source ?? 'stub'),
        active: Boolean(raw?.active),
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
        assert(Array.isArray(frameState.audio.pcmLeft), 'frameState.audio.pcmLeft is an array');
        assert(Array.isArray(frameState.audio.pcmRight), 'frameState.audio.pcmRight is an array');

        assert(frameState.presetPath === undefined, 'frameState.presetPath is undefined for non-file preset');
    }

    {
        const inactiveAudio = {
            source: 'test',
            active: false,
            pcmLeft: [1, 2, 3],
            pcmRight: [4, 5, 6],
        };
        const frameState = _buildFrameState({audio: inactiveAudio});

        assert(frameState.audio.active === false, 'inactive audio preserves active=false');
        assert(Array.isArray(frameState.audio.pcmLeft), 'inactive audio.pcmLeft is array');
    }

    console.log("Frame state contract test passed");
}