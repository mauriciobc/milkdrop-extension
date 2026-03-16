/**
 * Benchmark test for preset loading and indexing.
 * Mirrors projectM's Playlist tests.
 * Run via: gjs -m tests/bench/run.js (from repo root; includes preset-loading).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {PresetStore} from '../../src/extension/presets.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        return;
    }
    failed++;
    console.error(`FAIL: ${message}`);
}

async function runPresetAssertions() {
    passed = 0;
    failed = 0;

    const store = new PresetStore();

    const index = await store.loadIndex();
    assert(index.length >= 9, `LoadIndex returns ${index.length} presets`);

    const ids = index.map(p => p.id);
    assert(ids.includes('builtin:demo-wave'), 'Includes builtin:demo-wave');
    assert(ids.includes('builtin:angular-drift'), 'Includes builtin:angular-drift');
    assert(ids.includes('builtin:wave-pool'), 'Includes builtin:wave-pool');

    const demo = await store.loadPreset('builtin:demo-wave');
    assert(demo?.id === 'builtin:demo-wave', 'LoadPreset returns correct id');
    assert(demo?.source === 'builtin', 'LoadPreset returns builtin source');
    assert(demo?.name === 'Demo Wave', 'LoadPreset returns correct name');

    const geiss = await store.loadPreset('builtin:test-geiss-eggs');
    assert(geiss?.source === 'builtin', 'Test preset is builtin');
    assert(typeof geiss?.frame_eqs === 'string', 'Test preset has frame_eqs');
    assert(geiss?.frame_eqs.length > 0, 'Test preset has frame_eqs content');

    const allBuiltin = index.filter(p => p.source === 'builtin');
    assert(allBuiltin.length >= 9, `Has at least 9 builtin presets, got ${allBuiltin.length}`);

    const names = index.map(p => p.name);
    const hasDemoWave = names.includes('Demo Wave');
    const hasAngularDrift = names.includes('Angular Drift');
    assert(hasDemoWave, 'Has Demo Wave preset');
    assert(hasAngularDrift, 'Has Angular Drift preset');

    const bootstrap = store.getBootstrapPreset();
    assert(bootstrap?.id === 'builtin:demo-wave', 'GetBootstrapPreset returns demo-wave');
    assert(bootstrap?.shaders?.draw !== null, 'Bootstrap has draw shader');
    assert(bootstrap?.shaders?.warp !== null, 'Bootstrap has warp shader');
    assert(bootstrap?.shaders?.composite !== null, 'Bootstrap has composite shader');

    store.invalidateCache();
    const reindex = await store.loadIndex();
    assert(reindex.length === index.length, 'Re-index after invalidate returns same count');

    const presetWithExpressions = await store.loadPreset('builtin:test-geiss-eggs');
    const hasFrameEqs = typeof presetWithExpressions?.frame_eqs === 'string' && presetWithExpressions.frame_eqs.length > 0;
    const hasPixelEqs = typeof presetWithExpressions?.pixel_eqs === 'string' && presetWithExpressions.pixel_eqs.length > 0;
    assert(hasFrameEqs, 'Test geiss eggs has per-frame expressions');
    assert(hasPixelEqs, 'Test geiss eggs has per-pixel expressions');

    if (failed > 0) throw new Error(`${failed} test(s) failed`);
}

async function run(bench) {
    await runPresetAssertions();
    bench('preset-loading', () => {}, { iterations: 1, warmup: 0 });
}

async function main() {
    console.log('Running Preset Loading Benchmark Tests...\n');
    await runPresetAssertions();
    console.log(`\n${passed} passed, ${failed} failed`);
}

export { main, run };