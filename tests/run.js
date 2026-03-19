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
    await runTest('extension/settings-contract', './extension/settings-contract.test.js');
    await runTest('extension/frame-state-contract', './extension/frame-state-contract.test.js');
    await runTest('extension/audio', './extension/audio.test.js');
    await runTest('extension/audio-pcm-contract', './extension/audio-pcm-contract.test.js');
    await runTest('extension/preset-ipc-contract', './extension/preset-ipc-contract.test.js');
    await runTest('extension/preset-crash-quarantine', './extension/preset-crash-quarantine.test.js');
    await runTest('extension/preset-probe-policy', './extension/preset-probe-policy.test.js');
    await runTest('extension/window-title', './extension/window-title.test.js');
    await runTest('extension/mpris-watcher', './extension/mpris-watcher.test.js');
    await runTest('renderer/gl-bridge', './renderer/gl-bridge.test.js');
    await runTest('renderer/glarea', './renderer/glarea.test.js');
    await runTest('renderer/ipc-client', './renderer/ipc-client.test.js');
    await runTest('renderer/preset-load-contract', './renderer/preset-load-contract.test.js');
    await runTest('renderer/renderer', './renderer/renderer.test.js');
    await runTest('extension/expr/lexer', './extension/expr/lexer.test.js');
    await runTest('extension/expr/parser', './extension/expr/parser.test.js');
    await runTest('extension/expr/compiler', './extension/expr/compiler.test.js');
    await runTest('extension/expr/context', './extension/expr/context.test.js');
    await runTest('extension/expr/per-frame', './extension/expr/per-frame.test.js');
    await runTest('extension/expr/per-pixel', './extension/expr/per-pixel.test.js');
    await runTest('extension/expr/custom-shapes', './extension/expr/custom-shapes.test.js');
    await runTest('extension/expr/custom-waves', './extension/expr/custom-waves.test.js');
    await runTest('extension/preset-custom-wave-contract', './extension/preset-custom-wave-contract.test.js');
    await runTest('extension/preset-custom-shape-contract', './extension/preset-custom-shape-contract.test.js');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0)
        throw new Error(`${failed} test(s) failed`);
}

main().catch(e => {
    console.error(e);
    throw e;
});
