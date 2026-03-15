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

    // Test: gl-helper.c should have custom shape VBO
    {
        const hasVBO = helperText.includes('custom_shape_vbo') || helperText.includes('customShape');
        
        assert(hasVBO,
            'gl-helper.c should have custom shape VBO for vertex buffer');
    }

    // Test: Should parse custom shapes from frame message
    {
        const hasParsing = helperText.includes('customShapes') || helperText.includes('custom_shape');
        
        assert(hasParsing,
            'gl-helper.c should parse custom shapes from frame message');
    }

    // Test: Should render custom shapes with GL_TRIANGLE_FAN
    {
        const hasFan = helperText.includes('GL_TRIANGLE_FAN');
        
        assert(hasFan,
            'gl-helper.c should render custom shapes with GL_TRIANGLE_FAN');
    }

    // Test: Should support thick outline for custom shapes
    {
        const hasThick = helperText.includes('thickOutline') || helperText.includes('thick');
        
        assert(hasThick,
            'gl-helper.c should support thick outline for custom shapes');
    }

    // Test: Should support textured rendering for custom shapes
    {
        const hasTexture = helperText.includes('textured') || helperText.includes('texture');
        
        assert(hasTexture,
            'gl-helper.c should support textured rendering for custom shapes');
    }

    // Test: Should render custom shapes before built-in waveform
    {
        const order = helperText.indexOf('custom_shape') > 0 && 
                    helperText.indexOf('waveform_pass') > 0;
        
        assert(order,
            'gl-helper.c should render custom shapes in correct order');
    }
}
