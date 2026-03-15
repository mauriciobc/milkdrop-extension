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

    // Composite shader must declare post-processing and echo uniforms.
    {
        const hasPostUniforms = shadersText.includes('uniform float uInvert;')
            && shadersText.includes('uniform float uBrighten;')
            && shadersText.includes('uniform float uDarken;')
            && shadersText.includes('uniform float uSolarize;')
            && shadersText.includes('uniform float uGamma;')
            && shadersText.includes('uniform float uDarkenCenter;')
            && shadersText.includes('uniform float uEchoZoom;')
            && shadersText.includes('uniform float uEchoAlpha;')
            && shadersText.includes('uniform float uEchoOrient;');
        assert(hasPostUniforms,
            'composite shader declares post-processing and echo uniforms');
    }

    // Helper must resolve composite post-processing and echo uniform locations.
    {
        const hasUniformLookups = helperText.includes('state->comp_invert_uniform')
            && helperText.includes('state->comp_brighten_uniform')
            && helperText.includes('state->comp_darken_uniform')
            && helperText.includes('state->comp_solarize_uniform')
            && helperText.includes('state->comp_gamma_uniform')
            && helperText.includes('state->comp_darken_center_uniform')
            && helperText.includes('state->comp_echo_zoom_uniform')
            && helperText.includes('state->comp_echo_alpha_uniform')
            && helperText.includes('state->comp_echo_orient_uniform');
        assert(hasUniformLookups,
            'gl-helper stores composite post-processing and echo uniform locations');
    }

    // Helper frame parsing and render call must include post-processing and echo values.
    {
        const hasFrameParsing = helperText.includes('get_double(obj, "invert", 0.0)')
            && helperText.includes('get_double(obj, "brighten", 0.0)')
            && helperText.includes('get_double(obj, "darken", 0.0)')
            && helperText.includes('get_double(obj, "solarize", 0.0)')
            && helperText.includes('get_double(obj, "gamma", 1.0)')
            && helperText.includes('get_double(obj, "darken_center", 0.0)')
            && helperText.includes('get_double(obj, "echo_zoom", 1.0)')
            && helperText.includes('get_double(obj, "echo_alpha", 0.0)')
            && helperText.includes('get_double(obj, "echo_orient", 0.0)');
        assert(hasFrameParsing,
            'gl-helper parses post-processing and echo frame controls from incoming frame messages');
    }

    // Composite pass must upload post-processing and echo uniforms before drawing.
    {
        const hasUniformUploads = helperText.includes('glUniform1f(state->comp_invert_uniform')
            && helperText.includes('glUniform1f(state->comp_brighten_uniform')
            && helperText.includes('glUniform1f(state->comp_darken_uniform')
            && helperText.includes('glUniform1f(state->comp_solarize_uniform')
            && helperText.includes('glUniform1f(state->comp_gamma_uniform')
            && helperText.includes('glUniform1f(state->comp_darken_center_uniform')
            && helperText.includes('glUniform1f(state->comp_echo_zoom_uniform')
            && helperText.includes('glUniform1f(state->comp_echo_alpha_uniform')
            && helperText.includes('glUniform1f(state->comp_echo_orient_uniform');
        assert(hasUniformUploads,
            'gl-helper uploads post-processing and echo uniform values in composite pass');
    }
}