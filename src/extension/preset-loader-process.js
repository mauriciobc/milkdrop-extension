import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

function _printJson(obj) {
    print(JSON.stringify(obj));
}

function _parsePresetValues(content) {
    const values = {};
    const lines = content.split('\n');
    let currentSection = null;

    for (const line of lines) {
        const trimmed = line.trim();

        const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (currentSection.startsWith('preset'))
                values.name = currentSection;
            continue;
        }

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#'))
            continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) {
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 0) {
                const key = trimmed.substring(0, spaceIdx).trim();
                const val = trimmed.substring(spaceIdx + 1).trim();
                if (key && val)
                    values[key] = val;
            }
            continue;
        }

        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        if (!key)
            continue;
        values[key] = val;
    }
    return values;
}

function _parseCodeBlock(content, prefix) {
    const lines = content.split('\n');
    let code = '';
    let inBlock = false;
    let lastNum = -1;

    for (const line of lines) {
        const match = line.match(new RegExp(`^${prefix}(\\d+)=(.*)`));
        if (!match) {
            if (inBlock)
                break;
            continue;
        }

        const num = parseInt(match[1]);
        if (lastNum !== -1 && num !== lastNum + 1)
            break;

        inBlock = true;
        lastNum = num;
        code += match[2] + '\n';
    }
    return code;
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

function _buildPresetFromMilkText(text, absPath) {
    const values = _parsePresetValues(text);
    const frame_eqs = _parseCodeBlock(text, 'per_frame_');
    const pixel_eqs = _parseCodeBlock(text, 'per_pixel_');
    const init_eqs = _parseCodeBlock(text, 'init_');

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

System.exit(main(ARGV));

