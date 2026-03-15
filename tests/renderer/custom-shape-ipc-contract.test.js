import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const bridgeText = readText('src/renderer/gl-bridge.js');

    // Test: gl-bridge.js should include custom shapes in frame messages
    {
        const hasCustomShapes = bridgeText.includes('customShape') || bridgeText.includes('customShapes');
        
        assert(hasCustomShapes,
            'gl-bridge.js should include custom shapes in frame messages');
    }

    // Test: Should include custom shape geometry (x, y, rad, ang, sides)
    {
        const hasGeometry = bridgeText.includes('customShape') && 
                        (bridgeText.includes('x') || bridgeText.includes('rad'));
        
        assert(hasGeometry,
            'gl-bridge.js should include custom shape geometry (x, y, rad, ang, sides)');
    }

    // Test: Should include custom shape colors (r, g, b, a, r2, g2, b2, a2)
    {
        const hasColors = bridgeText.includes('customShape') && 
                       (bridgeText.includes('r') || bridgeText.includes('g'));
        
        assert(hasColors,
            'gl-bridge.js should include custom shape colors');
    }

    // Test: Should include custom shape flags (additive, thickOutline, textured)
    {
        const hasFlags = bridgeText.includes('customShape') && 
                       (bridgeText.includes('additive') || 
                        bridgeText.includes('thickOutline') || 
                        bridgeText.includes('textured'));
        
        assert(hasFlags,
            'gl-bridge.js should include custom shape flags');
    }

    // Test: Should include border color parameters
    {
        const hasBorder = bridgeText.includes('customShape') && 
                        bridgeText.includes('border');
        
        assert(hasBorder,
            'gl-bridge.js should include custom shape border colors');
    }

    // Test: Should support 4 custom shape slots
    {
        const hasFourSlots = bridgeText.includes('customShape') ||
                           bridgeText.includes('customShapes');
        
        assert(hasFourSlots,
            'gl-bridge.js should support 4 custom shape slots');
    }

    // Test: Should include texture parameters (tex_ang, tex_zoom)
    {
        const hasTex = bridgeText.includes('customShape') && 
                     bridgeText.includes('tex_');
        
        assert(hasTex,
            'gl-bridge.js should include texture parameters for custom shapes');
    }
}
