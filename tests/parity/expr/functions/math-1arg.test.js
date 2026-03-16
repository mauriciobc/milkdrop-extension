import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function safe(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

const referenceImpl = {
    sin: (x) => safe(Math.sin(x)),
    cos: (x) => safe(Math.cos(x)),
    tan: (x) => safe(Math.tan(x)),
    asin: (x) => Math.asin(clamp(x, -1, 1)),
    acos: (x) => Math.acos(clamp(x, -1, 1)),
    atan: (x) => safe(Math.atan(x)),
    log: (x) => x > 0 ? Math.log(x) : 0,
    log10: (x) => x > 0 ? Math.log10(x) : 0,
    exp: (x) => safe(Math.exp(x)),
    sqrt: (x) => safe(Math.sqrt(Math.abs(x))),
    abs: (x) => safe(Math.abs(x)),
    floor: (x) => safe(Math.floor(x)),
    ceil: (x) => safe(Math.ceil(x)),
    int: (x) => safe(Math.floor(x)),
    sqr: (x) => safe(x * x),
    sign: (x) => x > 0 ? 1 : (x < 0 ? -1 : 0),
    bnot: (x) => Math.abs(x) < EPSILON ? 1 : 0,
    invsqrt: (x) => {
        const v = Math.sqrt(Math.abs(x));
        return v > 0 ? 1 / v : 0;
    },
};

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function runTest(fnName, input, expected) {
    const expr = `result = ${fnName}(${input})`;
    const fn = compile(expr);
    const ctx = { time: 0, frame: 0, fps: 60 };
    fn(ctx);
    const result = ctx.result;
    const pass = Math.abs(result - expected) < EPSILON;
    return { fnName, input, expected, actual: result, pass, expr };
}

export function run(assert) {
    const results = [];

    const testCases = {
        sin: [
            { input: '0', expected: 0 },
            { input: '1', expected: Math.sin(1) },
            { input: '3.14159', expected: Math.sin(3.14159) },
            { input: '-3.14159', expected: Math.sin(-3.14159) },
            { input: '6.28318', expected: Math.sin(6.28318) },
            { input: '1e10', expected: Math.sin(1e10) },
            { input: '1e-10', expected: Math.sin(1e-10) },
        ],
        cos: [
            { input: '0', expected: 1 },
            { input: '1', expected: Math.cos(1) },
            { input: '3.14159', expected: Math.cos(3.14159) },
            { input: '-3.14159', expected: Math.cos(-3.14159) },
            { input: '6.28318', expected: Math.cos(6.28318) },
        ],
        tan: [
            { input: '0', expected: 0 },
            { input: '1', expected: Math.tan(1) },
            { input: '0.785398', expected: Math.tan(0.785398) },
        ],
        asin: [
            { input: '0', expected: 0 },
            { input: '1', expected: Math.asin(1) },
            { input: '-1', expected: Math.asin(-1) },
            { input: '0.5', expected: Math.asin(0.5) },
            { input: '2', expected: 0 },
            { input: '-2', expected: 0 },
        ],
        acos: [
            { input: '0', expected: Math.acos(0) },
            { input: '1', expected: 0 },
            { input: '-1', expected: Math.acos(-1) },
            { input: '0.5', expected: Math.acos(0.5) },
            { input: '2', expected: 0 },
            { input: '-2', expected: 0 },
        ],
        atan: [
            { input: '0', expected: 0 },
            { input: '1', expected: Math.atan(1) },
            { input: '-1', expected: Math.atan(-1) },
            { input: '1e10', expected: Math.atan(1e10) },
            { input: '1e-10', expected: Math.atan(1e-10) },
        ],
        log: [
            { input: '1', expected: 0 },
            { input: '2.7182818', expected: 1 },
            { input: '10', expected: Math.log(10) },
            { input: '0', expected: 0 },
            { input: '-1', expected: 0 },
        ],
        log10: [
            { input: '1', expected: 0 },
            { input: '10', expected: 1 },
            { input: '100', expected: 2 },
            { input: '0', expected: 0 },
            { input: '-1', expected: 0 },
        ],
        exp: [
            { input: '0', expected: 1 },
            { input: '1', expected: Math.exp(1) },
            { input: '2', expected: Math.exp(2) },
            { input: '-10', expected: Math.exp(-10) },
        ],
        sqrt: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '4', expected: 2 },
            { input: '2', expected: Math.sqrt(2) },
            { input: '-1', expected: 1 },
        ],
        abs: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '-1', expected: 1 },
            { input: '-3.14159', expected: 3.14159 },
        ],
        floor: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '1.5', expected: 1 },
            { input: '-1.5', expected: -2 },
            { input: '3.9', expected: 3 },
        ],
        ceil: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '1.5', expected: 2 },
            { input: '-1.5', expected: -1 },
        ],
        int: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '1.5', expected: 1 },
            { input: '-1.5', expected: -1 },
        ],
        sqr: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '2', expected: 4 },
            { input: '-3', expected: 9 },
            { input: '1.5', expected: 2.25 },
        ],
        sign: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '-1', expected: -1 },
            { input: '0.5', expected: 1 },
            { input: '-0.5', expected: -1 },
        ],
        bnot: [
            { input: '0', expected: 1 },
            { input: '1', expected: 0 },
            { input: '0.000001', expected: 1 },
            { input: '0.0001', expected: 0 },
        ],
        invsqrt: [
            { input: '0', expected: 0 },
            { input: '1', expected: 1 },
            { input: '4', expected: 0.5 },
            { input: '2', expected: 1 / Math.sqrt(2) },
            { input: '-4', expected: 0.5 },
        ],
    };

    for (const [fnName, cases] of Object.entries(testCases)) {
        for (const tc of cases) {
            const result = runTest(fnName, tc.input, tc.expected);
            results.push(result);
        }
    }

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Math 1-Arg Functions Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected.toFixed(6)}, actual=${f.actual.toFixed(6)}`);
        }
    }

    assert(passed.length === results.length,
        `Math 1-arg functions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
