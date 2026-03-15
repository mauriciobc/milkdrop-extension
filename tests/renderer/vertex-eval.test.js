import { VertexEvaluator } from '../../src/renderer/vertex-eval.js';

export function run(assert) {
    // compile(null) -> evaluate returns identity
    {
        const ev = new VertexEvaluator();
        ev.compile(null);
        const res = ev.evaluate(0.3, 0.7);
        assert(res.u === 0.3 && res.v === 0.7, 'compile(null) evaluate returns normalized object');
        assert('zoom' in res && 'rot' in res, 'compile(null) returns all fields');
    }

    // compile(undefined) -> evaluate returns identity
    {
        const ev = new VertexEvaluator();
        ev.compile(undefined);
        const res = ev.evaluate(0.5, 0.5);
        assert(res.u === 0.5 && res.v === 0.5, 'compile(undefined) identity');
    }

    // compile({ warpAmount: 0 }) -> identity
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0 });
        const { u, v } = ev.evaluate(0.25, 0.75);
        assert(u === 0.25 && v === 0.75, 'warpAmount 0 returns identity');
    }

    // compile(spec) warpType radial: centre (0.5,0.5) stays, point off-centre changes
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.02, warpSpeed: 1.0, warpScale: 1.0, warpType: 'radial' });
        const frame = { t: 0, audio: { energy: 0 } };
        const centre = ev.evaluate(0.5, 0.5, frame);
        assert(centre.u === 0.5 && centre.v === 0.5, 'radial centre unchanged (dist~0)');
        const off = ev.evaluate(0.7, 0.5, frame);
        assert(typeof off === 'object' && off.u !== undefined, 'radial returns object');
        assert(off.u !== 0.7 || off.v !== 0.5, 'radial off-centre point warped');
    }

    // warpType angular
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.1, warpSpeed: 1.0, warpScale: 1.0, warpType: 'angular' });
        const frame = { t: 0, audio: { energy: 0 } };
        const { u, v } = ev.evaluate(0.8, 0.5, frame);
        assert(Number.isFinite(u) && Number.isFinite(v), 'angular returns finite coords');
        assert(u >= -1 && u <= 2 && v >= -1 && v <= 2, 'angular coords reasonable');
    }

    // warpType wave
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.02, warpSpeed: 1.0, warpScale: 1.0, warpType: 'wave' });
        const frame = { t: 1.0, audio: { energy: 0.2 } };
        const { u, v } = ev.evaluate(0.5, 0.5, frame);
        assert(Number.isFinite(u) && Number.isFinite(v), 'wave returns finite coords');
    }

    // default warpType is radial
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.01, warpSpeed: 1.0 });
        assert(ev._compiled.warpType === 'radial', 'compile default warpType radial');
    }

    // invalid warpType falls through to default (identity in switch)
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.01, warpType: 'invalid' });
        const { u, v } = ev.evaluate(0.3, 0.4, {});
        assert(u === 0.3 && v === 0.4, 'invalid warpType returns identity');
    }

    // expression path returns a rich output object with UV and per-pixel overrides.
    {
        const ev = new VertexEvaluator();
        ev._perPixel = {
            evaluate() {
                return {
                    dx: 0.01,
                    dy: -0.02,
                    zoom: 1.2,
                    rot: 0.3,
                    cx: 0.4,
                    cy: 0.6,
                    sx: 1.1,
                    sy: 0.9,
                    zoomexp: 1.5,
                    warp: 0.8,
                };
            },
        };

        const out = ev.evaluate(0.5, 0.5, {_exprCtx: {}});
        assert(typeof out === 'object' && !Array.isArray(out), 'expression path returns object output');
        assert(Math.abs(out.u - 0.51) < 1e-9 && Math.abs(out.v - 0.48) < 1e-9,
            'expression path object output contains UV with dx/dy applied');
        assert(Math.abs(out.zoom - 1.2) < 1e-9 && Math.abs(out.zoomexp - 1.5) < 1e-9,
            'expression path object output keeps per-pixel zoom controls');
    }
}
