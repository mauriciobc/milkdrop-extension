#!/usr/bin/env gjs
/**
 * Generate golden JSON files for per-frame evaluation parity.
 * Uses only projectM test presets (projectm/presets/tests/*.milk or
 * tests/parity/golden/frame/presets/). Run from repo root:
 *   gjs -m tools/generate-golden-frames.js
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const PRESET_NAMES = [
    '000-empty.milk', '001-line.milk', '100-square.milk', '101-per_frame.milk',
    '102-per_frame3.milk', '103-multiple-eqn.milk', '104-continued-eqn.milk',
    '105-per_frame_init.milk', '110-per_pixel.milk', '200-wave.milk',
    '240-wave-smooth-00.milk',
];

const NUM_FRAMES = 20;
const FPS = 30;
const FIXED_RAND_START = [0.1, 0.2, 0.3, 0.4];
const FIXED_RAND_PRESET = [0.5, 0.6, 0.7, 0.8];
const OUTPUT_KEYS = ['zoom', 'rot', 'dx', 'dy', 'decay'];

function findPresetDir() {
    const cwd = GLib.get_current_dir();
    const projectmDir = GLib.build_filenamev([cwd, 'projectm', 'presets', 'tests']);
    if (GLib.file_test(projectmDir, GLib.FileTest.IS_DIR))
        return projectmDir;
    const fallbackDir = GLib.build_filenamev([cwd, 'tests', 'parity', 'golden', 'frame', 'presets']);
    if (GLib.file_test(fallbackDir, GLib.FileTest.IS_DIR))
        return fallbackDir;
    return null;
}

function readFile(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) return null;
    return new TextDecoder().decode(contents);
}

function writeFile(path, str) {
    return GLib.file_set_contents(path, str);
}

async function main() {
    const presetDir = findPresetDir();
    if (!presetDir) {
        printerr('Neither projectm/presets/tests nor tests/parity/golden/frame/presets found. Run from repo root or add presets.\n');
        return 1;
    }

    const { parseMilkPreset } = await import('../src/extension/milk-parser.js');
    const { ExpressionEvaluator } = await import('../src/extension/expr/per-frame.js');

    const outDir = GLib.build_filenamev([GLib.get_current_dir(), 'tests', 'parity', 'golden', 'frame']);
    if (!GLib.file_test(outDir, GLib.FileTest.IS_DIR)) {
        Gio.File.new_for_path(outDir).make_directory_with_parents(null);
    }

    let generated = 0;
    let skipped = 0;

    for (const fileName of PRESET_NAMES) {
        const presetPath = GLib.build_filenamev([presetDir, fileName]);
        if (!GLib.file_test(presetPath, GLib.FileTest.EXISTS)) {
            print(`SKIP ${fileName} (not found)`);
            skipped++;
            continue;
        }

        const content = readFile(presetPath);
        if (!content) {
            print(`SKIP ${fileName} (read failed)`);
            skipped++;
            continue;
        }

        let preset;
        try {
            preset = parseMilkPreset(content);
        } catch (e) {
            print(`SKIP ${fileName} (parse: ${e.message})`);
            skipped++;
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
            print(`SKIP ${fileName} (compile/init: ${e.message})`);
            skipped++;
            continue;
        }

        const frames = [];
        for (let f = 0; f < NUM_FRAMES; f++) {
            const time = f / FPS;
            const inputs = {
                time,
                frame: f,
                fps: FPS,
                progress: NUM_FRAMES > 1 ? f / (NUM_FRAMES - 1) : 0,
                bass: 0,
                mid: 0,
                treb: 0,
                high: 0,
                bass_att: 0,
                mid_att: 0,
                treb_att: 0,
                energy: 0,
                beat: 0,
            };
            const ctx = ev.evaluateFrame(inputs);
            const outputs = {};
            for (const k of OUTPUT_KEYS)
                outputs[k] = ctx[k];

            frames.push({
                frame: f,
                time,
                inputs,
                outputs,
            });
        }

        const presetId = fileName.replace(/\.milk$/, '');
        const golden = {
            version: 1,
            presetId,
            sourceFile: fileName,
            description: 'projectM test preset',
            seed: 12345,
            frames,
        };

        const outPath = GLib.build_filenamev([outDir, `${presetId}.golden.json`]);
        const jsonStr = JSON.stringify(golden, null, 2);
        if (!writeFile(outPath, jsonStr)) {
            printerr(`FAIL write ${outPath}\n`);
            return 1;
        }
        print(`OK ${presetId}.golden.json (${frames.length} frames)`);
        generated++;
    }

    print(`\nGenerated ${generated}, skipped ${skipped}`);
    return 0;
}

main().then(code => {
    if (code !== 0)
        imports.system.exit(code);
}).catch(e => {
    printerr(e.message);
    if (e.stack) printerr(e.stack);
    imports.system.exit(1);
});
