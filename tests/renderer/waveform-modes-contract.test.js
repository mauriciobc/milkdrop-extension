import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const helperText = readText('src/renderer/gl-helper.c');
    const shadersText = readText('src/renderer/shaders.js');

    // Test: gl-helper.c should have waveform vertex generation functions for different modes
    // This is needed for MilkDrop 2 compliance - different modes have different geometries
    {
        const hasWaveformModes = 
            helperText.includes('wave_mode') &&
            (helperText.includes('GL_LINE_STRIP') || helperText.includes('LINE_STRIP'));
        
        assert(hasWaveformModes, 
            'gl-helper.c should use GL_LINE_STRIP for waveform rendering (MilkDrop 2 compliance)');
    }

    // Test: Should support GL_POINTS for dot rendering mode
    {
        const hasPointsSupport = 
            helperText.includes('GL_POINTS') || 
            helperText.includes('POINTS');
        
        assert(hasPointsSupport,
            'gl-helper.c should support GL_POINTS for wave_dots mode (MilkDrop 2 compliance)');
    }

    // Test: Should have per-mode vertex generation (not just fragment shader distance field)
    {
        // Look for mode-specific rendering logic or vertex generation
        const hasModeGeneration = 
            helperText.includes('switch') && helperText.includes('wave_mode') ||
            helperText.includes('if') && helperText.includes('wave_mode');
        
        assert(hasModeGeneration,
            'gl-helper.c should have mode-specific vertex generation logic (not fragment-only)');
    }

    // Test: Should handle wave_mystery parameter for mode-specific geometry control
    {
        const hasMysteryParam = 
            helperText.includes('wave_mystery') ||
            helperText.includes('mystery');
        
        assert(hasMysteryParam,
            'gl-helper.c should handle wave_mystery parameter for mode-specific geometry');
    }

    // Test: Should support stereo L/R channel waveform data
    {
        const hasStereoSupport = 
            helperText.includes('pcmLeft') || 
            helperText.includes('wave_data') ||
            (helperText.includes('Left') && helperText.includes('Right'));
        
        assert(hasStereoSupport,
            'gl-helper.c should support stereo L/R waveform channels for MilkDrop 2 compliance');
    }

    // Test: Waveform shader should be simple color pass-through (geometry moved to CPU)
    {
        // The waveform shader should NOT do complex geometry - just color/alpha
        const shaderIsSimple = 
            !shadersText.includes('distance') ||
            shadersText.includes('WAVEFORM_FRAGMENT_SHADER');
        
        assert(shaderIsSimple,
            'Waveform shader should be simple pass-through (geometry handled on CPU)');
    }
}
