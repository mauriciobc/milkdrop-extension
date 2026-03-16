/**
 * Golden per-frame evaluation parity test.
 * Compares evaluator output to golden JSON files (projectM test presets only).
 * Goldens live in tests/parity/golden/frame/*.golden.json. Preset .milk files
 * are loaded from projectm/presets/tests/ or tests/parity/golden/frame/presets/.
 * Run from repo root: gjs -m tests/run-parity.js
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { parseMilkPreset } from '../../../src/extension/milk-parser.js';
import { ExpressionEvaluator } from '../../../src/extension/expr/per-frame.js';

const EPSILON = 1e-5;
const FIXED_RAND_START = [0.1, 0.2, 0.3, 0.4];
const FIXED_RAND_PRESET = [0.5, 0.6, 0.7, 0.8];

function findPresetPath(sourceFile) {
    const cwd = GLib.get_current_dir();
    const projectmPath = GLib.build_filenamev([cwd, 'projectm', 'presets', 'tests', sourceFile]);
    if (GLib.file_test(projectmPath, GLib.FileTest.EXISTS))
        return projectmPath;
    const fallbackPath = GLib.build_filenamev([cwd, 'tests', 'parity', 'golden', 'frame', 'presets', sourceFile]);
    if (GLib.file_test(fallbackPath, GLib.FileTest.EXISTS))
        return fallbackPath;
    return null;
}

function readFile(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) return null;
    return new TextDecoder().decode(contents);
}

export function run(assert) {
    const cwd = GLib.get_current_dir();
    const goldenDir = GLib.build_filenamev([cwd, 'tests', 'parity', 'golden', 'frame']);
    if (!GLib.file_test(goldenDir, GLib.FileTest.IS_DIR)) {
        print('Golden frame: no golden directory, skip');
        return { passed: 0, failed: 0, results: [] };
    }

    const dir = Gio.File.new_for_path(goldenDir);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        print(`Golden frame: enumerate failed: ${e.message}`);
        return { passed: 0, failed: 0, results: [] };
    }

    const goldenFiles = [];
    let fileInfo;
    while ((fileInfo = enumerator.next_file(null)) !== null) {
        const name = fileInfo.get_name();
        if (name.endsWith('.golden.json'))
            goldenFiles.push(name);
    }
    enumerator.close(null);

    let totalPassed = 0;
    let totalFailed = 0;
    const results = [];

    for (const goldenFileName of goldenFiles.sort()) {
        const goldenPath = GLib.build_filenamev([goldenDir, goldenFileName]);
        const jsonStr = readFile(goldenPath);
        if (!jsonStr) {
            results.push({ preset: goldenFileName, pass: false, error: 'read failed' });
            totalFailed++;
            continue;
        }

        let golden;
        try {
            golden = JSON.parse(jsonStr);
        } catch (e) {
            results.push({ preset: goldenFileName, pass: false, error: `JSON: ${e.message}` });
            totalFailed++;
            continue;
        }

        const sourceFile = golden.sourceFile || `${golden.presetId}.milk`;
        const presetPath = findPresetPath(sourceFile);
        if (!presetPath) {
            print(`  SKIP ${goldenFileName} (preset ${sourceFile} not found)`);
            continue;
        }

        const milkContent = readFile(presetPath);
        if (!milkContent) {
            results.push({ preset: golden.presetId, pass: false, error: 'preset read failed' });
            totalFailed++;
            continue;
        }

        let preset;
        try {
            preset = parseMilkPreset(milkContent);
        } catch (e) {
            results.push({ preset: golden.presetId, pass: false, error: `parse: ${e.message}` });
            totalFailed++;
            continue;
        }

        preset.customWaves = preset.waves ?? [null, null, null, null];
        preset.customShapes = preset.shapes ?? [null, null, null, null];

        let ev;
        try {
            ev = new ExpressionEvaluator();
            ev.loadPreset(preset);
            ev.setRandForTesting(FIXED_RAND_START, FIXED_RAND_PRESET);
            ev.runInit();
        } catch (e) {
            results.push({ preset: golden.presetId, pass: false, error: `init: ${e.message}` });
            totalFailed++;
            continue;
        }

        let presetPassed = true;
        let frameErrors = [];

        for (const frame of golden.frames || []) {
            const inputs = { ...frame.inputs };
            if (frame.time !== undefined) inputs.time = frame.time;
            if (frame.frame !== undefined) inputs.frame = frame.frame;

            let ctx;
            try {
                ctx = ev.evaluateFrame(inputs);
            } catch (e) {
                frameErrors.push(`frame ${frame.frame}: ${e.message}`);
                presetPassed = false;
                continue;
            }

            for (const [key, expected] of Object.entries(frame.outputs || {})) {
                const actual = ctx[key];
                if (typeof actual !== 'number' || typeof expected !== 'number') {
                    if (actual !== expected)
                        frameErrors.push(`frame ${frame.frame} ${key}: expected ${expected}, got ${actual}`);
                    presetPassed = false;
                    continue;
                }
                if (Math.abs(actual - expected) > EPSILON) {
                    frameErrors.push(`frame ${frame.frame} ${key}: expected ${expected}, got ${actual}`);
                    presetPassed = false;
                }
            }
        }

        if (presetPassed) {
            totalPassed++;
            results.push({ preset: golden.presetId, pass: true });
        } else {
            totalFailed++;
            results.push({ preset: golden.presetId, pass: false, error: frameErrors[0] || 'frame mismatch', errors: frameErrors });
        }
    }

    print(`\n=== Golden Frame Evaluation ===`);
    print(`Total: ${totalPassed} passed, ${totalFailed} failed (${goldenFiles.length} golden file(s))`);
    for (const r of results) {
        if (!r.pass)
            print(`  FAIL ${r.preset}: ${r.error || ''}`);
    }

    assert(totalFailed === 0, `Golden frame: ${totalFailed} preset(s) failed`);
    return { passed: totalPassed, failed: totalFailed, results };
}
