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
        const preset = { id: 'file:/tmp/demo.milk', name: 'Demo', frame: {} };
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
        const out = e.evaluateFrame({ t: 10, audio: { pcmLeft: new Float32Array(576), pcmRight: new Float32Array(576) }, monitor: 1 });
        assert(out.zoom === 2.0, 'evaluateFrame zoom from preset');
        assert(out.rot === 0.1, 'evaluateFrame rot from preset');
        assert(out.dx === 0.05, 'evaluateFrame dx from preset');
        assert(out.dy === -0.05, 'evaluateFrame dy from preset');
        assert(out.decay === 0.95, 'evaluateFrame decay from preset');
        assert(out.presetId === 'p1', 'evaluateFrame presetId');
        assert(out.presetName === 'Preset1', 'evaluateFrame presetName');
        assert(out.t === 10, 'evaluateFrame t is forwarded from frameState');
        assert(out.audio.pcmLeft !== undefined, 'evaluateFrame audio.pcmLeft');
        assert(out.audio.pcmRight !== undefined, 'evaluateFrame audio.pcmRight');
        assert(out.blendProgress === 1, 'evaluateFrame no blend so blendProgress 1');
    }

    // evaluateFrame with null preset uses defaults
    {
        const e = new Evaluator();
        e.loadPreset(null);
        const out = e.evaluateFrame({ t: 0 });
        assert(out.presetId === null, 'null preset presetId default');
        assert(out.presetName === null, 'null preset presetName default');
    }

    // expression path receives audio context (no longer computes bands)
    {
        const e = new Evaluator();
        e.loadPreset({
            id: 'expr:audio-inputs',
            name: 'Expr Audio Inputs',
            baseVals: { zoom: 1, decay: 0.98 },
            frame_eqs: 'zoom = 1 + time; decay = 0.9;',
        });

        const out = e.evaluateFrame({
            t: 0,
            frame: 1,
            audio: { pcmLeft: new Float32Array(576), pcmRight: new Float32Array(576) },
        });
        assert(Math.abs(out.zoom - 1) < 1e-9, 'expression path evaluates frame_eqs');

        const out2 = e.evaluateFrame({
            t: 1,
            frame: 2,
            audio: { pcmLeft: new Float32Array(576), pcmRight: new Float32Array(576) },
        });
        assert(Math.abs(out2.zoom - 2) < 1e-9, 'expression path uses time variable');
    }

    // expression path exposes renderer-facing MilkDrop controls needed by downstream passes.
    {
        const e = new Evaluator();
        e.loadPreset({
            id: 'expr:renderer-contract',
            name: 'Expr Renderer Contract',
            baseVals: {
                zoom: 1,
                decay: 0.98,
                wrap: 0,
                wave_mode: 3,
            },
            frame_eqs: [
                'cx = 0.33;',
                'cy = 0.77;',
                'sx = 1.2;',
                'sy = 0.8;',
                'zoomexp = 1.5;',
                'warp = 0.42;',
                'echo_zoom = 1.1;',
                'echo_alpha = 0.25;',
                'echo_orient = 2;',
                'gamma = 1.3;',
                'brighten = 1;',
                'darken = 0;',
                'solarize = 1;',
                'invert = 0;',
                'darken_center = 1;',
                'ob_size = 0.02;',
                'ib_size = 0.03;',
                'mv_x = 14;',
                'mv_y = 10;',
                'mv_dx = 0.01;',
                'mv_dy = -0.02;',
                'mv_a = 0.7;',
                'wave_a = 0.6;',
                'wave_scale = 1.7;',
                'wave_smoothing = 0.9;',
                'wave_x = 0.45;',
                'wave_y = 0.55;',
                'wave_dots = 1;',
                'wave_thick = 1;',
                'additivewave = 1;',
            ].join(' '),
        });

        const out = e.evaluateFrame({ t: 0, frame: 1, audio: {} });
        assert(Math.abs(out.cx - 0.33) < 1e-9, 'evaluateFrame exposes cx for renderer contract');
        assert(Math.abs(out.cy - 0.77) < 1e-9, 'evaluateFrame exposes cy for renderer contract');
        assert(Math.abs(out.sx - 1.2) < 1e-9, 'evaluateFrame exposes sx for renderer contract');
        assert(Math.abs(out.sy - 0.8) < 1e-9, 'evaluateFrame exposes sy for renderer contract');
        assert(Math.abs(out.zoomexp - 1.5) < 1e-9, 'evaluateFrame exposes zoomexp for renderer contract');
        assert(Math.abs(out.warp - 0.42) < 1e-9, 'evaluateFrame exposes warp for renderer contract');
        assert(out.wrap === 0, 'evaluateFrame exposes wrap for renderer contract');
        assert(Math.abs(out.echo_zoom - 1.1) < 1e-9, 'evaluateFrame exposes echo_zoom for renderer contract');
        assert(Math.abs(out.echo_alpha - 0.25) < 1e-9, 'evaluateFrame exposes echo_alpha for renderer contract');
        assert(out.echo_orient === 2, 'evaluateFrame exposes echo_orient for renderer contract');
        assert(Math.abs(out.ob_size - 0.02) < 1e-9, 'evaluateFrame exposes outer border size for renderer contract');
        assert(Math.abs(out.ib_size - 0.03) < 1e-9, 'evaluateFrame exposes inner border size for renderer contract');
        assert(out.mv_x === 14 && out.mv_y === 10, 'evaluateFrame exposes motion vector grid params for renderer contract');
        assert(Math.abs(out.mv_dx - 0.01) < 1e-9 && Math.abs(out.mv_dy + 0.02) < 1e-9,
            'evaluateFrame exposes motion vector displacement for renderer contract');
        assert(Math.abs(out.mv_a - 0.7) < 1e-9, 'evaluateFrame exposes motion vector alpha for renderer contract');
        assert(out.wave_mode === 3, 'evaluateFrame exposes wave_mode for renderer contract');
        assert(Math.abs(out.wave_a - 0.6) < 1e-9, 'evaluateFrame exposes wave_a for renderer contract');
        assert(Math.abs(out.wave_scale - 1.7) < 1e-9, 'evaluateFrame exposes wave_scale for renderer contract');
        assert(Math.abs(out.wave_smoothing - 0.9) < 1e-9, 'evaluateFrame exposes wave_smoothing for renderer contract');
        assert(Math.abs(out.wave_x - 0.45) < 1e-9 && Math.abs(out.wave_y - 0.55) < 1e-9,
            'evaluateFrame exposes wave origin for renderer contract');
        assert(out.wave_dots === 1 && out.wave_thick === 1 && out.additivewave === 1,
            'evaluateFrame exposes waveform draw flags for renderer contract');
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
        const v = e._evaluateWave(null, 0, 0, 1.5);
        assert(v === 1.5, '_evaluateWave null spec returns fallback');
    }

    // _evaluateWave: spec with sin, base, amplitude, frequency
    {
        const e = new Evaluator();
        const spec = { base: 10, amplitude: 2, frequency: 0.5, waveform: 'sin' };
        const v = e._evaluateWave(spec, 0, 0, 0);
        assert(v === 10, '_evaluateWave base at time=0');
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

    // Expression-to-expression blending: verifies that zoom is blended correctly
    {
        const e = new Evaluator();
        const p1 = {
            id: 'p1', name: 'P1',
            baseVals: { zoom: 1.0 },
            frame_eqs: 'zoom = 1.0;'
        };
        const p2 = {
            id: 'p2', name: 'P2',
            baseVals: { zoom: 2.0 },
            frame_eqs: 'zoom = 2.0;'
        };

        e.loadPreset(p1);
        e.evaluateFrame({ t: 0 }); // Capture p1's context

        e.loadPreset(p2, 1.0); // 1s blend
        e.evaluateFrame({ t: 10 }); // set blendStartTime = 10
        const out = e.evaluateFrame({ t: 10.5 }); // half way

        // At t=10.5, blendProgress = 0.5. smoothstep(0.5) = 0.5.
        // zoom = 1.0 + (2.0 - 1.0) * 0.5 = 1.5
        assert(Math.abs(out.zoom - 1.5) < 1e-6, 'expr-to-expr: zoom is blended at mid-transition');
    }

    // Legacy-to-expression blending: verifies that prev values are captured from legacy and used in expr
    {
        const e = new Evaluator();
        const pLegacy = {
            id: 'plegacy', name: 'PLegacy',
            frame: { zoom: { base: 3.0 } }
        };
        const pExpr = {
            id: 'pexpr', name: 'PExpr',
            baseVals: { zoom: 1.0 },
            frame_eqs: 'zoom = 1.0;'
        };

        e.loadPreset(pLegacy);
        e.evaluateFrame({ t: 0 }); // Capture legacy's context (zoom=3.0)

        e.loadPreset(pExpr, 1.0);
        e.evaluateFrame({ t: 20 }); // set blendStartTime = 20
        const out = e.evaluateFrame({ t: 20.5 }); // half way

        // At t=20.5, blendProgress = 0.5. smoothstep(0.5) = 0.5.
        // zoom = 3.0 + (1.0 - 3.0) * 0.5 = 2.0
        assert(Math.abs(out.zoom - 2.0) < 1e-6, 'legacy-to-expr: zoom is blended at mid-transition');
    }

    // destroy() clears state
    {
        const e = new Evaluator();
        e.loadPreset({ id: 'x', name: 'X', frame: {} });
        e.destroy();
        assert(e._preset === null && e._blendFrom === null, 'destroy clears _preset and _blendFrom');
    }
}
