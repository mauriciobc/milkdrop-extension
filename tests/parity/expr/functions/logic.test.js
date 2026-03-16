import { compile } from '../../../../src/extension/expr/compiler.js';

const EPSILON = 0.00001;

function runTest(fnName, input1, input2, expected) {
    const expr = `result = ${fnName}(${input1},${input2})`;
    const fn = compile(expr);
    const ctx = { time: 0, frame: 0, fps: 60 };
    fn(ctx);
    const result = ctx.result;
    const pass = Math.abs(result - expected) < EPSILON;
    return { fnName, input1, input2, expected, actual: result, pass, expr };
}

function run3Test(fnName, input1, input2, input3, expected) {
    const expr = `result = ${fnName}(${input1},${input2},${input3})`;
    const fn = compile(expr);
    const ctx = { time: 0, frame: 0, fps: 60 };
    fn(ctx);
    const result = ctx.result;
    const pass = Math.abs(result - expected) < EPSILON;
    return { fnName, input1, input2, input3, expected, actual: result, pass, expr };
}

export function run(assert) {
    const results = [];

    const testCases = {
        equal: [
            { input1: '0', input2: '0', expected: 1 },
            { input1: '1', input2: '1', expected: 1 },
            { input1: '1', input2: '2', expected: 0 },
            { input1: '0.1', input2: '0.1', expected: 1 },
            { input1: '0.1', input2: '0.100001', expected: 0 },
            { input1: '1e-10', input2: '0', expected: 0 },
            { input1: '1e-10', input2: '1e-10', expected: 1 },
        ],
        above: [
            { input1: '1', input2: '0', expected: 1 },
            { input1: '0', input2: '1', expected: 0 },
            { input1: '1', input2: '1', expected: 0 },
            { input1: '-1', input2: '0', expected: 0 },
            { input1: '0.5', input2: '0.4', expected: 1 },
        ],
        below: [
            { input1: '0', input2: '1', expected: 1 },
            { input1: '1', input2: '0', expected: 0 },
            { input1: '1', input2: '1', expected: 0 },
            { input1: '0', input2: '-1', expected: 0 },
            { input1: '0.4', input2: '0.5', expected: 1 },
        ],
        bor: [
            { input1: '0', input2: '0', expected: 0 },
            { input1: '1', input2: '0', expected: 1 },
            { input1: '0', input2: '1', expected: 1 },
            { input1: '1', input2: '1', expected: 1 },
            { input1: '0.5', input2: '0', expected: 1 },
            { input1: '0.00001', input2: '0', expected: 1 },
            { input1: '0.000001', input2: '0', expected: 0 },
        ],
        band: [
            { input1: '1', input2: '1', expected: 1 },
            { input1: '1', input2: '0', expected: 0 },
            { input1: '0', input2: '1', expected: 0 },
            { input1: '0', input2: '0', expected: 0 },
            { input1: '0.5', input2: '0.5', expected: 1 },
            { input1: '0.00001', input2: '0.00001', expected: 1 },
            { input1: '0.000001', input2: '0.000001', expected: 0 },
        ],
    };

    const testCases3 = {
        if: [
            { input1: '1', input2: '10', input3: '20', expected: 10 },
            { input1: '0', input2: '10', input3: '20', expected: 20 },
            { input1: '0.5', input2: '10', input3: '20', expected: 10 },
            { input1: '0.00001', input2: '10', input3: '20', expected: 10 },
            { input1: '0.000001', input2: '10', input3: '20', expected: 20 },
            { input1: '-1', input2: '10', input3: '20', expected: 10 },
        ],
    };

    for (const [fnName, cases] of Object.entries(testCases)) {
        for (const tc of cases) {
            const result = runTest(fnName, tc.input1, tc.input2, tc.expected);
            results.push(result);
        }
    }

    for (const [fnName, cases] of Object.entries(testCases3)) {
        for (const tc of cases) {
            const result = run3Test(fnName, tc.input1, tc.input2, tc.input3, tc.expected);
            results.push(result);
        }
    }

    const failed = results.filter(r => !r.pass);
    const passed = results.filter(r => r.pass);

    print(`\n=== Logic/Comparison Functions Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            const detail = f.input3 !== undefined
                ? `${f.input1}, ${f.input2}, ${f.input3}`
                : `${f.input1}, ${f.input2}`;
            print(`  ${f.fnName}(${detail}): expected=${f.expected}, actual=${f.actual}`);
        }
    }

    assert(passed.length === results.length,
        `Logic functions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
