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
    assert(Array.isArray(index), 'LoadIndex returns an array');
    assert(index.every(p => p?.source === 'file'), 'LoadIndex only returns file presets');
    assert(index.every(p => typeof p?.id === 'string' && p.id.startsWith('file:')), 'All preset IDs are file-based');

    if (index.length > 0) {
        const first = await store.loadPreset(index[0].id);
        assert(first?.id === index[0].id, 'LoadPreset returns the expected file preset');
        assert(first?.source === 'file', 'LoadPreset returns file source');
        assert(typeof first?.name === 'string' && first.name.length > 0, 'Loaded file preset has a name');
    } else {
        let threw = false;
        try {
            await store.loadPreset('file:/definitely-not-found.milk');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'LoadPreset throws for missing preset when index is empty');
    }

    const bootstrap = store.getBootstrapPreset();
    assert(typeof bootstrap?.id === 'string' && bootstrap.id.length > 0, 'GetBootstrapPreset returns an id');
    assert(bootstrap?.shaders?.draw !== null, 'Bootstrap has draw shader');
    assert(bootstrap?.shaders?.warp !== null, 'Bootstrap has warp shader');
    assert(bootstrap?.shaders?.composite !== null, 'Bootstrap has composite shader');

    store.invalidateCache();
    const reindex = await store.loadIndex();
    assert(reindex.length === index.length, 'Re-index after invalidate returns same count');

    if (reindex.length > 0) {
        const presetWithExpressions = await store.loadPreset(reindex[0].id);
        const hasFrameEqs = typeof presetWithExpressions?.frame_eqs === 'string';
        const hasPixelEqs = typeof presetWithExpressions?.pixel_eqs === 'string';
        assert(hasFrameEqs, 'Loaded file preset exposes frame_eqs field');
        assert(hasPixelEqs, 'Loaded file preset exposes pixel_eqs field');
    }

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