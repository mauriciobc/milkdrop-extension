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

    {
        // Preset-load handling now updates UI/status only; helper preset switching
        // relies on presetPath arriving via the periodic frame payload.
        assert(rendererText.includes('const presetPath = nextPreset?.path ?? null'),
            'renderer preset-load still extracts presetPath for state/UI');
    }
}
