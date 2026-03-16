/**
 * Parity tests for .milk preset parser (projectM PresetFileParser behavior).
 * Parser implementation lives in src/extension/milk-parser.js.
 */

import GLib from 'gi://GLib';

import {
    parsePresetValues,
    parseCodeBlock,
    parseMilkPreset,
} from '../../../src/extension/milk-parser.js';

export function run(assert) {
    const results = [];
    
    function test(name, condition) {
        if (condition) {
            results.push({ name, pass: true });
        } else {
            results.push({ name, pass: false, error: 'assertion failed' });
        }
    }
    
    test('parsePresetValues exists', typeof parsePresetValues === 'function');
    test('parseCodeBlock exists', typeof parseCodeBlock === 'function');
    test('parseMilkPreset exists', typeof parseMilkPreset === 'function');
    
    const simpleContent = `
name=Test Preset
fDecay=0.98
fZoom=1.0
fRot=0.01
per_frame_1=zoom = zoom + 0.1;
per_frame_2=rot = rot + 0.02;
`;
    
    const parsed = parseMilkPreset(simpleContent);
    test('parses name', parsed.name === 'Test Preset');
    test('parses decay', parsed.baseVals.decay === 0.98);
    test('parses zoom', parsed.baseVals.zoom === 1.0);
    test('parses rot', parsed.baseVals.rot === 0.01);
    test('parses frame_eqs', parsed.frame_eqs.includes('zoom = zoom + 0.1'));
    test('parses frame_eqs 2', parsed.frame_eqs.includes('rot = rot + 0.02'));
    
    const waveContent = `
name=Wave Test
wavecode_0_enabled=1
wavecode_0_samples=512
wavecode_0_r=1.0
wavecode_0_g=0.5
wave_0_per_point1=x = sample;
wave_0_per_point2=y = y + value1;
`;
    
    const waveParsed = parseMilkPreset(waveContent);
    test('parses wave enabled', waveParsed.waves[0]?.baseVals?.enabled === 1);
    test('parses wave samples', waveParsed.waves[0]?.baseVals?.samples === 512);
    test('parses wave color r', waveParsed.waves[0]?.baseVals?.r === 1.0);
    test('parses wave per_point', waveParsed.waves[0]?.point_eqs?.includes('x = sample'));
    
    const shapeContent = `
name=Shape Test
shapecode_0_enabled=1
shapecode_0_sides=6
shapecode_0_x=0.5
shape_0_init=x = 0.5;
shape_0_per_frame=rad = rad + 0.01;
`;
    
    const shapeParsed = parseMilkPreset(shapeContent);
    test('parses shape enabled', shapeParsed.shapes[0]?.baseVals?.enabled === 1);
    test('parses shape sides', shapeParsed.shapes[0]?.baseVals?.sides === 6);
    test('parses shape x', shapeParsed.shapes[0]?.baseVals?.x === 0.5);
    test('parses shape init', shapeParsed.shapes[0]?.init_eqs?.includes('x = 0.5'));
    test('parses shape per_frame', shapeParsed.shapes[0]?.frame_eqs?.includes('rad = rad + 0.01'));
    
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    
    print(`\n=== Milk Preset Parser Tests ===`);
    print(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    
    if (failed > 0) {
        for (const r of results.filter(r => !r.pass)) {
            print(`  FAIL: ${r.name}`);
        }
    }
    
    assert(passed === results.length, `Parser tests: ${passed}/${results.length} passed`);
    
    print('\n--- Parsing ProjectM Test Presets ---');
    
    const projectMPresetsDir = './projectm/presets/tests';
    const testPresets = [
        '000-empty.milk',
        '001-line.milk',
        '100-square.milk',
        '101-per_frame.milk',
        '102-per_frame3.milk',
        '103-multiple-eqn.milk',
        '104-continued-eqn.milk',
        '105-per_frame_init.milk',
        '110-per_pixel.milk',
        '200-wave.milk',
        '240-wave-smooth-00.milk',
    ];
    
    let parsedCount = 0;
    let parseFailCount = 0;
    
    for (const presetFile of testPresets) {
        try {
            const path = GLib.build_filenamev([GLib.get_current_dir(), projectMPresetsDir, presetFile]);
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) {
                print(`  SKIP: ${presetFile} - file not found`);
                continue;
            }
            const content = new TextDecoder().decode(contents);
            const parsed = parseMilkPreset(content);
            
            if (parsed.name && parsed.name !== 'Unnamed') {
                parsedCount++;
                print(`  OK: ${presetFile} -> "${parsed.name}"`);
            } else {
                parseFailCount++;
                print(`  WARN: ${presetFile} - no name found`);
            }
        } catch (e) {
            parseFailCount++;
            print(`  FAIL: ${presetFile} - ${e.message}`);
        }
    }
    
    print(`\nProjectM Presets: ${parsedCount} parsed, ${parseFailCount} failed`);
    
    return { passed, failed, results };
}
