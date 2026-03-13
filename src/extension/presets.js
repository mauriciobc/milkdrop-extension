import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const VALID_WARP_TYPES = new Set(['radial', 'angular', 'wave']);
const VALID_WAVEFORMS = new Set(['sin', 'cos']);

const BOOTSTRAP_PRESET = {
    id: 'builtin:demo-wave',
    name: 'Demo Wave',
    description: 'Built-in time-driven preset used to bootstrap the renderer protocol.',
    source: 'builtin',
    frame: {
        zoom: {base: 1.0, amplitude: 0.02, frequency: 0.5, monitorPhase: 0.2, waveform: 'sin', audioScale: 0.15},
        rot: {base: 0.0, amplitude: 0.012, frequency: 0.25, monitorPhase: 0.15, waveform: 'sin', audioScale: 0.06},
        dx: {base: 0.0, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.04},
        dy: {base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos', audioScale: 0.04},
        decay: {base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin'},
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
uniform float uMid;
uniform float uHigh;
uniform float uDecay;
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

const BUILTIN_PRESETS = [
    BOOTSTRAP_PRESET,
    {
        id: 'builtin:angular-drift',
        name: 'Angular Drift',
        description: 'Slow angular warp with audio-reactive rotation.',
        source: 'builtin',
        frame: {
            zoom: {base: 1.01, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.02},
            rot: {base: 0.005, amplitude: 0.015, frequency: 0.15, waveform: 'cos', audioScale: 0.04},
            dx: {base: 0.0, amplitude: 0.005, frequency: 0.2, waveform: 'sin'},
            dy: {base: 0.0, amplitude: 0.005, frequency: 0.15, waveform: 'cos'},
            decay: {base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin'},
        },
        vertex: {
            warpAmount: 0.02,
            warpSpeed: 0.5,
            warpScale: 1.2,
            warpType: 'angular',
        },
    },
    {
        id: 'builtin:wave-pool',
        name: 'Wave Pool',
        description: 'Flowing wave distortion driven by bass.',
        source: 'builtin',
        frame: {
            zoom: {base: 1.0, amplitude: 0.015, frequency: 0.4, waveform: 'sin', audioScale: 0.04},
            rot: {base: 0.0, amplitude: 0.008, frequency: 0.2, waveform: 'sin', audioScale: 0.01},
            dx: {base: 0.0, amplitude: 0.015, frequency: 0.35, waveform: 'cos', audioScale: 0.02},
            dy: {base: 0.0, amplitude: 0.012, frequency: 0.25, waveform: 'sin', audioScale: 0.02},
            decay: {base: 0.96, amplitude: 0.01, frequency: 0.1, waveform: 'sin'},
        },
        vertex: {
            warpAmount: 0.025,
            warpSpeed: 1.2,
            warpScale: 0.8,
            warpType: 'wave',
        },
    },
];

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
        audioScale: sanitiseNumber(raw.audioScale, fallback.audioScale ?? 0),
    };
}

const DEFAULT_WAVE = {base: 0, amplitude: 0, frequency: 0, monitorPhase: 0, phase: 0, waveform: 'sin', audioScale: 0};
const DEFAULT_ZOOM_WAVE = {...DEFAULT_WAVE, base: 1.0};
const DEFAULT_DECAY_WAVE = {...DEFAULT_WAVE, base: 0.98};

function sanitisePreset(raw, filePath) {
    if (!raw || typeof raw !== 'object')
        return null;

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name)
        return null;

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
    constructor({settings = null, logger = console} = {}) {
        this._settings = settings;
        this._logger = logger;
        this._externalPresets = [];
        this._externalLoaded = false;
    }

    async loadIndex() {
        await this._ensureExternalLoaded();
        return [...BUILTIN_PRESETS, ...this._externalPresets].map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            source: p.source,
        }));
    }

    async loadPreset(presetId = BOOTSTRAP_PRESET.id) {
        await this._ensureExternalLoaded();
        const preset = [...BUILTIN_PRESETS, ...this._externalPresets].find(p => p.id === presetId);
        if (!preset)
            throw new Error(`Unknown preset: ${presetId}`);

        return clonePreset(preset);
    }

    getBootstrapPreset() {
        return clonePreset(BOOTSTRAP_PRESET);
    }

    invalidateCache() {
        this._externalLoaded = false;
        this._externalPresets = [];
    }

    async _ensureExternalLoaded() {
        if (this._externalLoaded)
            return;

        this._externalLoaded = true;
        this._externalPresets = [];

        const dirPath = this._settings?.get_string?.('preset-directory')?.trim?.() ?? '';
        if (!dirPath)
            return;

        const expanded = dirPath.startsWith('~')
            ? GLib.build_filenamev([GLib.get_home_dir(), dirPath.slice(1)])
            : dirPath;

        const dir = Gio.File.new_for_path(expanded);
        if (!dir.query_exists(null)) {
            this._logger.debug?.(`milkdrop preset directory does not exist: ${expanded}`);
            return;
        }

        try {
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const name = fileInfo.get_name();
                if (!name.endsWith('.json'))
                    continue;

                if (fileInfo.get_file_type() !== Gio.FileType.REGULAR)
                    continue;

                const child = dir.get_child(name);
                this._loadPresetFile(child, name);
            }

            enumerator.close(null);
        } catch (error) {
            this._logger.warn?.(`milkdrop failed to scan preset directory: ${error.message}`);
        }

        if (this._externalPresets.length > 0)
            this._logger.info?.(`milkdrop loaded ${this._externalPresets.length} external preset(s)`);
    }

    _loadPresetFile(file, filename) {
        try {
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return;

            const text = new TextDecoder().decode(contents);
            const raw = JSON.parse(text);
            const preset = sanitisePreset(raw, filename);
            if (!preset) {
                this._logger.debug?.(`milkdrop skipping invalid preset file: ${filename}`);
                return;
            }

            this._externalPresets.push(preset);
        } catch (error) {
            this._logger.debug?.(`milkdrop failed to load preset ${filename}: ${error.message}`);
        }
    }
}
