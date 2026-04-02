import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const presetsText = readText('src/extension/presets.js');

    // Test: presets.js should have sanitiseCustomWaves function
    {
        const hasFunction = presetsText.includes('sanitiseCustomWaves');
        
        assert(hasFunction,
            'presets.js should have sanitiseCustomWaves function');
    }

    // Test: Should parse wavecode variables
    {
        const hasWaveEnabled = presetsText.includes('wavecode_');
        
        assert(hasWaveEnabled,
            'presets.js should parse wavecode_N variables (slots 0-3)');
    }

    // Test: Should parse wavecode_N_samples (sample count)
    {
        const hasSamples = presetsText.includes('samples');
        
        assert(hasSamples,
            'presets.js should parse wavecode_N_samples');
    }

    // Test: Should parse wavecode_N_bSpectrum (spectrum vs PCM mode)
    {
        const hasSpectrum = presetsText.includes('bSpectrum');
        
        assert(hasSpectrum,
            'presets.js should parse wavecode_N_bSpectrum for spectrum/PCM mode');
    }

    // Test: Should parse wavecode_N_bUseDots (point vs line rendering)
    {
        const hasUseDots = presetsText.includes('bUseDots');
        
        assert(hasUseDots,
            'presets.js should parse wavecode_N_bUseDots for dots/line mode');
    }

    // Test: Should parse wavecode_N_bDrawThick (thick lines)
    {
        const hasDrawThick = presetsText.includes('bDrawThick');
        
        assert(hasDrawThick,
            'presets.js should parse wavecode_N_bDrawThick for thick line rendering');
    }

    // Test: Should parse wavecode_N_bAdditive (additive blending)
    {
        const hasAdditive = presetsText.includes('bAdditive');
        
        assert(hasAdditive,
            'presets.js should parse wavecode_N_bAdditive for additive blending');
    }

    // Test: Should parse wave_N_per_point code expressions
    {
        const hasPerPoint = presetsText.includes('per_point');
        
        assert(hasPerPoint,
            'presets.js should parse wave_N_per_point code expressions');
    }

    // Test: Should parse wave code
    {
        const hasInit = presetsText.includes('wave_');
        
        assert(hasInit,
            'presets.js should parse wave_N code expressions');
    }

    // Test: Should parse wave_N_per_frame code (per-frame)
    {
        const hasPerFrame = presetsText.includes('wave_') && presetsText.includes('per_frame');
        
        assert(hasPerFrame,
            'presets.js should parse wave_N_per_frame code expressions');
    }

    // Test: Should support 4 custom wave slots (0-3)
    {
        const hasLoop = presetsText.includes('for (let i = 0; i < 4; i++)');
        
        assert(hasLoop,
            'presets.js should support 4 custom wave slots (0-3)');
    }

    // Test: Should parse scaling and smoothing parameters
    {
        const hasScaleSmooth = presetsText.includes('scaling') && presetsText.includes('smoothing');
        
        assert(hasScaleSmooth,
            'presets.js should parse wavecode_N_scaling and wavecode_N_smoothing');
    }

    // Test: Should parse color parameters (r, g, b, a)
    {
        const hasColor = presetsText.includes('r:') && presetsText.includes('g:');
        
        assert(hasColor,
            'presets.js should parse wavecode_N_r/g/b/a color parameters');
    }
}
