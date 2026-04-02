/**
 * Tests for the per-pixel (per-vertex) expression evaluator.
 */
import { PerPixelEvaluator } from '../../../src/extension/expr/per-pixel.js';
import { FrameContext } from '../../../src/extension/expr/context.js';

const EPSILON = 0.001;
function near(a, b) { return Math.abs(a - b) < EPSILON; }

export function run(assert) {
    // ── Identity: no per-pixel eqs → no warp offset ───────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile(null);
        const ctx = new FrameContext();
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.dx, 0), 'identity: dx = 0');
        assert(near(result.dy, 0), 'identity: dy = 0');
    }

    // ── Simple constant offset ────────────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = 0.01; dy = -0.01;');
        const ctx = new FrameContext();
        const result = pp.evaluate(0.3, 0.7, ctx);
        assert(near(result.dx, 0.01), 'constant offset: dx = 0.01');
        assert(near(result.dy, -0.01), 'constant offset: dy = -0.01');
    }

    // ── Radial warp using x, y ────────────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = (x - 0.5) * 0.1; dy = (y - 0.5) * 0.1;');
        const ctx = new FrameContext();

        // At center: no warp
        const r1 = pp.evaluate(0.5, 0.5, ctx);
        assert(near(r1.dx, 0), 'radial: center dx ≈ 0');
        assert(near(r1.dy, 0), 'radial: center dy ≈ 0');

        // At (1.0, 0.5): dx = 0.05
        const r2 = pp.evaluate(1.0, 0.5, ctx);
        assert(near(r2.dx, 0.05), 'radial: far-right dx = 0.05');
        assert(near(r2.dy, 0), 'radial: far-right dy ≈ 0');
    }

    // ── Read-only x, y, rad, ang are set correctly ────────────────
    {
        const pp = new PerPixelEvaluator();
        // Output rad and ang via dx/dy so we can read them back
        pp.compile('dx = rad; dy = ang;');
        const ctx = new FrameContext();

        // (1.0, 0.5) → center-relative (0.5, 0.0) → rad=0.5, ang=0
        const r = pp.evaluate(1.0, 0.5, ctx);
        assert(near(r.dx, 0.5), 'x=1,y=0.5: rad ≈ 0.5');
        assert(near(r.dy, 0), 'x=1,y=0.5: ang ≈ 0');
    }

    // ── Q-variable read from frame context ────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = q1 * 0.01;');
        const ctx = new FrameContext();
        ctx.q1 = 5;
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.dx, 0.05), 'reads q1 from frame ctx');
    }

    // ── T-variable isolation between vertices ─────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('t1 = t1 + 1; dx = t1 * 0.01;');
        const ctx = new FrameContext();

        const r1 = pp.evaluate(0.0, 0.0, ctx);
        assert(near(r1.dx, 0.01), 't1 starts at 0, becomes 1: dx = 0.01');

        const r2 = pp.evaluate(0.5, 0.5, ctx);
        assert(near(r2.dx, 0.01), 't1 resets each vertex: dx = 0.01 again');
    }

    // ── Per-pixel zoom/rot read from context ──────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('zoom = zoom + 0.1;');
        const ctx = new FrameContext();
        ctx.zoom = 1.0;
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.zoom, 1.1), 'per-pixel can modify zoom');
    }

    // ── Per-pixel reads per-frame warp ────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = warp * 0.01;');
        const ctx = new FrameContext();
        ctx.warp = 2.0;
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.dx, 0.02), 'per-pixel reads per-frame warp');
    }

    // ── Audio-driven warp ─────────────────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = bass * 0.05;');
        const ctx = new FrameContext();
        ctx.setReadOnly({ bass: 1.0 });
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.dx, 0.05), 'audio bass drives dx');
    }

    // ── Evaluate full grid (performance sanity check) ─────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = sin(ang + time) * 0.01; dy = cos(rad * 10) * 0.01;');
        const ctx = new FrameContext();
        ctx.setReadOnly({ time: 1.0 });

        const gridX = 48, gridY = 36;
        const start = Date.now();
        for (let gy = 0; gy <= gridY; gy++) {
            for (let gx = 0; gx <= gridX; gx++) {
                const x = gx / gridX;
                const y = gy / gridY;
                pp.evaluate(x, y, ctx);
            }
        }
        const elapsed = Date.now() - start;
        assert(elapsed < 100, `grid eval (${gridX}x${gridY}=${(gridX+1)*(gridY+1)} verts) took ${elapsed}ms < 100ms`);
    }

    // ── evaluateGrid helper ───────────────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('dx = 0.01; dy = -0.01;');
        const ctx = new FrameContext();
        const grid = pp.evaluateGrid(4, 3, ctx);
        assert(grid.length === 5 * 4, 'evaluateGrid returns (gridX+1)*(gridY+1) vertices');
        assert(near(grid[0].dx, 0.01), 'grid vertex 0 dx correct');
        assert(near(grid[0].dy, -0.01), 'grid vertex 0 dy correct');
    }

    // ── Empty string compiles to no-op ────────────────────────────
    {
        const pp = new PerPixelEvaluator();
        pp.compile('');
        const ctx = new FrameContext();
        const result = pp.evaluate(0.5, 0.5, ctx);
        assert(near(result.dx, 0), 'empty string: dx = 0');
    }
}
