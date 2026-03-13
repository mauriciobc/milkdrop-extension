import { Evaluator } from '../../src/extension/evaluator.js';

export function run(assert) {
    // loadPreset(null) clears _preset and blend
    {
        const e = new Evaluator();
        e.loadPreset({ id: 'p1', name: 'P1', frame: {} });
        e.loadPreset(null);
        assert(e._preset === null, 'loadPreset(null) clears _preset');
        assert(e._blendFrom === null, 'loadPreset(null) clears _blendFrom');
    }

    // loadPreset(preset) sets _preset
    {
        const e = new Evaluator();
        const preset = { id: 'builtin:demo', name: 'Demo', frame: {} };
        e.loadPreset(preset);
        assert(e._preset === preset, 'loadPreset(preset) sets _preset');
    }

    // loadPreset with blendDuration > 0 and existing _preset sets _blendFrom
    {
        const e = new Evaluator();
        const oldPreset = { id: 'old', name: 'Old', frame: {} };
        const newPreset = { id: 'new', name: 'New', frame: {} };
        e.loadPreset(oldPreset);
        e.loadPreset(newPreset, 1.0);
        assert(e._blendFrom === oldPreset, 'blend stores previous preset');
        assert(e._preset === newPreset, 'blend sets new preset');
        assert(e._blendDuration === 1.0, 'blend stores duration');
    }

    // evaluateFrame: frameState.t, audio, monitor reflected in result
    {
        const e = new Evaluator();
        const preset = {
            id: 'p1',
            name: 'Preset1',
            frame: {
                zoom: { base: 2.0 },
                rot: { base: 0.1 },
                dx: { base: 0.05 },
                dy: { base: -0.05 },
                decay: { base: 0.95 },
            },
        };
        e.loadPreset(preset);
        const out = e.evaluateFrame({ t: 10, audio: { energy: 0.5, bass: 0.2 }, monitor: 1 });
        assert(out.zoom === 2.0, 'evaluateFrame zoom from preset');
        assert(out.rot === 0.1, 'evaluateFrame rot from preset');
        assert(out.dx === 0.05, 'evaluateFrame dx from preset');
        assert(out.dy === -0.05, 'evaluateFrame dy from preset');
        assert(out.decay === 0.95, 'evaluateFrame decay from preset');
        assert(out.presetId === 'p1', 'evaluateFrame presetId');
        assert(out.presetName === 'Preset1', 'evaluateFrame presetName');
        assert(out.uniforms.time === 10, 'evaluateFrame uniforms.time');
        assert(out.audio.energy === 0.5, 'evaluateFrame audio.energy');
        assert(out.audio.bass === 0.2, 'evaluateFrame audio.bass');
        assert(out.blendProgress === 1, 'evaluateFrame no blend so blendProgress 1');
    }

    // evaluateFrame with null preset uses defaults
    {
        const e = new Evaluator();
        e.loadPreset(null);
        const out = e.evaluateFrame({ t: 0 });
        assert(out.presetId === 'builtin:demo-wave', 'null preset presetId default');
        assert(out.presetName === 'Demo Wave', 'null preset presetName default');
    }

    // blend: first frame after switch sets blendProgress in (0, 1), after duration blendProgress === 1
    {
        const e = new Evaluator();
        const oldPreset = { id: 'o', name: 'O', frame: { zoom: { base: 1.0 } } };
        const newPreset = { id: 'n', name: 'N', frame: { zoom: { base: 2.0 } } };
        e.loadPreset(oldPreset);
        e.loadPreset(newPreset, 2.0);
        const out1 = e.evaluateFrame({ t: 0 });
        assert(out1.blendProgress >= 0 && out1.blendProgress <= 1, 'blend first frame progress in [0,1]');
        const out2 = e.evaluateFrame({ t: 2.5 });
        assert(out2.blendProgress === 1, 'blend after duration progress 1');
    }

    // _evaluateWave: no spec returns fallback
    {
        const e = new Evaluator();
        const v = e._evaluateWave(null, 0, 0, 1.5, 0);
        assert(v === 1.5, '_evaluateWave null spec returns fallback');
    }

    // _evaluateWave: spec with sin, base, amplitude, frequency, audioScale
    {
        const e = new Evaluator();
        const spec = { base: 10, amplitude: 2, frequency: 0, waveform: 'sin', audioScale: 0.5 };
        const v = e._evaluateWave(spec, 0, 0, 0, 4);
        assert(v === 10 + 4 * 0.5, '_evaluateWave base + audioScale*audioValue');
    }

    // _smoothstep: 0->0, 1->1, 0.5->0.5
    {
        const e = new Evaluator();
        assert(e._smoothstep(0) === 0, '_smoothstep(0) === 0');
        assert(e._smoothstep(1) === 1, '_smoothstep(1) === 1');
        assert(e._smoothstep(0.5) === 0.5, '_smoothstep(0.5) === 0.5');
    }

    // _getBlendProgress: no blend returns 1
    {
        const e = new Evaluator();
        e.loadPreset({ id: 'x', name: 'X', frame: {} });
        assert(e._getBlendProgress(0) === 1, '_getBlendProgress no blend returns 1');
    }

    // _getBlendProgress: with blend, elapsed < duration returns proportion
    {
        const e = new Evaluator();
        e._blendFrom = {};
        e._blendStartTime = 0;
        e._blendDuration = 10;
        const p = e._getBlendProgress(5);
        assert(p === 0.5, '_getBlendProgress half elapsed returns 0.5');
    }

    // _getBlendProgress: elapsed >= duration returns 1 and clears blend
    {
        const e = new Evaluator();
        e._blendFrom = {};
        e._blendStartTime = 0;
        e._blendDuration = 10;
        e._getBlendProgress(15);
        assert(e._blendFrom === null, '_getBlendProgress clears blend when elapsed >= duration');
    }

    // destroy() clears state
    {
        const e = new Evaluator();
        e.loadPreset({ id: 'x', name: 'X', frame: {} });
        e.destroy();
        assert(e._preset === null && e._blendFrom === null, 'destroy clears _preset and _blendFrom');
    }
}
