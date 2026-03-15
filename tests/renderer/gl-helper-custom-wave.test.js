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

    // Test: gl-helper.c should have custom wave VBO
    {
        const hasVBO = helperText.includes('custom_wave_vbo') || helperText.includes('customWave');
        
        assert(hasVBO,
            'gl-helper.c should have custom wave VBO for vertex buffer');
    }

    // Test: Should parse custom waves from frame message
    {
        const hasParsing = helperText.includes('customWaves') || helperText.includes('custom_wave');
        
        assert(hasParsing,
            'gl-helper.c should parse custom waves from frame message');
    }

    // Test: Should render custom waves with GL_LINE_STRIP or GL_POINTS
    {
        const hasRendering = helperText.includes('GL_LINE_STRIP') || helperText.includes('GL_POINTS');
        
        assert(hasRendering,
            'gl-helper.c should render custom waves with GL_LINE_STRIP or GL_POINTS');
    }

    // Test: Should support custom wave additive blending
    {
        const hasAdditive = helperText.includes('customWave') && helperText.includes('additive');
        
        assert(hasAdditive,
            'gl-helper.c should support additive blending for custom waves');
    }

    // Test: Should support thick lines for custom waves
    {
        const hasThick = helperText.includes('customWave') && helperText.includes('Thick');
        
        assert(hasThick,
            'gl-helper.c should support thick lines for custom waves');
    }
}
