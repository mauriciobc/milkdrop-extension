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

export function run(assert) {
    const results = [];

    const testCases = {
        bitor: [
            { input1: '0', input2: '0', expected: 0 },
            { input1: '1', input2: '2', expected: 3 },
            { input1: '5', input2: '3', expected: 7 },
            { input1: '8', input2: '4', expected: 12 },
            { input1: '255', input2: '0', expected: 255 },
            { input1: '0', input2: '255', expected: 255 },
            { input1: '1.5', input2: '2.5', expected: 3 },
            { input1: '-1', input2: '1', expected: -1 },
            { input1: '1.7', input2: '2.3', expected: 3 },
        ],
        bitand: [
            { input1: '7', input2: '3', expected: 3 },
            { input1: '7', input2: '1', expected: 1 },
            { input1: '15', input2: '7', expected: 7 },
            { input1: '8', input2: '4', expected: 0 },
            { input1: '255', input2: '255', expected: 255 },
            { input1: '255', input2: '0', expected: 0 },
            { input1: '5.9', input2: '3.1', expected: 5 & 3 },
            { input1: '-1', input2: '7', expected: -1 & 7 },
            { input1: '10.7', input2: '6.3', expected: 10 & 6 },
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

    print(`\n=== Bitwise Functions Parity Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

    if (failed.length > 0) {
        print('\nFailed tests:');
        for (const f of failed) {
            print(`  ${f.expr}: expected=${f.expected}, actual=${f.actual}`);
        }
    }

    assert(passed.length === results.length,
        `Bitwise functions: ${passed.length}/${results.length} passed`);

    return { passed: passed.length, failed: failed.length, results };
}
