import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function runTest(expr, expected, ctx) {
    const fn = compile(expr);
    fn(ctx);
    const result = ctx.result;
    const pass = Math.abs(result - expected) < EPSILON;
    return { expr, expected, actual: result, pass };
}

export function run(assert) {
    const results = [];

    const baseCtx = {
        time: 0,
        frame: 0,
        fps: 60,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };

    results.push(runTest('result = megabuf(0)', 0, { ...baseCtx }));
    results.push(runTest('result = megabuf(100)', 0, { ...baseCtx }));
    results.push(runTest('result = gmegabuf(0)', 0, { ...baseCtx }));
    results.push(runTest('result = gmegabuf(100)', 0, { ...baseCtx }));

    const writeCtx1 = {
        ...baseCtx,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };
    writeCtx1._megabuf[42] = 3.14159;
    results.push(runTest('result = megabuf(42)', 3.14159, writeCtx1));

    const writeCtx2 = {
        ...baseCtx,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };
    writeCtx2._gmegabuf[99] = 2.71828;
    results.push(runTest('result = gmegabuf(99)', 2.71828, writeCtx2));

    results.push(runTest('result = megabuf(1000000)', 0, { ...baseCtx }));
    results.push(runTest('result = gmegabuf(1000000)', 0, { ...baseCtx }));
    results.push(runTest('result = megabuf(-1)', 0, { ...baseCtx }));
    results.push(runTest('result = gmegabuf(-5)', 0, { ...baseCtx }));

    const chainCtx = {
        ...baseCtx,
        _megabuf: new Float64Array(1048576),
        _gmegabuf: new Float64Array(1048576),
    };
    const chainExpr = compile('result = megabuf(10); megabuf(10) = 5; megabuf(11) = megabuf(10) * 2; result = megabuf(11)');
    chainExpr(chainCtx);
    results.push(runTest('result = megabuf(10); megabuf(10) = 5; megabuf(11) = megabuf(10) * 2; result = megabuf(11)', 10, chainCtx));

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Memory (megabuf/gmegabuf) Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected}, actual=${f.actual}`);
        }
    }

    assert(passed.length === results.length,
        `Memory functions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
