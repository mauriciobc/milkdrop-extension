import { compile } from '../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function runTest(expr, ctx, extractResult) {
    const fn = compile(expr);
    const ctxCopy = { ...ctx };
    fn(ctxCopy);
    const expected = extractResult(ctxCopy);
    const actual = extractResult(ctxCopy);
    const pass = Math.abs(actual - expected) < EPSILON;
    return { expr, expected, actual, pass };
}

export function run(assert) {
    const results = [];

    const baseCtx = {
        time: 1.234,
        frame: 100,
        fps: 60,
        progress: 0.5,
        bass: 0.6,
        mid: 0.4,
        treb: 0.3,
        bass_att: 0.42,
        mid_att: 0.28,
        treb_att: 0.21,
        energy: 0.5,
        beat: 0,
        zoom: 1.0,
        rot: 0.0,
        dx: 0.0,
        dy: 0.0,
        decay: 0.98,
        cx: 0.5,
        cy: 0.5,
        warp: 1.0,
        wave_r: 0.5,
        wave_g: 0.5,
        wave_b: 0.5,
        wave_x: 0.5,
        wave_y: 0.5,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };

    const complexExpressions = [
        {
            name: 'nested sine with time',
            expr: 'zoom = zoom + 0.023 * (0.60 * sin(0.339 * time) + 0.40 * sin(0.276 * time))',
            expected: 1.0 + 0.023 * (0.60 * Math.sin(0.339 * 1.234) + 0.40 * Math.sin(0.276 * 1.234)),
            extract: ctx => ctx.zoom,
        },
        {
            name: 'bass reactive rotation',
            expr: 'rot = rot + 0.010 * bass',
            expected: 0.0 + 0.010 * 0.6,
            extract: ctx => ctx.rot,
        },
        {
            name: 'conditional with equal',
            expr: 'dx_residual = 0; dx = equal(bass, 0.6) * 0.016 * sin(time * 7)',
            expected: 1 * 0.016 * Math.sin(1.234 * 7),
            extract: ctx => ctx.dx,
        },
        {
            name: 'above conditional',
            expr: 'thresh = above(bass_att, 0.4) * 2 + (1 - above(bass_att, 0.4)) * ((0.4 - 0.3) * 0.96 + 0.3)',
            expected: 2,
            extract: ctx => ctx.thresh,
        },
        {
            name: 'nested if with logic',
            expr: 'x = if(above(bass, 0.5), if(below(mid, 0.5), 1, 2), 3)',
            expected: 1,
            extract: ctx => ctx.x,
        },
        {
            name: 'complex math expression',
            expr: 'y = pow(sin(time), 2) + cos(time * 2)',
            expected: Math.pow(Math.sin(1.234), 2) + Math.cos(1.234 * 2),
            extract: ctx => ctx.y,
        },
        {
            name: 'mod and div',
            expr: 'z = mod(frame, 10) + div(frame, 10)',
            expected: (100 % 10) + Math.floor(100 / 10),
            extract: ctx => ctx.z,
        },
        {
            name: 'min/max/clamp pattern',
            expr: 'w = max(0, min(1, bass * 2))',
            expected: Math.max(0, Math.min(1, 0.6 * 2)),
            extract: ctx => ctx.w,
        },
        {
            name: 'abs and sign',
            expr: 'v = sign(-0.5) * abs(treb)',
            expected: -1 * 0.3,
            extract: ctx => ctx.v,
        },
        {
            name: 'sigmoid function',
            expr: 's = sigmoid(bass * 10, 1)',
            expected: 1 / (1 + Math.exp(-0.6 * 10)),
            extract: ctx => ctx.s,
        },
        {
            name: 'multiple assignments chain',
            expr: 'a = 1; b = a + 2; c = a + b',
            expected: 4,
            extract: ctx => ctx.c,
        },
        {
            name: 'wave color animation',
            expr: 'wave_r = 0.85 + 0.25 * sin(0.613 * time + 1)',
            expected: 0.85 + 0.25 * Math.sin(0.613 * 1.234 + 1),
            extract: ctx => ctx.wave_r,
        },
        {
            name: 'wave color animation g',
            expr: 'wave_g = 0.85 + 0.25 * sin(0.544 * time + 2)',
            expected: 0.85 + 0.25 * Math.sin(0.544 * 1.234 + 2),
            extract: ctx => ctx.wave_g,
        },
        {
            name: 'wave color animation b',
            expr: 'wave_b = 0.85 + 0.25 * sin(0.751 * time + 3)',
            expected: 0.85 + 0.25 * Math.sin(0.751 * 1.234 + 3),
            extract: ctx => ctx.wave_b,
        },
    ];

    for (const tc of complexExpressions) {
        const fn = compile(tc.expr);
        const ctxCopy = { ...baseCtx };
        fn(ctxCopy);
        const actual = tc.extract(ctxCopy);
        const pass = Math.abs(actual - tc.expected) < EPSILON;
        results.push({
            name: tc.name,
            expr: tc.expr,
            expected: tc.expected,
            actual,
            pass,
        });
    }

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Complex Expressions Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.name}: expected=${f.expected?.toFixed(6)}, actual=${f.actual?.toFixed(6)}`);
        }
    }

    assert(passed.length === results.length,
        `Complex expressions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
