import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { compile } from './expr/compiler.js';

const VALID_WARP_TYPES = new Set(['radial', 'angular', 'wave']);
const VALID_WAVEFORMS = new Set(['sin', 'cos']);

const BOOTSTRAP_PRESET = {
    id: 'bootstrap:demo-wave',
    name: 'Demo Wave',
    description: 'Time-driven preset used to bootstrap the renderer protocol.',
    source: 'bootstrap',
    frame: {
        zoom: { base: 1.0, amplitude: 0.02, frequency: 0.5, monitorPhase: 0.2, waveform: 'sin' },
        rot: { base: 0.0, amplitude: 0.012, frequency: 0.25, monitorPhase: 0.15, waveform: 'sin' },
        dx: { base: 0.0, amplitude: 0.01, frequency: 0.3, waveform: 'sin' },
        dy: { base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos' },
        decay: { base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin' },
    },
    vertex: {
        warpAmount: 0.015,
        warpSpeed: 0.8,
        warpScale: 1.0,
        warpType: 'radial',
    },
    shaders: {
        draw: `precision mediump float;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec2 uResolution;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 fc = uv - vec2(0.5);
    float dist = length(fc);
    float angle = atan(fc.y, fc.x);
    float w1 = sin(dist*12.0 - uTime*2.0 + uBass*18.0)*0.5+0.5;
    float w2 = sin(angle*5.0 + uTime*1.5 + uMid*12.0)*0.5+0.5;
    float w3 = sin(dist*8.0 + angle*3.0 - uTime + uHigh*9.0)*0.5+0.5;
    float e = 0.15 + uEnergy*2.5;
    vec3 c = vec3(w1*0.6+w3*0.3, w2*0.5+w1*0.2, w3*0.7+w2*0.2)*e;
    c *= smoothstep(0.7, 0.3, dist);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
        warp: `precision mediump float;
uniform sampler2D uPrevFrame;
uniform float uDecay;
varying vec2 vTexCoord;
void main() {
    gl_FragColor = texture2D(uPrevFrame, vTexCoord) * uDecay;
}`,
        composite: `precision mediump float;
uniform sampler2D uWarpOutput;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
varying vec2 vTexCoord;
void main() {
    vec4 color = texture2D(uWarpOutput, vTexCoord);
    float boost = 1.0 + uEnergy*2.0 + uBass*1.2;
    color.rgb *= boost;
    vec2 fc = vTexCoord - vec2(0.5);
    float vignette = 1.0 - dot(fc, fc)*1.2;
    color.rgb *= clamp(vignette, 0.0, 1.0);
    color.r += sin(uTime*0.4)*0.02;
    color.g += sin(uTime*0.3+1.0)*0.02;
    color.b += sin(uTime*0.5+2.0)*0.02;
    gl_FragColor = clamp(color, 0.0, 1.0);
}`,
    },
};

function clonePreset(preset) {
    return JSON.parse(JSON.stringify(preset));
}

function sanitiseNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function sanitiseWaveSpec(raw, fallback) {
    if (!raw || typeof raw !== 'object')
        return fallback;

    return {
        base: sanitiseNumber(raw.base, fallback.base),
        amplitude: sanitiseNumber(raw.amplitude, fallback.amplitude ?? 0),
        frequency: sanitiseNumber(raw.frequency, fallback.frequency ?? 0),
        monitorPhase: sanitiseNumber(raw.monitorPhase, fallback.monitorPhase ?? 0),
        phase: sanitiseNumber(raw.phase, fallback.phase ?? 0),
        waveform: VALID_WAVEFORMS.has(raw.waveform) ? raw.waveform : (fallback.waveform ?? 'sin'),
    };
}

const DEFAULT_WAVE = { base: 0, amplitude: 0, frequency: 0, monitorPhase: 0, phase: 0, waveform: 'sin' };
const DEFAULT_ZOOM_WAVE = { ...DEFAULT_WAVE, base: 1.0 };
const DEFAULT_DECAY_WAVE = { ...DEFAULT_WAVE, base: 0.98 };

const WAVE_DEFAULTS = {
    enabled: 0, samples: 512, sep: 0, bSpectrum: 0,
    bUseDots: 0, bDrawThick: 0, bAdditive: 0,
    scaling: 1.0, smoothing: 0.5,
    r: 1, g: 1, b: 1, a: 1,
};

function sanitiseCustomWaves(raw) {
    const waves = [];
    for (let i = 0; i < 4; i++) {
        const prefix = `wavecode_${i}_`;
        const wavePrefix = `wave_${i}_`;

        const enabled = raw[prefix + 'enabled'] ?? WAVE_DEFAULTS.enabled;
        if (!enabled) {
            waves.push(null);
            continue;
        }

        const baseVals = {};
        for (const [key, defaultVal] of Object.entries(WAVE_DEFAULTS)) {
            baseVals[key] = sanitiseNumber(raw[prefix + key], defaultVal);
        }

        const init_eqs = typeof raw[wavePrefix + 'init'] === 'string' ? raw[wavePrefix + 'init'] : '';
        const frame_eqs = typeof raw[wavePrefix + 'per_frame'] === 'string' ? raw[wavePrefix + 'per_frame'] : '';
        const point_eqs = typeof raw[wavePrefix + 'per_point'] === 'string' ? raw[wavePrefix + 'per_point'] : '';

        waves.push({ baseVals, init_eqs, frame_eqs, point_eqs });
    }
    return waves;
}

const SHAPE_DEFAULTS = {
    enabled: 0, sides: 4, additive: 0, thickOutline: 0, textured: 0, num_inst: 1,
    x: 0.5, y: 0.5, rad: 0.1, ang: 0, tex_ang: 0, tex_zoom: 1.0,
    r: 1, g: 0, b: 0, a: 0.8,
    r2: 0, g2: 1, b2: 0, a2: 0.5,
    border_r: 1, border_g: 1, border_b: 1, border_a: 0.1,
};

function sanitiseCustomShapes(raw) {
    const shapes = [];
    for (let i = 0; i < 4; i++) {
        const prefix = `shapecode_${i}_`;
        const shapePrefix = `shape_${i}_`;

        const enabled = raw[prefix + 'enabled'] ?? SHAPE_DEFAULTS.enabled;
        if (!enabled) {
            shapes.push(null);
            continue;
        }

        const baseVals = {};
        for (const [key, defaultVal] of Object.entries(SHAPE_DEFAULTS)) {
            baseVals[key] = raw[prefix + key] ?? defaultVal;
        }

        baseVals.image = typeof raw[prefix + 'image'] === 'string' ? raw[prefix + 'image'] : '';

        const init_eqs = typeof raw[shapePrefix + 'init'] === 'string' ? raw[shapePrefix + 'init'] : '';
        const frame_eqs = typeof raw[shapePrefix + 'per_frame'] === 'string' ? raw[shapePrefix + 'per_frame'] : '';

        shapes.push({ baseVals, init_eqs, frame_eqs });
    }
    return shapes;
}

/**
 * Validate that all expression strings in a preset parse and compile.
 * Used to skip presets that use unsupported syntax (e.g. semicolon inside
 * parentheses, assignment in invalid context).
 * @param {object} preset - Sanitised preset with init_eqs, frame_eqs, pixel_eqs, customWaves, customShapes
 * @returns {boolean} - true if all expressions are valid, false otherwise
 */
export function validatePresetExpressions(preset) {
    if (!preset || typeof preset !== 'object')
        return true;
    try {
        const compileIfNonEmpty = (src) => {
            if (typeof src === 'string' && src.trim())
                compile(src);
        };
        compileIfNonEmpty(preset.init_eqs);
        compileIfNonEmpty(preset.frame_eqs);
        compileIfNonEmpty(preset.pixel_eqs);
        const waves = preset.customWaves;
        if (Array.isArray(waves)) {
            for (let i = 0; i < waves.length; i++) {
                const w = waves[i];
                if (!w) continue;
                compileIfNonEmpty(w.init_eqs);
                compileIfNonEmpty(w.frame_eqs);
                compileIfNonEmpty(w.point_eqs);
            }
        }
        const shapes = preset.customShapes;
        if (Array.isArray(shapes)) {
            for (let i = 0; i < shapes.length; i++) {
                const s = shapes[i];
                if (!s) continue;
                compileIfNonEmpty(s.init_eqs);
                compileIfNonEmpty(s.frame_eqs);
            }
        }
        return true;
    } catch (_e) {
        return false;
    }
}

function sanitisePreset(raw, filePath) {
    if (!raw || typeof raw !== 'object')
        return null;

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name)
        return null;

    const initEqs = typeof raw.init_eqs === 'string'
        ? raw.init_eqs
        : (typeof raw.init_eqs_eel === 'string' ? raw.init_eqs_eel : null);
    const frameEqs = typeof raw.frame_eqs === 'string'
        ? raw.frame_eqs
        : (typeof raw.frame_eqs_eel === 'string' ? raw.frame_eqs_eel : null);
    const pixelEqs = typeof raw.pixel_eqs === 'string'
        ? raw.pixel_eqs
        : (typeof raw.pixel_eqs_eel === 'string' ? raw.pixel_eqs_eel : null);
    const hasExpressionPayload = initEqs !== null || frameEqs !== null || pixelEqs !== null;

    const frame = raw.frame && typeof raw.frame === 'object' ? {
        zoom: sanitiseWaveSpec(raw.frame.zoom, DEFAULT_ZOOM_WAVE),
        rot: sanitiseWaveSpec(raw.frame.rot, DEFAULT_WAVE),
        dx: sanitiseWaveSpec(raw.frame.dx, DEFAULT_WAVE),
        dy: sanitiseWaveSpec(raw.frame.dy, DEFAULT_WAVE),
        decay: sanitiseWaveSpec(raw.frame.decay, DEFAULT_DECAY_WAVE),
    } : BOOTSTRAP_PRESET.frame;

    const vertex = raw.vertex && typeof raw.vertex === 'object' ? {
        warpAmount: sanitiseNumber(raw.vertex.warpAmount, 0.015),
        warpSpeed: sanitiseNumber(raw.vertex.warpSpeed, 1.0),
        warpScale: sanitiseNumber(raw.vertex.warpScale, 1.0),
        warpType: VALID_WARP_TYPES.has(raw.vertex.warpType) ? raw.vertex.warpType : 'radial',
    } : BOOTSTRAP_PRESET.vertex;

    if (hasExpressionPayload) {
        const baseVals = raw.baseVals && typeof raw.baseVals === 'object'
            ? { ...raw.baseVals }
            : {};

        const customWaves = sanitiseCustomWaves(raw);
        const customShapes = sanitiseCustomShapes(raw);

        return {
            id: `file:${filePath}`,
            name,
            description: typeof raw.description === 'string' ? raw.description : '',
            source: 'file',
            baseVals,
            init_eqs: initEqs ?? '',
            frame_eqs: frameEqs ?? '',
            pixel_eqs: pixelEqs ?? '',
            vertex: raw.vertex && typeof raw.vertex === 'object' ? vertex : null,
            shaders: raw.shaders && typeof raw.shaders === 'object' ? {
                draw: typeof raw.shaders.draw === 'string' ? raw.shaders.draw : null,
                warp: typeof raw.shaders.warp === 'string' ? raw.shaders.warp : null,
                composite: typeof raw.shaders.composite === 'string' ? raw.shaders.composite : null,
            } : null,
            customWaves,
            customShapes,
        };
    }

    return {
        id: `file:${filePath}`,
        name,
        description: typeof raw.description === 'string' ? raw.description : '',
        source: 'file',
        frame,
        vertex,
        shaders: raw.shaders && typeof raw.shaders === 'object' ? {
            draw: typeof raw.shaders.draw === 'string' ? raw.shaders.draw : null,
            warp: typeof raw.shaders.warp === 'string' ? raw.shaders.warp : null,
            composite: typeof raw.shaders.composite === 'string' ? raw.shaders.composite : null,
        } : null,
    };
}

export class PresetStore {
    constructor({ settings = null, logger = console, extensionPath = null } = {}) {
        this._settings = settings;
        this._logger = logger;
        this._extensionPath = extensionPath;
        this._externalPresets = [];
        this._externalLoaded = false;
        this._lastPresetDirectory = null;
        this._externalLoadPromise = null;
        this._loadingPresetDirectory = null;
        this._externalLoadToken = 0;
    }

    async loadIndex() {
        await this._ensureExternalLoaded();
        // Rotation/selection should only consider externally managed presets.
        // Built-in presets are intentionally excluded so the renderer can always
        // receive a valid file path via `presetPath` / `preset-change`.
        return this._externalPresets.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            source: p.source,
        }));
    }

    async loadPreset(presetId) {
        await this._ensureExternalLoaded();
        const preset = this._externalPresets.find(p => p.id === presetId);
        if (!preset)
            throw new Error(`Unknown preset: ${presetId}`);

        return clonePreset(preset);
    }

    getBootstrapPreset() {
        return clonePreset(BOOTSTRAP_PRESET);
    }

    invalidateCache() {
        this._externalLoadToken += 1;
        this._externalLoadPromise = null;
        this._loadingPresetDirectory = null;
        this._externalLoaded = false;
        this._externalPresets = [];
        this._lastPresetDirectory = null;
    }

    handleSettingsChanged(key) {
        if (key === 'preset-directory')
            this.invalidateCache();
    }

    async _ensureExternalLoaded() {
        const dirPath = this._getPresetDirectorySetting();
        if (this._externalLoaded && dirPath === this._lastPresetDirectory)
            return;

        if (this._externalLoadPromise && this._loadingPresetDirectory === dirPath) {
            await this._externalLoadPromise;
            return;
        }

        this._externalLoadToken += 1;
        const token = this._externalLoadToken;
        this._loadingPresetDirectory = dirPath;
        this._externalLoaded = false;
        this._externalPresets = [];
        this._lastPresetDirectory = null;

        const loadPromise = this._loadExternalPresetsAsync(dirPath, token);
        this._externalLoadPromise = loadPromise;
        try {
            await loadPromise;
        } finally {
            if (this._externalLoadPromise === loadPromise) {
                this._externalLoadPromise = null;
                this._loadingPresetDirectory = null;
            }
        }
    }

    async _loadExternalPresetsAsync(dirPath, token) {
        if (!dirPath) {
            this._commitExternalPresets(dirPath, [], token);
            return;
        }

        const expanded = dirPath.startsWith('~')
            ? GLib.build_filenamev([GLib.get_home_dir(), dirPath.slice(1)])
            : dirPath;

        const presets = [];
        try {
            const childStdout = await this._runPresetLoaderProcess(expanded);
            const parsed = JSON.parse(childStdout);
            if (parsed && parsed.ok && Array.isArray(parsed.presets)) {
                for (const p of parsed.presets) {
                    if (!p || typeof p !== 'object')
                        continue;
                    if (typeof p.id !== 'string' || typeof p.path !== 'string')
                        continue;
                    if (p.source !== 'file')
                        continue;
                    if (!validatePresetExpressions(p)) {
                        this._logger.debug?.(
                            `milkdrop skipping preset with invalid expressions: ${p.path ?? p.id}`
                        );
                        continue;
                    }
                    presets.push(p);
                }
            } else if (parsed && parsed.ok === false) {
                this._logger.warn?.(`milkdrop preset loader failed: ${parsed.error ?? 'unknown error'}`);
            }
        } catch (error) {
            this._logger.warn?.(`milkdrop failed to load external presets: ${error.message}`);
        }

        this._commitExternalPresets(dirPath, presets, token);
    }

    _commitExternalPresets(dirPath, presets, token) {
        if (token !== this._externalLoadToken)
            return;

        this._externalLoaded = true;
        this._externalPresets = presets;
        this._lastPresetDirectory = dirPath;

        if (this._externalPresets.length > 0)
            this._logger.info?.(`milkdrop loaded ${this._externalPresets.length} external preset(s)`);
    }

    _runPresetLoaderProcess(dirPath) {
        return new Promise((resolve, reject) => {
            const helperPath = this._extensionPath
                ? GLib.build_filenamev([this._extensionPath, 'extension', 'preset-loader-process.js'])
                : GLib.build_filenamev([GLib.get_current_dir(), 'src', 'extension', 'preset-loader-process.js']);
            const argv = ['gjs', '-m', helperPath, dirPath];
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            let proc;
            try {
                proc = launcher.spawnv(argv);
            } catch (error) {
                reject(error);
                return;
            }

            proc.communicate_utf8_async(null, null, (_p, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    resolve(stdout ?? '');
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _getPresetDirectorySetting() {
        if (!this._hasSettingKey('preset-directory'))
            return '';

        try {
            return this._settings.get_string('preset-directory')?.trim?.() ?? '';
        } catch (_error) {
            return '';
        }
    }

    _hasSettingKey(key) {
        try {
            const schema = this._settings?.settings_schema ?? this._settings?.get_settings_schema?.();
            if (schema?.has_key)
                return Boolean(schema.has_key(key));
            return Boolean(this._settings);
        } catch (_error) {
            return false;
        }
    }
}
