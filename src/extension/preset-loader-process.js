import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {parseMilkPreset} from './milk-parser.js';

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
        for (;;) {
            const info = enumerator.next_file(null);
            if (!info)
                break;

            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            if (!name.endsWith('.milk'))
                continue;
            out.push(GLib.build_filenamev([dirPath, name]));
        }
    } finally {
        try { enumerator?.close(null); } catch (_e) {}
    }
    out.sort();
    return out;
}

/** Milk parser uses sparse arrays; ExpressionEvaluator expects 4 slots. */
function _slots4(arr) {
    const out = [null, null, null, null];
    if (!Array.isArray(arr))
        return out;
    for (let i = 0; i < 4; i++)
        out[i] = arr[i] ?? null;
    return out;
}

function _buildPresetFromMilkText(text, absPath) {
    const parsed = parseMilkPreset(text);
    const baseName = GLib.path_get_basename(absPath);
    const name = (typeof parsed.name === 'string' && parsed.name.trim())
        ? parsed.name.trim()
        : baseName;

    return {
        id: `file:${absPath}`,
        name,
        description: '',
        source: 'file',
        path: absPath,
        baseVals: parsed.baseVals && typeof parsed.baseVals === 'object' ? {...parsed.baseVals} : {},
        init_eqs: typeof parsed.init_eqs === 'string' ? parsed.init_eqs : '',
        frame_eqs: typeof parsed.frame_eqs === 'string' ? parsed.frame_eqs : '',
        pixel_eqs: typeof parsed.pixel_eqs === 'string' ? parsed.pixel_eqs : '',
        customWaves: _slots4(parsed.waves),
        customShapes: _slots4(parsed.shapes),
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

System.exit(main(ARGV));
