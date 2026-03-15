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

    // Border shaders must exist as dedicated overlay shaders.
    {
        const hasBorderShaders = shadersText.includes('export const BORDER_VERTEX_SHADER')
            && shadersText.includes('export const BORDER_FRAGMENT_SHADER')
            && shadersText.includes('uniform float uOBSize;')
            && shadersText.includes('uniform vec4 uOBColor;')
            && shadersText.includes('uniform float uIBSize;')
            && shadersText.includes('uniform vec4 uIBColor;');
        assert(hasBorderShaders,
            'shaders.js exports dedicated border overlay shader with ob/ib uniforms');
    }

    // Helper must compile and retain border overlay program and uniforms.
    {
        const hasBorderProgram = helperText.includes('state->border_program')
            && helperText.includes('state->border_ob_size_uniform')
            && helperText.includes('state->border_ob_color_uniform')
            && helperText.includes('state->border_ib_size_uniform')
            && helperText.includes('state->border_ib_color_uniform');
        assert(hasBorderProgram,
            'gl-helper stores dedicated border overlay program and uniforms');
    }

    // Render pipeline must invoke a dedicated border pass.
    {
        const hasBorderPass = helperText.includes('render_border_overlay(')
            && helperText.includes('PERF_BEGIN(border_pass)')
            && helperText.includes('PERF_END(border_pass)');
        assert(hasBorderPass,
            'gl-helper render pipeline runs a dedicated border overlay pass');
    }
}
