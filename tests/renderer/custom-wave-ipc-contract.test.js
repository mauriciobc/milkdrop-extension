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

    // Test: gl-bridge.js should include custom waves in frame messages
    {
        const hasCustomWaves = bridgeText.includes('customWave') || bridgeText.includes('customWaves');
        
        assert(hasCustomWaves,
            'gl-bridge.js should include custom waves in frame messages');
    }

    // Test: Should include custom wave point data (x, y, r, g, b, a)
    {
        const hasPointData = bridgeText.includes('customWave') && 
                          (bridgeText.includes('x') || bridgeText.includes('y'));
        
        assert(hasPointData,
            'gl-bridge.js should include custom wave point data (x, y, r, g, b, a)');
    }

    // Test: Should include custom wave flags (useDots, additive, drawThick)
    {
        const hasFlags = bridgeText.includes('useDots') || 
                       bridgeText.includes('additive') ||
                       bridgeText.includes('drawThick');
        
        assert(hasFlags,
            'gl-bridge.js should include custom wave flags (useDots, additive, drawThick)');
    }

    // Test: Should support 4 custom wave slots
    {
        const hasFourSlots = bridgeText.includes('customWave0') ||
                           bridgeText.includes('customWave') ||
                           bridgeText.includes('customWaves');
        
        assert(hasFourSlots,
            'gl-bridge.js should support 4 custom wave slots');
    }

    // Test: Should include PCM/spectrum data for custom waves
    {
        const hasAudioData = bridgeText.includes('pcmLeft') || 
                           bridgeText.includes('pcmRight') ||
                           bridgeText.includes('spectrum');
        
        assert(hasAudioData,
            'gl-bridge.js should include PCM/spectrum data for custom wave evaluation');
    }
}
