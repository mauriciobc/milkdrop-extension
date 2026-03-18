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

    // Preset-load handling sends preset path to GL helper via changePreset.
    {
        const hasPresetPathLoad = rendererText.includes('glArea.changePreset(presetPath)')
            && rendererText.includes('const presetPath = nextPreset?.path ?? null');
        assert(hasPresetPathLoad,
            'renderer preset-load path sends preset file path to GL helper via changePreset');
    }
}
