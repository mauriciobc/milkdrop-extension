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

    // Waveform shaders must exist as dedicated overlay shaders.
    // Note: Simplified shader since geometry is now generated on CPU - only needs color/alpha/additive
    {
        const hasWaveformShaders = shadersText.includes('export const WAVEFORM_VERTEX_SHADER')
            && shadersText.includes('export const WAVEFORM_FRAGMENT_SHADER')
            && shadersText.includes('uniform vec4 uWaveColor;')
            && shadersText.includes('uniform float uWaveAlpha;')
            && shadersText.includes('uniform float uAdditiveWave;');
        assert(hasWaveformShaders,
            'shaders.js exports dedicated waveform overlay shader with basic color/alpha uniforms');
    }

    // Helper must compile and retain waveform overlay program and uniforms.
    {
        const hasWaveformProgram = helperText.includes('state->wave_program')
            && helperText.includes('state->wave_color_uniform')
            && helperText.includes('state->wave_alpha_uniform')
            && helperText.includes('state->wave_scale_uniform')
            && helperText.includes('state->wave_smoothing_uniform')
            && helperText.includes('state->wave_pos_uniform')
            && helperText.includes('state->wave_mode_uniform')
            && helperText.includes('state->wave_dots_uniform')
            && helperText.includes('state->wave_thick_uniform')
            && helperText.includes('state->wave_additive_uniform')
            && helperText.includes('state->wave_data_uniform');
        assert(hasWaveformProgram,
            'gl-helper stores dedicated waveform overlay program and uniforms');
    }

    // Helper frame parsing must include waveform controls and a waveform sample array.
    {
        const hasWaveformFrameParsing = helperText.includes('get_double(obj, "wave_mode", 0.0)')
            && helperText.includes('get_double(obj, "wave_a", 0.8)')
            && helperText.includes('get_double(obj, "wave_scale", 1.0)')
            && helperText.includes('get_double(obj, "wave_smoothing", 0.75)')
            && helperText.includes('get_double(obj, "wave_x", 0.5)')
            && helperText.includes('get_double(obj, "wave_y", 0.5)')
            && helperText.includes('get_double(obj, "wave_dots", 0.0)')
            && helperText.includes('get_double(obj, "wave_thick", 0.0)')
            && helperText.includes('get_double(obj, "additivewave", 0.0)')
            && helperText.includes('json_object_has_member(obj, "wave_data")')
            && helperText.includes('json_object_get_array_member(obj, "wave_data")');
        assert(hasWaveformFrameParsing,
            'gl-helper parses waveform frame controls and wave_data sample payload from incoming frame messages');
    }

    // Render pipeline must invoke a dedicated waveform pass between composite and border passes.
    {
        const hasWaveformPass = helperText.includes('render_waveform_overlay(')
            && helperText.includes('PERF_BEGIN(waveform_pass)')
            && helperText.includes('PERF_END(waveform_pass)');
        assert(hasWaveformPass,
            'gl-helper render pipeline runs a dedicated waveform overlay pass');

        const waveformBeforeBorder = helperText.indexOf('PERF_BEGIN(waveform_pass)')
            < helperText.indexOf('PERF_BEGIN(border_pass)');
        assert(waveformBeforeBorder,
            'waveform pass runs before border pass in render pipeline order');
    }
}
