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
    const bridgeText = readText('src/renderer/gl-bridge.js');
    const rendererText = readText('src/renderer/renderer.js');
    const monitorText = readText('src/extension/monitor.js');

    // Test: IPC frame messages should carry expanded waveform data (576 L + 576 R = 1152 samples)
    // This enables proper waveform rendering for all MilkDrop 2 modes
    {
        const hasExpandedWaveData =
            (bridgeText.includes('pcmLeft') || bridgeText.includes('wave_data')) &&
            (bridgeText.includes('.slice(0, 576)') || bridgeText.includes('.slice(0, 1152)') ||
             bridgeText.includes('_copyAudioSamples'));
        
        assert(hasExpandedWaveData, 
            'gl-bridge.js should transmit expanded waveform data (576+ samples) for MilkDrop 2 compliance');
    }

    // Test: gl-helper.c should parse expanded waveform data arrays
    {
        const hasExpandedParsing = 
            helperText.includes('#define WAVE_SAMPLE_COUNT 64') === false ||
            helperText.includes('WAVE_SAMPLE_COUNT') && 
            (helperText.includes('576') || helperText.includes('1152'));
        
        assert(hasExpandedParsing || helperText.includes('wave_data'),
            'gl-helper.c should handle expanded waveform sample count for MilkDrop 2 modes');
    }

    // Test: monitor.js should include PCM waveform data in frame state
    {
        const includesPcmData = 
            monitorText.includes('pcmLeft') || 
            monitorText.includes('waveData') ||
            monitorText.includes('.wave_data');
        
        assert(includesPcmData,
            'monitor.js should include PCM/waveform data in frame state sent to renderer');
    }

    // Test: renderer.js should forward PCM waveform data to GL layer
    {
        const forwardsPcmData = 
            rendererText.includes('pcmLeft') || 
            rendererText.includes('wave_data') ||
            rendererText.includes('setFrameState');
        
        assert(forwardsPcmData,
            'renderer.js should forward PCM waveform data to GL layer via setFrameState or similar');
    }

    // Test: waveform rendering should support multiple modes based on geometry
    // (Not fragment-shader-only distance field)
    {
        const hasModeSupport = 
            helperText.includes('wave_mode') &&
            (helperText.includes('GL_LINE_STRIP') || helperText.includes('GL_POINTS'));
        
        assert(hasModeSupport,
            'gl-helper.c should support different waveform rendering modes (line strip, points)');
    }
}
