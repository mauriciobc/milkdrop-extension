import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const rendererText = readText('src/renderer/renderer.js');

    // Preset-load handling must prefer pixel_eqs for vertex warp source,
    // while still falling back to legacy vertex spec.
    {
        const hasPixelEqsSource = rendererText.includes('function resolvePresetVertexSource(preset)')
            && rendererText.includes('preset.pixel_eqs')
            && rendererText.includes('return preset.vertex ?? null')
            && rendererText.includes('const vertexSource = resolvePresetVertexSource(nextPreset)');
        assert(hasPixelEqsSource,
            'renderer preset-load path resolves vertexSource using pixel_eqs preference with vertex fallback');
    }
}