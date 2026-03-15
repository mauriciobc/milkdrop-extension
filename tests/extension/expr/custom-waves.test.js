/**
 * Tests for MilkDrop 2 custom waves.
 */
import { CustomWave } from '../../../src/extension/expr/custom-waves.js';
import { FrameContext } from '../../../src/extension/expr/context.js';

const EPSILON = 0.01;
function near(a, b) { return Math.abs(a - b) < EPSILON; }

export function run(assert) {
    // ── Basic wave with defaults ──────────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 8, scaling: 1.0, r: 1, g: 0, b: 0, a: 1 },
            point_eqs: 'x = sample * 2 - 1; y = value1;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        // Provide audio data for 8 points
        const audio = new Array(8).fill(0).map((_, i) => i / 7);
        const pts = wave.evaluatePoints(ctx, audio, null);
        assert(pts.length === 8, 'wave produces 8 points');
        assert(near(pts[0].x, -1), 'first point x = -1');
        assert(near(pts[7].x, 1), 'last point x = 1');
        assert(near(pts[0].y, 0), 'first point y = value1 = 0');
        assert(near(pts[7].y, 1), 'last point y = value1 = 1');
    }

    // ── Disabled wave produces null ───────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 0, samples: 8 },
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const pts = wave.evaluatePoints(ctx, new Array(8).fill(0), null);
        assert(pts === null, 'disabled wave produces null');
    }

    // ── Frame equations modify wave params ────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, r: 0, g: 0, b: 0, a: 1, scaling: 1.0 },
            frame_eqs: 'r = 0.5 + time; scaling = bass * 2;',
            point_eqs: 'x = sample; y = value1 * scaling;',
        });
        const ctx = new FrameContext();
        ctx.setReadOnly({ time: 0.5, bass: 1.5 });
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const info = wave.getWaveInfo();
        assert(near(info.r, 1.0), 'frame_eqs: r = 0.5 + 0.5 = 1.0');
        assert(near(info.scaling, 3.0), 'frame_eqs: scaling = 1.5 * 2 = 3.0');
    }

    // ── Init equations run once ───────────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, r: 1, g: 1, b: 1, a: 1, scaling: 1.0 },
            init_eqs: 'q5 = 77;',
            frame_eqs: 'scaling = q5 * 0.01;',
            point_eqs: 'x = sample; y = 0;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const info = wave.getWaveInfo();
        assert(near(info.scaling, 0.77), 'init sets q5, frame reads it');
    }

    // ── 4 independent waves don't share state ─────────────────────
    {
        const waves = [];
        for (let i = 0; i < 4; i++) {
            const w = new CustomWave(i);
            w.load({
                baseVals: { enabled: 1, samples: 4, r: (i + 1) * 0.2, g: 0, b: 0, a: 1 },
                point_eqs: 'x = sample; y = 0;',
            });
            waves.push(w);
        }
        const ctx = new FrameContext();
        for (const w of waves) {
            w.runInit(ctx);
            w.evaluateFrame(ctx);
        }
        for (let i = 0; i < 4; i++) {
            const info = waves[i].getWaveInfo();
            assert(near(info.r, (i + 1) * 0.2), `wave ${i} has correct r`);
        }
    }

    // ── Per-point equations receive audio data ────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, r: 1, g: 1, b: 1, a: 1, scaling: 1.0 },
            point_eqs: 'y = value1 + value2;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const audio1 = [0.1, 0.2, 0.3, 0.4];
        const audio2 = [0.5, 0.6, 0.7, 0.8];
        const pts = wave.evaluatePoints(ctx, audio1, audio2);
        assert(near(pts[0].y, 0.6), 'point 0: y = 0.1 + 0.5');
        assert(near(pts[3].y, 1.2), 'point 3: y = 0.4 + 0.8');
    }

    // ── Per-point color override ──────────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 3, r: 1, g: 0, b: 0, a: 1 },
            point_eqs: 'x = sample; y = 0; r = sample; g = 1 - sample; b = 0;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const pts = wave.evaluatePoints(ctx, [0, 0, 0], null);
        assert(near(pts[0].r, 0), 'first point r = 0 (sample=0)');
        assert(near(pts[0].g, 1), 'first point g = 1');
        assert(near(pts[2].r, 1), 'last point r = 1 (sample=1)');
        assert(near(pts[2].g, 0), 'last point g = 0');
    }

    // ── additive and usedots flags ────────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, bAdditive: 1, bUseDots: 1,
                        r: 1, g: 1, b: 1, a: 1 },
            point_eqs: 'x = sample; y = 0;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const info = wave.getWaveInfo();
        assert(info.additive === true, 'additive flag preserved');
        assert(info.useDots === true, 'useDots flag preserved');
    }

    // ── spectrum flag ─────────────────────────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, bSpectrum: 1,
                        r: 1, g: 1, b: 1, a: 1 },
            point_eqs: 'x = sample; y = value1;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const info = wave.getWaveInfo();
        assert(info.spectrum === true, 'spectrum flag preserved');
    }

    // ── t-vars isolated between waves ─────────────────────────────
    {
        const w1 = new CustomWave(0);
        w1.load({
            baseVals: { enabled: 1, samples: 2, r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 't1 = 55;',
            point_eqs: 'x = sample; y = 0;',
        });
        const w2 = new CustomWave(1);
        w2.load({
            baseVals: { enabled: 1, samples: 2, r: 1, g: 1, b: 1, a: 1, scaling: 1.0 },
            frame_eqs: 'scaling = t1 * 0.01;',
            point_eqs: 'x = sample; y = 0;',
        });
        const ctx = new FrameContext();
        w1.runInit(ctx);
        w2.runInit(ctx);
        w1.evaluateFrame(ctx);
        w2.evaluateFrame(ctx);
        const info = w2.getWaveInfo();
        assert(near(info.scaling, 0), 't-vars isolated: w2 sees t1=0');
    }

    // ── Q-vars flow from frame to per-point ───────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 2, r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 'q3 = 10;',
            point_eqs: 'x = sample; y = q3 * 0.01;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const pts = wave.evaluatePoints(ctx, [0, 0], null);
        assert(near(pts[0].y, 0.1), 'per-point reads q3 from frame');
    }

    // ── sep > 0: two-channel wave offset ──────────────────────────
    {
        const wave = new CustomWave(0);
        wave.load({
            baseVals: { enabled: 1, samples: 4, sep: 2, r: 1, g: 1, b: 1, a: 1 },
            point_eqs: 'x = sample * 2 - 1; y = value1;',
        });
        const ctx = new FrameContext();
        wave.runInit(ctx);
        wave.evaluateFrame(ctx);
        const info = wave.getWaveInfo();
        assert(info.sep === 2, 'sep value preserved');
    }
}
