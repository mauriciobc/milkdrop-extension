/**
 * Tests for the per-frame expression evaluator.
 */
import { ExpressionEvaluator } from '../../../src/extension/expr/per-frame.js';

const EPSILON = 0.001;
function near(a, b) { return Math.abs(a - b) < EPSILON; }

export function run(assert) {
    // ── Basic init + per-frame evaluation ─────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.0, rot: 0.0, decay: 0.98 },
            init_eqs: 'q1 = 0.5;',
            frame_eqs: 'zoom = 1.0 + q1 * 0.1;',
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0, bass: 0, mid: 0, treb: 0 });
        assert(near(ctx.q1, 0.5), 'init_eqs sets q1');
        assert(near(ctx.zoom, 1.05), 'frame_eqs computes zoom from q1');
    }

    // ── Per-frame modifies RW vars ────────────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.01, rot: 0.0, decay: 0.98 },
            frame_eqs: 'zoom = zoom + 0.05; rot = 0.1;',
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0 });
        assert(near(ctx.zoom, 1.06), 'frame_eqs modifies zoom additively');
        assert(near(ctx.rot, 0.1), 'frame_eqs sets rot');
    }

    // ── Audio reactivity ──────────────────────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { decay: 0.9 },
            frame_eqs: 'decay = 0.9 + bass * 0.08;',
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0, bass: 1.0, mid: 0, treb: 0 });
        assert(near(ctx.decay, 0.98), 'audio bass drives decay');
    }

    // ── Q-variable persistence across frames ──────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: {},
            init_eqs: 'q1 = 0;',
            frame_eqs: 'q1 = q1 + 0.01;',
        });
        ev.runInit();
        for (let i = 0; i < 10; i++)
            ev.evaluateFrame({ time: i * 0.033, frame: i });
        const ctx = ev.getContext();
        assert(near(ctx.q1, 0.1), 'q1 accumulates over 10 frames');
    }

    // ── resetPerFrame restores base between frames ────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.05 },
            frame_eqs: 'zoom = zoom + 0.01;',
        });
        ev.runInit();
        ev.evaluateFrame({ time: 0, frame: 0 });
        const ctx1 = ev.getContext();
        assert(near(ctx1.zoom, 1.06), 'first frame zoom = base + 0.01');
        ev.evaluateFrame({ time: 0.033, frame: 1 });
        const ctx2 = ev.getContext();
        // Should be base (1.05) + 0.01 again, not 1.07 (accumulative)
        assert(near(ctx2.zoom, 1.06), 'second frame zoom reset to base then modified');
    }

    // ── sin(time) usage ───────────────────────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.0 },
            frame_eqs: 'zoom = 1.0 + sin(time) * 0.1;',
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: Math.PI / 2, frame: 0 });
        assert(near(ctx.zoom, 1.1), 'sin(pi/2) drives zoom to ~1.1');
    }

    // ── Empty preset (no expressions) ─────────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.02, rot: 0.03 },
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0 });
        assert(near(ctx.zoom, 1.02), 'no-op preset keeps base zoom');
        assert(near(ctx.rot, 0.03), 'no-op preset keeps base rot');
    }

    // ── Null/undefined preset ─────────────────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset(null);
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0 });
        assert(near(ctx.zoom, 1.0), 'null preset uses defaults');
    }

    // ── getOutputState returns the expected shape ─────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.05, rot: 0.01, decay: 0.97, dx: 0.002, dy: -0.001 },
            frame_eqs: '',
        });
        ev.runInit();
        const out = ev.evaluateFrame({ time: 1.0, frame: 30 });
        assert(near(out.zoom, 1.05), 'output has zoom');
        assert(near(out.rot, 0.01), 'output has rot');
        assert(near(out.dx, 0.002), 'output has dx');
        assert(near(out.dy, -0.001), 'output has dy');
        assert(near(out.decay, 0.97), 'output has decay');
    }

    // ── Multiple statements in frame_eqs ──────────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: { zoom: 1.0, rot: 0.0 },
            frame_eqs: 'zoom = 2.0; rot = zoom * 0.1;',
        });
        ev.runInit();
        const ctx = ev.evaluateFrame({ time: 0, frame: 0 });
        assert(near(ctx.zoom, 2.0), 'multi-stmt: zoom set');
        assert(near(ctx.rot, 0.2), 'multi-stmt: rot uses updated zoom');
    }

    // ── Reg variables persist across frames ───────────────────────
    {
        const ev = new ExpressionEvaluator();
        ev.loadPreset({
            baseVals: {},
            frame_eqs: 'reg00 = reg00 + 1;',
        });
        ev.runInit();
        for (let i = 0; i < 5; i++)
            ev.evaluateFrame({ time: i * 0.033, frame: i });
        const ctx = ev.getContext();
        assert(near(ctx.reg00, 5), 'reg00 accumulates across frames');
    }
}
