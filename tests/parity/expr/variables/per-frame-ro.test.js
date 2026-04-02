import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function runTest(expr, ctx) {
    const fn = compile(`result = ${expr}`);
    fn(ctx);
    const result = ctx.result;
    return { expr, actual: result };
}

export function run(assert) {
    const results = [];

    const readOnlyVars = [
        'time',
        'frame',
        'fps',
        'progress',
        'bass',
        'mid',
        'treb',
        'bass_att',
        'mid_att',
        'treb_att',
        'energy',
        'beat',
    ];

    const ctx = {
        time: 1.5,
        frame: 100,
        fps: 60,
        progress: 0.5,
        bass: 0.3,
        mid: 0.5,
        treb: 0.7,
        bass_att: 0.21,
        mid_att: 0.35,
        treb_att: 0.49,
        energy: 0.6,
        beat: 1,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };

    for (const v of readOnlyVars) {
        const result = runTest(v, ctx);
        const expected = ctx[v];
        result.expected = expected;
        result.pass = Math.abs(result.actual - expected) < EPSILON;
        results.push(result);
    }

    const exprTests = [
        { expr: 'time * 2', expected: 3.0 },
        { expr: 'frame + 1', expected: 101 },
        { expr: 'bass + mid + treb', expected: 1.5 },
        { expr: 'sin(time)', expected: Math.sin(1.5) },
        { expr: 'if(beat, 1, 0)', expected: 1 },
        { expr: 'above(bass, 0.2)', expected: 1 },
        { expr: 'below(treb, 0.8)', expected: 1 },
    ];

    for (const tc of exprTests) {
        const result = runTest(tc.expr, ctx);
        result.expected = tc.expected;
        result.pass = Math.abs(result.actual - tc.expected) < EPSILON;
        results.push(result);
    }

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Per-Frame Read-Only Variables Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected?.toFixed(6)}, actual=${f.actual?.toFixed(6)}`);
        }
    }

    assert(passed.length === results.length,
        `Per-frame RO variables: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
