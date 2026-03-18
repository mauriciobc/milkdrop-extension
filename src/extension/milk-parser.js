/**
 * .milk preset file parser for gnome-milkdrop.
 * Parses MilkDrop preset files into preset objects (key/value and code blocks).
 * Shared by parity tests and parser benchmark (projectM PresetFileParser parity).
 */

export function parsePresetValues(content) {
    const values = {};
    const lines = content.split('\n');

    let currentSection = null;

    for (const line of lines) {
        const trimmed = line.trim();

        const sectionMatch = trimmed.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            if (currentSection.startsWith('preset')) {
                values.name = currentSection;
            }
            continue;
        }

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) {
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 0) {
                const key = trimmed.substring(0, spaceIdx).trim();
                const val = trimmed.substring(spaceIdx + 1).trim();
                if (key && val) values[key] = val;
            }
            continue;
        }

        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();

        if (!key) continue;
        values[key] = val;
    }
    return values;
}

export function parseCodeBlock(content, prefix) {
    const lines = content.split('\n');
    let code = '';
    let inBlock = false;
    let lastNum = -1;

    for (const line of lines) {
        const match = line.match(new RegExp(`^${prefix}(\\d+)=(.*)`));
        if (!match) {
            if (inBlock) break;
            continue;
        }

        const num = parseInt(match[1]);
        if (lastNum !== -1 && num !== lastNum + 1) break;

        inBlock = true;
        lastNum = num;
        code += match[2] + '\n';
    }
    return code;
}

export function getInt(value, fallback) {
    const n = parseInt(value);
    return isNaN(n) ? fallback : n;
}

export function getFloat(value, fallback) {
    const n = parseFloat(value);
    return isNaN(n) ? fallback : n;
}

export function getBool(value, fallback) {
    if (value === '1' || value === 'true' || value === 'yes') return true;
    if (value === '0' || value === 'false' || value === 'no') return false;
    return fallback;
}

const FIELD_ALIASES = {
    'fDecay': 'decay',
    'fZoom': 'zoom',
    'fRot': 'rot',
    'fWarp': 'warp',
    'fWarpScale': 'warpscale',
    'fX': 'cx',
    'fY': 'cy',
    'fD X': 'dx',
    'fD Y': 'dy',
    'fZoomExponent': 'zoomexp',
    'fWaveSmoothing': 'wave_smoothing',
    'nWaveMode': 'wave_mode',
    'fWaveScale': 'wave_scale',
    'fWaveA': 'wave_a',
    'fWaveR': 'wave_r',
    'fWaveG': 'wave_g',
    'fWaveB': 'wave_b',
    'fWaveX': 'wave_x',
    'fWaveY': 'wave_y',
    'bWaveDots': 'wave_dots',
    'bWaveThick': 'wave_thick',
    'bAdditiveWave': 'additivewave',
    'fVideoEchoZoom': 'echo_zoom',
    'fVideoEchoAlpha': 'echo_alpha',
    'nVideoEchoOrientation': 'echo_orient',
    'fOBSize': 'ob_size',
    'fOBR': 'ob_r',
    'fOBG': 'ob_g',
    'fOBB': 'ob_b',
    'fOBA': 'ob_a',
    'fIBSize': 'ib_size',
    'fIBR': 'ib_r',
    'fIBG': 'ib_g',
    'fIBB': 'ib_b',
    'fIBA': 'ib_a',
    'bDarkenCenter': 'darken_center',
    'bInvert': 'invert',
    'bBrighten': 'brighten',
    'bDarken': 'darken',
    'bSolarize': 'solarize',
    'fGamma': 'gamma',
};

function normalizeFieldName(name) {
    return FIELD_ALIASES[name] || name;
}

export function parseMilkPreset(content) {
    const values = parsePresetValues(content);

    const preset = {
        name: values.name || 'Unnamed',
        baseVals: {},
        init_eqs: '',
        frame_eqs: '',
        pixel_eqs: '',
        waves: [null, null, null, null],
        shapes: [null, null, null, null],
    };

    for (const [key, rawValue] of Object.entries(values)) {
        const fieldName = normalizeFieldName(key);
        const numValue = getFloat(rawValue, NaN);

        if (key.startsWith('per_frame_init')) {
            preset.init_eqs += rawValue + '\n';
        } else if (key.startsWith('per_frame')) {
            preset.frame_eqs += rawValue + '\n';
        } else if (key.startsWith('per_pixel')) {
            preset.pixel_eqs += rawValue + '\n';
        } else if (key.startsWith('wavecode_')) {
            const match = key.match(/^wavecode_(\d+)_(.+)$/);
            if (match) {
                const waveIdx = parseInt(match[1]);
                const propName = match[2];
                if (!preset.waves[waveIdx]) {
                    preset.waves[waveIdx] = { baseVals: {}, init_eqs: '', frame_eqs: '', point_eqs: '' };
                }
                preset.waves[waveIdx].baseVals[propName] = numValue;
            }
        } else if (key.startsWith('wave_')) {
            const match = key.match(/^wave_(\d+)_(.+)$/);
            if (match) {
                const waveIdx = parseInt(match[1]);
                const propName = match[2];
                if (!preset.waves[waveIdx]) {
                    preset.waves[waveIdx] = { baseVals: {}, init_eqs: '', frame_eqs: '', point_eqs: '' };
                }
                if (propName === 'per_point1' || propName === 'per_point2') {
                    preset.waves[waveIdx].point_eqs += rawValue + '\n';
                } else if (propName === 'init') {
                    preset.waves[waveIdx].init_eqs += rawValue + '\n';
                } else if (propName === 'per_frame') {
                    preset.waves[waveIdx].frame_eqs += rawValue + '\n';
                }
            }
        } else if (key.startsWith('shapecode_')) {
            const match = key.match(/^shapecode_(\d+)_(.+)$/);
            if (match) {
                const shapeIdx = parseInt(match[1]);
                const propName = match[2];
                if (!preset.shapes[shapeIdx]) {
                    preset.shapes[shapeIdx] = { baseVals: {}, init_eqs: '', frame_eqs: '' };
                }
                preset.shapes[shapeIdx].baseVals[propName] = numValue;
            }
        } else if (key.startsWith('shape_')) {
            const match = key.match(/^shape_(\d+)_(.+)$/);
            if (match) {
                const shapeIdx = parseInt(match[1]);
                const propName = match[2];
                if (!preset.shapes[shapeIdx]) {
                    preset.shapes[shapeIdx] = { baseVals: {}, init_eqs: '', frame_eqs: '' };
                }
                if (propName === 'init') {
                    preset.shapes[shapeIdx].init_eqs += rawValue + '\n';
                } else if (propName === 'per_frame') {
                    preset.shapes[shapeIdx].frame_eqs += rawValue + '\n';
                }
            }
        } else if (!isNaN(numValue)) {
            preset.baseVals[fieldName] = numValue;
        }
    }

    preset.frame_eqs = parseCodeBlock(content, 'per_frame_');
    preset.init_eqs = parseCodeBlock(content, 'per_frame_init_');
    preset.pixel_eqs = parseCodeBlock(content, 'per_pixel_');

    return preset;
}
