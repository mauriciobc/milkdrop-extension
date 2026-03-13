/**
 * Minimal unit test runner for gnome-milkdrop.
 * Run from repo root: gjs -m tests/run.js
 *
 * Each test module exports run(assert), where assert(condition, message)
 * records a failure when condition is false and continues execution.
 */

let failed = 0;
let passed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        return;
    }
    failed++;
    console.error(`FAIL: ${message}`);
}

async function main() {
    console.log('Running unit tests...\n');

    const runTest = async (name, modulePath) => {
        try {
            const mod = await import(modulePath);
            if (typeof mod.run === 'function') {
                const maybePromise = mod.run(assert);
                if (maybePromise && typeof maybePromise.then === 'function')
                    await maybePromise;
            } else {
                assert(false, `${name}: module has no run(assert) export`);
            }
        } catch (e) {
            failed++;
            console.error(`${name}: ${e.message}`);
            if (e.stack)
                console.error(e.stack);
        }
    };

    await runTest('extension/evaluator', './extension/evaluator.test.js');
    await runTest('extension/presets', './extension/presets.test.js');
    await runTest('extension/audio', './extension/audio.test.js');
    await runTest('extension/window-title', './extension/window-title.test.js');
    await runTest('renderer/vertex-eval', './renderer/vertex-eval.test.js');
    await runTest('renderer/mesh', './renderer/mesh.test.js');
    await runTest('renderer/gl-bridge', './renderer/gl-bridge.test.js');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0)
        throw new Error(`${failed} test(s) failed`);
}

main().catch(e => {
    console.error(e);
    throw e;
});
