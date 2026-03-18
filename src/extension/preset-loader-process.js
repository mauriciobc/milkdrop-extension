import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { parseCodeBlock, parsePresetValues } from './milk-parser.js';

function _printJson(obj) {
    print(JSON.stringify(obj));
}

function _readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        return null;
    return new TextDecoder().decode(bytes);
}

function _listMilkFiles(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    let enumerator = null;
    const out = [];
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        while (true) {
            const infos = enumerator.next_files(64, null);
            if (!infos || infos.length === 0)
                break;
            for (const info of infos) {
                if (info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                const name = info.get_name();
                if (!name.endsWith('.milk'))
                    continue;
                out.push(GLib.build_filenamev([dirPath, name]));
            }
        }
    } finally {
        try { enumerator?.close(null); } catch (_e) {}
    }
    out.sort();
    return out;
}

function _buildPresetFromMilkText(text, absPath) {
    const values = parsePresetValues(text);
    const frame_eqs = parseCodeBlock(text, 'per_frame_');
    const pixel_eqs = parseCodeBlock(text, 'per_pixel_');
    const init_eqs = parseCodeBlock(text, 'init_');

    const name = (typeof values?.name === 'string' && values.name.trim())
        ? values.name.trim()
        : GLib.path_get_basename(absPath);

    return {
        id: `file:${absPath}`,
        name,
        description: '',
        source: 'file',
        path: absPath,
        init_eqs,
        frame_eqs,
        pixel_eqs,
    };
}

function main(argv) {
    const dirPath = argv?.[0] ?? '';
    if (!dirPath) {
        _printJson({ ok: true, presets: [] });
        return 0;
    }

    try {
        const files = _listMilkFiles(dirPath);
        const presets = [];
        for (const absPath of files) {
            const text = _readText(absPath);
            if (!text)
                continue;
            presets.push(_buildPresetFromMilkText(text, absPath));
        }
        _printJson({ ok: true, presets });
        return 0;
    } catch (error) {
        _printJson({ ok: false, error: error?.message ?? String(error), presets: [] });
        return 1;
    }
}

GLib.exit(main(ARGV));

