import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function safe(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

const referenceImpl = {
    atan2: (y, x) => Number.isFinite(y) && Number.isFinite(x) ? Math.atan2(y, x) : 0,
    pow: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? safe(Math.pow(x, y)) : 0,
    min: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? Math.min(x, y) : 0,
    max: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? Math.max(x, y) : 0,
    mod: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? (y !== 0 ? x % y : 0) : 0,
    div: (x, y) => Number.isFinite(x) && Number.isFinite(y) ? (y !== 0 ? x / y : 0) : 0,
    sigmoid: (x, y) => {
        const t = 1 + Math.exp(-x * y);
        return Math.abs(t) > EPSILON ? 1 / t : 0;
    },
};

function runTest(fnName, input1, input2, expected) {
    const expr = `result = ${fnName}(${input1},${input2})`;
    const fn = compile(expr);
    const ctx = { time: 0, frame: 0, fps: 60 };
    fn(ctx);
    const result = ctx.result;
    const pass = Math.abs(result - expected) < EPSILON;
    return { fnName, input1, input2, expected, actual: result, pass, expr };
}

export function run(assert) {
    const results = [];

    const testCases = {
        atan2: [
            { input1: '0', input2: '1', expected: 0 },
            { input1: '1', input2: '1', expected: Math.atan2(1, 1) },
            { input1: '1', input2: '0', expected: Math.PI / 2 },
            { input1: '-1', input2: '0', expected: -Math.PI / 2 },
            { input1: '0', input2: '-1', expected: Math.PI },
            { input1: '1', input2: '2', expected: Math.atan2(1, 2) },
            { input1: '0', input2: '0', expected: 0 },
        ],
        pow: [
            { input1: '2', input2: '0', expected: 1 },
            { input1: '2', input2: '1', expected: 2 },
            { input1: '2', input2: '2', expected: 4 },
            { input1: '2', input2: '10', expected: 1024 },
            { input1: '0', input2: '0', expected: 1 },
            { input1: '-1', input2: '2', expected: 1 },
            { input1: '-1', input2: '3', expected: -1 },
            { input1: '4', input2: '0.5', expected: 2 },
            { input1: '2', input2: '-1', expected: 0.5 },
            { input1: '10', input2: '100', expected: safe(Math.pow(10, 100)) },
        ],
        min: [
            { input1: '1', input2: '2', expected: 1 },
            { input1: '2', input2: '1', expected: 1 },
            { input1: '-1', input2: '1', expected: -1 },
            { input1: '0', input2: '0', expected: 0 },
            { input1: '-5', input2: '-10', expected: -10 },
            { input1: '1.5', input2: '2.5', expected: 1.5 },
        ],
        max: [
            { input1: '1', input2: '2', expected: 2 },
            { input1: '2', input2: '1', expected: 2 },
            { input1: '-1', input2: '1', expected: 1 },
            { input1: '0', input2: '0', expected: 0 },
            { input1: '-5', input2: '-10', expected: -5 },
            { input1: '1.5', input2: '2.5', expected: 2.5 },
        ],
        mod: [
            { input1: '10', input2: '3', expected: 1 },
            { input1: '10', input2: '2', expected: 0 },
            { input1: '10', input2: '7', expected: 3 },
            { input1: '-10', input2: '3', expected: -1 },
            { input1: '10', input2: '0', expected: 0 },
            { input1: '5.5', input2: '2', expected: 1.5 },
        ],
        div: [
            { input1: '10', input2: '2', expected: 5 },
            { input1: '10', input2: '4', expected: 2.5 },
            { input1: '10', input2: '0', expected: 0 },
            { input1: '-10', input2: '2', expected: -5 },
            { input1: '0', input2: '10', expected: 0 },
        ],
        sigmoid: [
            { input1: '0', input2: '1', expected: 0.5 },
            { input1: '1', input2: '1', expected: 0.73105858 },
            { input1: '-1', input2: '1', expected: 0.26894142 },
            { input1: '0', input2: '0', expected: 0.5 },
            { input1: '10', input2: '1', expected: 0.9999546 },
            { input1: '-10', input2: '1', expected: 0.0000454 },
        ],
    };

    for (const [fnName, cases] of Object.entries(testCases)) {
        for (const tc of cases) {
            const result = runTest(fnName, tc.input1, tc.input2, tc.expected);
            results.push(result);
        }
    }

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Math 2-Arg Functions Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected.toFixed(6)}, actual=${f.actual.toFixed(6)}`);
        }
    }

    assert(passed.length === results.length,
        `Math 2-arg functions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
