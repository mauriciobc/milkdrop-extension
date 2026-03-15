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

    // Test: presets.js should have sanitiseCustomShapes function
    {
        const hasFunction = presetsText.includes('sanitiseCustomShapes');
        
        assert(hasFunction,
            'presets.js should have sanitiseCustomShapes function');
    }

    // Test: Should parse shapecode variables
    {
        const hasShapeEnabled = presetsText.includes('shapecode_');
        
        assert(hasShapeEnabled,
            'presets.js should parse shapecode_N variables (slots 0-3)');
    }

    // Test: Should parse shapecode_N_sides (polygon sides)
    {
        const hasSides = presetsText.includes('sides');
        
        assert(hasSides,
            'presets.js should parse shapecode_N_sides for polygon sides');
    }

    // Test: Should parse shapecode_N_x and shapecode_N_y (position)
    {
        const hasPosition = presetsText.includes('x:') && presetsText.includes('y:');
        
        assert(hasPosition,
            'presets.js should parse shapecode_N_x and shapecode_N_y position');
    }

    // Test: Should parse shapecode_N_rad (radius)
    {
        const hasRadius = presetsText.includes('rad:');
        
        assert(hasRadius,
            'presets.js should parse shapecode_N_rad for shape radius');
    }

    // Test: Should parse shapecode_N_ang (angle/rotation)
    {
        const hasAngle = presetsText.includes('ang:');
        
        assert(hasAngle,
            'presets.js should parse shapecode_N_ang for shape rotation');
    }

    // Test: Should parse shapecode_N_additive (blending mode)
    {
        const hasAdditive = presetsText.includes('additive:');
        
        assert(hasAdditive,
            'presets.js should parse shapecode_N_additive for blending mode');
    }

    // Test: Should parse shapecode_N_thickOutline (thick border)
    {
        const hasThickOutline = presetsText.includes('thickOutline');
        
        assert(hasThickOutline,
            'presets.js should parse shapecode_N_thickOutline for thick border');
    }

    // Test: Should parse shapecode_N_textured (texture support)
    {
        const hasTextured = presetsText.includes('textured');
        
        assert(hasTextured,
            'presets.js should parse shapecode_N_textured for texture support');
    }

    // Test: Should parse shapecode_N_num_inst (multiple instances)
    {
        const hasNumInst = presetsText.includes('num_inst');
        
        assert(hasNumInst,
            'presets.js should parse shapecode_N_num_inst for multiple instances');
    }

    // Test: Should parse shape code expressions
    {
        const hasPerFrame = presetsText.includes('shape_');
        
        assert(hasPerFrame,
            'presets.js should parse shape_N code expressions');
    }

    // Test: Should support 4 custom shape slots (0-3)
    {
        const hasLoop = presetsText.includes('for (let i = 0; i < 4; i++)');
        
        assert(hasLoop,
            'presets.js should support 4 custom shape slots (0-3)');
    }

    // Test: Should parse color parameters (r, g, b, a - center and edge)
    {
        const hasColors = presetsText.includes('r:') && presetsText.includes('r2:');
        
        assert(hasColors,
            'presets.js should parse shapecode_N_r/g/b/a and shapecode_N_r2/g2/b2/a2 colors');
    }

    // Test: Should parse border color parameters
    {
        const hasBorder = presetsText.includes('border_');
        
        assert(hasBorder,
            'presets.js should parse shapecode_N_border_r/g/b/a border colors');
    }

    // Test: Should parse shapecode_N_image for texture filename
    {
        const hasImage = presetsText.includes('image');
        
        assert(hasImage,
            'presets.js should parse shapecode_N_image for texture filename');
    }

    // Test: Should parse texture parameters (tex_ang, tex_zoom)
    {
        const hasTexParams = presetsText.includes('tex_');
        
        assert(hasTexParams,
            'presets.js should parse shapecode_N_tex_ang and shapecode_N_tex_zoom');
    }
}
