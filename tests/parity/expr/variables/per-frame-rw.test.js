import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function runTest(expr, initialCtx, expectedValue, varName = 'zoom') {
    const fn = compile(expr);
    const ctx = { ...initialCtx };
    fn(ctx);
    const actual = ctx[varName];
    const pass = Math.abs(actual - expectedValue) < EPSILON;
    return { expr, expected: expectedValue, actual, pass };
}

export function run(assert) {
    const results = [];

    const defaultCtx = {
        zoom: 1.0,
        rot: 0.0,
        dx: 0.0,
        dy: 0.0,
        decay: 0.98,
        cx: 0.5,
        cy: 0.5,
        warp: 1.0,
        zoomexp: 1.0,
        wave_r: 1.0,
        wave_g: 1.0,
        wave_b: 1.0,
        wave_a: 0.8,
        wave_x: 0.5,
        wave_y: 0.5,
        wave_mode: 0,
        ob_size: 0.01,
        ib_size: 0.05,
        mv_x: 12.0,
        mv_y: 9.0,
        echo_zoom: 1.0,
        echo_alpha: 0.0,
        time: 1.0,
        frame: 0,
        fps: 60,
        bass: 0.3,
        mid: 0.5,
        treb: 0.7,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };

    const tests = [
        { expr: 'zoom = zoom + 0.1', expected: 1.1, var: 'zoom' },
        { expr: 'zoom = zoom * 2', expected: 2.0, var: 'zoom' },
        { expr: 'zoom = 1.5', expected: 1.5, var: 'zoom' },
        { expr: 'rot = rot + 0.5', expected: 0.5, var: 'rot' },
        { expr: 'dx = bass * 0.1', expected: 0.03, var: 'dx' },
        { expr: 'dy = mid * 0.1', expected: 0.05, var: 'dy' },
        { expr: 'decay = decay - 0.01', expected: 0.97, var: 'decay' },
        { expr: 'cx = cx + 0.1', expected: 0.6, var: 'cx' },
        { expr: 'cy = cy - 0.1', expected: 0.4, var: 'cy' },
        { expr: 'warp = warp * 1.5', expected: 1.5, var: 'warp' },
        { expr: 'wave_r = wave_r - 0.3', expected: 0.7, var: 'wave_r' },
        { expr: 'wave_g = wave_g + 0.2', expected: 1.2, var: 'wave_g' },
        { expr: 'wave_b = 0.5', expected: 0.5, var: 'wave_b' },
        { expr: 'ob_size = ob_size + 0.02', expected: 0.03, var: 'ob_size' },
        { expr: 'echo_zoom = echo_zoom * 2', expected: 2.0, var: 'echo_zoom' },
    ];

    for (const tc of tests) {
        const result = runTest(tc.expr, { ...defaultCtx }, tc.expected, tc.var);
        results.push(result);
    }

    const chainExpr = compile('zoom = zoom + 0.1; rot = rot + 0.2; zoom');
    const chainCtx = { ...defaultCtx };
    chainExpr(chainCtx);
    results.push({
        expr: 'zoom = zoom + 0.1; rot = rot + 0.2; zoom',
        expected: 1.1,
        actual: chainCtx.zoom,
        pass: Math.abs(chainCtx.zoom - 1.1) < EPSILON,
    });

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Per-Frame Read-Write Variables Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected}, actual=${f.actual}`);
        }
    }

    assert(passed.length === results.length,
        `Per-frame RW variables: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
