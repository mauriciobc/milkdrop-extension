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

    // Motion-vector shaders must exist as dedicated overlay shaders.
    {
        const hasMotionShaders = shadersText.includes('export const MOTION_VECTOR_VERTEX_SHADER')
            && shadersText.includes('export const MOTION_VECTOR_FRAGMENT_SHADER')
            && shadersText.includes('uniform vec2 uMVGrid;')
            && shadersText.includes('uniform vec2 uMVOffset;')
            && shadersText.includes('uniform float uMVLength;')
            && shadersText.includes('uniform vec4 uMVColor;');
        assert(hasMotionShaders,
            'shaders.js exports dedicated motion-vector overlay shader with mv uniforms');
    }

    // Helper must compile and retain motion-vector overlay program and uniforms.
    {
        const hasMotionProgram = helperText.includes('state->mv_program')
            && helperText.includes('state->mv_grid_uniform')
            && helperText.includes('state->mv_offset_uniform')
            && helperText.includes('state->mv_length_uniform')
            && helperText.includes('state->mv_color_uniform');
        assert(hasMotionProgram,
            'gl-helper stores dedicated motion-vector overlay program and uniforms');
    }

    // Render pipeline must invoke a dedicated motion-vector pass.
    {
        const hasMotionPass = helperText.includes('render_motion_vectors_overlay(')
            && helperText.includes('PERF_BEGIN(motion_vectors_pass)')
            && helperText.includes('PERF_END(motion_vectors_pass)');
        assert(hasMotionPass,
            'gl-helper render pipeline runs a dedicated motion-vector overlay pass');
    }
}
