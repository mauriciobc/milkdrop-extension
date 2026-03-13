import { VertexEvaluator } from '../../src/renderer/vertex-eval.js';

export function run(assert) {
    // compile(null) -> evaluate returns identity
    {
        const ev = new VertexEvaluator();
        ev.compile(null);
        assert(ev.evaluate(0.3, 0.7).every((v, i) => v === [0.3, 0.7][i]), 'compile(null) evaluate returns [u,v]');
    }

    // compile(undefined) -> evaluate returns identity
    {
        const ev = new VertexEvaluator();
        ev.compile(undefined);
        assert(ev.evaluate(0.5, 0.5)[0] === 0.5 && ev.evaluate(0.5, 0.5)[1] === 0.5, 'compile(undefined) identity');
    }

    // compile({ warpAmount: 0 }) -> identity
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0 });
        const [u, v] = ev.evaluate(0.25, 0.75);
        assert(u === 0.25 && v === 0.75, 'warpAmount 0 returns identity');
    }

    // compile(spec) warpType radial: centre (0.5,0.5) stays, point off-centre changes
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.02, warpSpeed: 1.0, warpScale: 1.0, warpType: 'radial' });
        const frame = { t: 0, audio: { energy: 0 } };
        const centre = ev.evaluate(0.5, 0.5, frame);
        assert(centre[0] === 0.5 && centre[1] === 0.5, 'radial centre unchanged (dist~0)');
        const off = ev.evaluate(0.7, 0.5, frame);
        assert(Array.isArray(off) && off.length === 2, 'radial returns [u\',v\']');
        assert(off[0] !== 0.7 || off[1] !== 0.5, 'radial off-centre point warped');
    }

    // warpType angular
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.1, warpSpeed: 1.0, warpScale: 1.0, warpType: 'angular' });
        const frame = { t: 0, audio: { energy: 0 } };
        const [u, v] = ev.evaluate(0.8, 0.5, frame);
        assert(Number.isFinite(u) && Number.isFinite(v), 'angular returns finite coords');
        assert(u >= 0 && u <= 1 && v >= 0 && v <= 1, 'angular coords in [0,1]');
    }

    // warpType wave
    {
        const ev = new VertexEvaluator();
        ev.compile({ warpAmount: 0.02, warpSpeed: 1.0, warpScale: 1.0, warpType: 'wave' });
        const frame = { t: 1.0, audio: { energy: 0.2 } };
        const [u, v] = ev.evaluate(0.5, 0.5, frame);
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
        const [u, v] = ev.evaluate(0.3, 0.4, {});
        assert(u === 0.3 && v === 0.4, 'invalid warpType returns identity');
    }
}
