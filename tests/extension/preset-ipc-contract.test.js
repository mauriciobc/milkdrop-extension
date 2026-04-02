import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const monitorText = readText('src/extension/monitor.js');

    // queuePresetLoad must keep expression payload fields in preset-load IPC.
    {
        const queuePayloadPattern = /this\._pendingPresetLoad\s*=\s*preset\s*\?\s*\{[\s\S]*?baseVals:\s*preset\.baseVals[\s\S]*?init_eqs:\s*preset\.init_eqs[\s\S]*?frame_eqs:\s*preset\.frame_eqs[\s\S]*?pixel_eqs:\s*preset\.pixel_eqs[\s\S]*?shapes:\s*preset\.shapes[\s\S]*?waves:\s*preset\.waves[\s\S]*?\}\s*:\s*null\s*;/;
        assert(queuePayloadPattern.test(monitorText),
            'queuePresetLoad keeps baseVals/init_eqs/frame_eqs/pixel_eqs/shapes/waves in pending preset payload');
    }
}