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

    // Wrapper must use libprojectM core API, not frontend UIs.
    assert(
        helperText.includes('#include <projectM-4/core.h>'),
        'gl-helper includes projectM core header'
    );
    assert(
        !helperText.includes('projectM-qt') && !helperText.includes('projectM/sdl'),
        'gl-helper does not depend on projectM Qt/SDL frontend headers'
    );

    // PipeWire/IPC PCM must be injected into projectM.
    assert(
        helperText.includes('projectm_pcm_add_float('),
        'gl-helper injects PCM into projectM each frame'
    );

    // projectM must render into controlled FBO for GtkGLArea handover/readback.
    assert(
        helperText.includes('projectm_opengl_render_frame_fbo('),
        'gl-helper renders projectM frame into FBO'
    );
    assert(
        helperText.includes('create_fbo('),
        'gl-helper allocates dedicated readback FBO'
    );
}
