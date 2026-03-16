#!/usr/bin/env gjs -m

import GLib from 'gi://GLib';

const PARITY_TESTS = [
    { name: 'Math 1-Arg Functions', module: './parity/expr/functions/math-1arg.test.js' },
    { name: 'Math 2-Arg Functions', module: './parity/expr/functions/math-2arg.test.js' },
    { name: 'Logic/Comparison Functions', module: './parity/expr/functions/logic.test.js' },
    { name: 'Bitwise Functions', module: './parity/expr/functions/bitwise.test.js' },
    { name: 'Memory Functions', module: './parity/expr/functions/memory.test.js' },
    { name: 'Per-Frame RO Variables', module: './parity/expr/variables/per-frame-ro.test.js' },
    { name: 'Per-Frame RW Variables', module: './parity/expr/variables/per-frame-rw.test.js' },
    { name: 'Complex Expressions', module: './parity/expr/complex.test.js' },
    { name: 'Preset Parser', module: './parity/expr/preset-parser.test.js' },
    { name: 'Frame Evaluation', module: './parity/expr/frame-evaluation.test.js' },
    { name: 'Golden frame evaluation', module: './parity/expr/golden-frame.test.js' },
    { name: 'Visual Parity', module: './parity/visual/visual.test.js' },
];

function parseArgs(argv) {
    const opts = {
        verbose: false,
        phase: null,
        test: null,
        list: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--verbose' || arg === '-v') opts.verbose = true;
        else if (arg === '--phase' && argv[i + 1]) opts.phase = argv[++i];
        else if (arg === '--test' && argv[i + 1]) opts.test = argv[++i];
        else if (arg === '--list' || arg === '-l') opts.list = true;
    }
    return opts;
}

async function runTest(test) {
    try {
        const module = await import(test.module);
        const mockAssert = (condition, message) => {
            if (!condition) {
                throw new Error(`Assert failed: ${message}`);
            }
        };
        return module.run(mockAssert);
    } catch (error) {
        print(`ERROR: ${test.name}: ${error.message}`);
        if (error.stack) {
            const lines = error.stack.split('\n');
            for (const line of lines.slice(0, 5)) {
                print(`  ${line}`);
            }
        }
        return { passed: 0, failed: 1, error: error.message };
    }
}

async function main() {
    const opts = parseArgs(ARGV ?? []);

    print('='.repeat(60));
    print('MilkDrop Expression Engine Parity Tests');
    print('='.repeat(60));

    if (opts.list) {
        print('\nAvailable tests:');
        for (let i = 0; i < PARITY_TESTS.length; i++) {
            print(`  ${i + 1}. ${PARITY_TESTS[i].name}`);
        }
        return;
    }

    const testsToRun = PARITY_TESTS.filter(t => {
        if (opts.phase) return false;
        if (opts.test) return t.name.toLowerCase().includes(opts.test.toLowerCase());
        return true;
    });

    if (testsToRun.length === 0) {
        print('\nNo tests matched the criteria.');
        print('Use --list to see available tests, or --test <name> to filter.');
        return;
    }

    const results = [];
    let totalPassed = 0;
    let totalFailed = 0;

    for (const test of testsToRun) {
        print(`\n▶ Running: ${test.name}`);
        const result = await runTest(test);
        results.push({ name: test.name, ...result });
        totalPassed += result.passed;
        totalFailed += result.failed;
    }

    print('\n' + '='.repeat(60));
    print('RESULTS SUMMARY');
    print('='.repeat(60));

    for (const r of results) {
        const status = r.failed > 0 ? '❌ FAIL' : '✓ PASS';
        print(`  ${status} | ${r.name}: ${r.passed} passed, ${r.failed} failed`);
    }

    print('='.repeat(60));
    print(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);

    if (totalFailed > 0) {
        print('\n⚠ Some parity tests failed. Review output above for details.');
        throw new Error(`Parity tests failed: ${totalFailed} failures`);
    } else {
        print('\n✓ All expression engine parity tests passed!');
    }
}

main();
