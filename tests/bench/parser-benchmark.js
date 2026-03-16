/**
 * Benchmark test mirroring projectM's PresetFileParserTest.cpp
 * Validates our preset parsing against projectM behavior.
 * Run via: gjs -m tests/bench/run.js (from repo root; includes parser-parity).
 */

import GLib from 'gi://GLib';

import {
    parsePresetValues,
    parseCodeBlock,
    getInt,
    getFloat,
    getBool,
} from '../../src/extension/milk-parser.js';

const TEST_DATA_DIR = 'tests/bench/data/PresetFileParser';

function readFile(path) {
    const file = GLib.file_get_contents(path);
    if (!file[0]) return null;
    return new TextDecoder().decode(file[1]);
}

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

function runParserAssertions() {
    passed = 0;
    failed = 0;

    const emptyContent = readFile(`${TEST_DATA_DIR}/parser-empty.milk`);
    assert(emptyContent === null || emptyContent.trim() === '', 'ReadEmptyFile');

    const simpleContent = readFile(`${TEST_DATA_DIR}/parser-simple.milk`);
    assert(simpleContent !== null && simpleContent.length > 0, 'ReadSimpleFile');

    if (simpleContent) {
        const values = parsePresetValues(simpleContent);
        assert(!values['empty_key'], 'EmptyKey ignored');
        assert(values['empty_value'] === '', 'EmptyValue stored');
        assert(values['value_with_space'] === '123', 'SpaceDelimiter');
        assert(values['warp'] === '0', 'ReadSimpleValue');
    }

    const codeContent = readFile(`${TEST_DATA_DIR}/parser-code.milk`);
    if (codeContent) {
        const code = parseCodeBlock(codeContent, 'per_frame_');
        assert(code.includes('r=1.0;'), 'GetCode r');
        assert(code.includes('g=1.0;'), 'GetCode g');
        assert(code.includes('b=1.0;'), 'GetCode b');

        const gapCode = parseCodeBlock(codeContent, 'per_frame_gap_');
        assert(gapCode.includes('r=1.0;') && gapCode.includes('g=1.0;'), 'GetCodeWithGap');
        assert(!gapCode.includes('b=1.0;'), 'GetCodeGapStops');

        const repeatCode = parseCodeBlock(codeContent, 'per_frame_repeat_');
        assert(repeatCode.includes('r=1.0;') && repeatCode.includes('g=1.0;'), 'GetCodeWithRepeat');
        assert(!repeatCode.includes('pi=3.141'), 'GetCodeRepeatFirst');

        const multiLineCode = parseCodeBlock(codeContent, 'multiline_comment_');
        assert(multiLineCode.includes('r = 1.0;') && multiLineCode.includes('g = 1.0;'), 'GetCodeMultilineComment');

        const warpCode = parseCodeBlock(codeContent, 'warp_');
        assert(warpCode.includes('r=1.0;') && warpCode.includes('g=1.0;'), 'GetCodeShaderSyntax');
    }

    const valueContent = readFile(`${TEST_DATA_DIR}/parser-valueconversion.milk`);
    if (valueContent) {
        const values = parsePresetValues(valueContent);
        assert(getInt(values['nVideoEchoOrientation'], 0) === 3, 'GetIntValid');
        assert(getInt(values['nSomeWeirdStuff'], 123) === 123, 'GetIntInvalid');
        assert(getInt(values['RandomKey'], 123) === 123, 'GetIntDefault');

        const echoAlpha = getFloat(values['fVideoEchoAlpha'], 0);
        assert(Math.abs(echoAlpha - 0.5) < 0.001, 'GetFloatValid');
        assert(getFloat(values['fSomeWeirdStuff'], 123.0) === 123.0, 'GetFloatInvalid');
        assert(getFloat(values['RandomKey'], 123.0) === 123.0, 'GetFloatDefault');

        assert(getBool(values['bAdditiveWaves'], false) === true, 'GetBoolValid');
        assert(getBool(values['bSomeWeirdStuff'], true) === true, 'GetBoolInvalid');
        assert(getBool(values['RandomKey'], true) === true, 'GetBoolDefault');
    }

    if (failed > 0) throw new Error(`${failed} test(s) failed`);
}

function run(bench) {
    bench('parser-parity', () => runParserAssertions(), { iterations: 1, warmup: 0 });
}

async function main() {
    console.log('Running PresetFileParser Benchmark Tests...\n');
    runParserAssertions();
    console.log(`\n${passed} passed, ${failed} failed`);
}

export { main, run };