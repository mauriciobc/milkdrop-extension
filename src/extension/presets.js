import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { compile } from './expr/compiler.js';

const VALID_WARP_TYPES = new Set(['radial', 'angular', 'wave']);
const VALID_WAVEFORMS = new Set(['sin', 'cos']);

const BOOTSTRAP_PRESET = {
    id: 'builtin:demo-wave',
    name: 'Demo Wave',
    description: 'Built-in time-driven preset used to bootstrap the renderer protocol.',
    source: 'builtin',
    frame: {
        zoom: { base: 1.0, amplitude: 0.02, frequency: 0.5, monitorPhase: 0.2, waveform: 'sin', audioScale: 0.15 },
        rot: { base: 0.0, amplitude: 0.012, frequency: 0.25, monitorPhase: 0.15, waveform: 'sin', audioScale: 0.06 },
        dx: { base: 0.0, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.04 },
        dy: { base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos', audioScale: 0.04 },
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

const BUILTIN_PRESETS = [
    BOOTSTRAP_PRESET,
    {
        id: 'builtin:test-geiss-eggs',
        name: 'Test - Geiss Eggs (Compliance)',
        description: 'Reference expression preset aligned with the visual compliance test pipeline.',
        source: 'builtin',
        baseVals: {
            decay: 0.97,
            wave_mode: 2,
            wave_a: 3.5,
            wave_scale: 2.72,
            wave_smoothing: 0.77,
            warpscale: 2.853,
            zoom: 1.046,
            rot: 0.02,
            warp: 1.42,
            wave_r: 0.6,
            wave_g: 0.6,
            wave_b: 0.6,
            wave_y: 0.47,
            cx: 0.5,
            cy: 0.5,
            dx: 0,
            dy: 0,
        },
        init_eqs: '',
        frame_eqs:
            'wave_r = wave_r + 0.400*( 0.60*sin(0.900*time) + 0.40*sin(0.963*time) );\n' +
            'wave_g = wave_g + 0.400*( 0.60*sin(0.900*time) + 0.40*sin(0.956*time) );\n' +
            'wave_b = wave_b + 0.400*( 0.60*sin(0.910*time) + 0.40*sin(0.920*time) );\n' +
            'zoom = zoom + 0.023*( 0.60*sin(0.339*time) + 0.40*sin(0.276*time) );\n' +
            'rot = rot + 0.030*( 0.60*sin(0.381*time) + 0.40*sin(0.579*time) );\n' +
            'cx = cx + 0.070*( 0.60*sin(0.374*time) + 0.40*sin(0.294*time) );\n' +
            'cy = cy + 0.070*( 0.60*sin(0.393*time) + 0.40*sin(0.223*time) );',
        pixel_eqs: 'zoom=zoom+0.27*sin(time*1.55+rad*5);',
        vertex: {
            warpAmount: 0.015,
            warpSpeed: 0.8,
            warpScale: 1.0,
            warpType: 'radial',
        },
    },
    {
        id: 'builtin:angular-drift',
        name: 'Angular Drift',
        description: 'Slow angular warp with audio-reactive rotation.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.01, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.02 },
            rot: { base: 0.005, amplitude: 0.015, frequency: 0.15, waveform: 'cos', audioScale: 0.04 },
            dx: { base: 0.0, amplitude: 0.005, frequency: 0.2, waveform: 'sin' },
            dy: { base: 0.0, amplitude: 0.005, frequency: 0.15, waveform: 'cos' },
            decay: { base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin' },
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
            zoom: { base: 1.0, amplitude: 0.015, frequency: 0.4, waveform: 'sin', audioScale: 0.04 },
            rot: { base: 0.0, amplitude: 0.008, frequency: 0.2, waveform: 'sin', audioScale: 0.01 },
            dx: { base: 0.0, amplitude: 0.015, frequency: 0.35, waveform: 'cos', audioScale: 0.02 },
            dy: { base: 0.0, amplitude: 0.012, frequency: 0.25, waveform: 'sin', audioScale: 0.02 },
            decay: { base: 0.96, amplitude: 0.01, frequency: 0.1, waveform: 'sin' },
        },
        vertex: {
            warpAmount: 0.025,
            warpSpeed: 1.2,
            warpScale: 0.8,
            warpType: 'wave',
        },
    },
    {
        id: 'builtin:fractal-bloom',
        name: 'Fractal Bloom',
        description: 'Web-inspired fractal pulse with smooth radial bloom.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.015, amplitude: 0.02, frequency: 0.21, waveform: 'sin', audioScale: 0.05 },
            rot: { base: 0.0015, amplitude: 0.018, frequency: 0.17, waveform: 'cos', audioScale: 0.05 },
            dx: { base: 0.0, amplitude: 0.008, frequency: 0.24, waveform: 'sin', audioScale: 0.02 },
            dy: { base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos', audioScale: 0.03 },
            decay: { base: 0.965, amplitude: 0.006, frequency: 0.08, waveform: 'sin' },
        },
        vertex: {
            warpAmount: 0.028,
            warpSpeed: 0.7,
            warpScale: 1.4,
            warpType: 'radial',
        },
    },
    {
        id: 'builtin:hypnotic-tunnel',
        name: 'Hypnotic Tunnel',
        description: 'Hypnotic category inspired tunnel with rotational pull.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.03, amplitude: 0.016, frequency: 0.3, waveform: 'sin', audioScale: 0.07 },
            rot: { base: 0.008, amplitude: 0.02, frequency: 0.22, waveform: 'sin', audioScale: 0.04 },
            dx: { base: 0.0, amplitude: 0.004, frequency: 0.12, waveform: 'cos' },
            dy: { base: 0.0, amplitude: 0.004, frequency: 0.14, waveform: 'sin' },
            decay: { base: 0.958, amplitude: 0.004, frequency: 0.09, waveform: 'cos' },
        },
        vertex: {
            warpAmount: 0.03,
            warpSpeed: 0.9,
            warpScale: 1.7,
            warpType: 'angular',
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
    vec2 p = uv - vec2(0.5);
    float dist = max(length(p), 0.001);
    float angle = atan(p.y, p.x);
    float rings = sin(28.0 * dist - uTime * 4.0 + uBass * 22.0);
    float spiral = sin(angle * 11.0 + uTime * 1.8 + uMid * 14.0);
    float tunnel = smoothstep(0.95, 0.03, dist);
    vec3 color = vec3(0.25 + 0.45 * rings, 0.2 + 0.6 * spiral, 0.3 + 0.5 * (rings * spiral));
    color *= tunnel * (0.35 + uEnergy * 2.4);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
            composite: `precision mediump float;
uniform sampler2D uWarpOutput;
uniform float uTime;
uniform float uEnergy;
uniform float uHigh;
varying vec2 vTexCoord;
void main() {
    vec2 p = vTexCoord - vec2(0.5);
    float r = length(p);
    float a = atan(p.y, p.x);
    vec2 drift = vec2(cos(a + uTime * 0.4), sin(a - uTime * 0.35)) * (0.003 + uHigh * 0.01);
    vec4 color = texture2D(uWarpOutput, vTexCoord + drift);
    float edge = smoothstep(0.95, 0.2, r);
    float pulse = 1.0 + sin(uTime * 2.2 + r * 20.0) * 0.05 + uEnergy * 0.7;
    color.rgb *= edge * pulse;
    gl_FragColor = clamp(color, 0.0, 1.0);
}`,
        },
    },
    {
        id: 'builtin:particle-comet',
        name: 'Particle Comet',
        description: 'Particles-inspired streaks with bright audio-driven tails.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.0, amplitude: 0.018, frequency: 0.42, waveform: 'cos', audioScale: 0.05 },
            rot: { base: 0.0, amplitude: 0.012, frequency: 0.35, waveform: 'sin', audioScale: 0.03 },
            dx: { base: 0.0, amplitude: 0.018, frequency: 0.33, waveform: 'sin', audioScale: 0.04 },
            dy: { base: 0.0, amplitude: 0.014, frequency: 0.28, waveform: 'cos', audioScale: 0.04 },
            decay: { base: 0.962, amplitude: 0.012, frequency: 0.14, waveform: 'sin' },
        },
        vertex: {
            warpAmount: 0.02,
            warpSpeed: 1.5,
            warpScale: 1.1,
            warpType: 'wave',
        },
        shaders: {
            draw: `precision mediump float;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uHigh;
uniform vec2 uResolution;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 p = uv - vec2(0.5);
    float t = uTime;
    float comet = 0.0;
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        vec2 center = vec2(sin(t * (0.8 + fi * 0.25) + fi * 2.1), cos(t * (0.6 + fi * 0.2) + fi * 1.7)) * 0.28;
        vec2 d = p - center;
        float len = length(d * vec2(0.8, 1.6));
        comet += 0.015 / (len + 0.03 + fi * 0.01);
    }
    float lane = sin((uv.y + t * 0.2) * 52.0 + uBass * 28.0) * 0.5 + 0.5;
    float spark = pow(max(0.0, lane), 6.0) * (0.35 + uHigh * 1.8);
    vec3 color = vec3(comet * (0.4 + uEnergy * 2.0), comet * 0.5 + spark * 0.6, comet * 1.1 + spark);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
        },
    },
    {
        id: 'builtin:supernova-kick',
        name: 'Supernova Kick',
        description: 'Supernova style burst that spikes with kick energy.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.02, amplitude: 0.022, frequency: 0.32, waveform: 'sin', audioScale: 0.09 },
            rot: { base: 0.002, amplitude: 0.018, frequency: 0.27, waveform: 'cos', audioScale: 0.03 },
            dx: { base: 0.0, amplitude: 0.009, frequency: 0.2, waveform: 'sin', audioScale: 0.04 },
            dy: { base: 0.0, amplitude: 0.009, frequency: 0.23, waveform: 'cos', audioScale: 0.04 },
            decay: { base: 0.952, amplitude: 0.008, frequency: 0.17, waveform: 'sin' },
        },
        vertex: {
            warpAmount: 0.033,
            warpSpeed: 1.05,
            warpScale: 1.35,
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
    vec2 p = uv - vec2(0.5);
    float r = max(length(p), 0.001);
    float a = atan(p.y, p.x);
    float star = abs(sin(a * 9.0 + uTime * 3.2 + uHigh * 10.0));
    float ring = sin(r * 45.0 - uTime * 6.0 + uBass * 30.0) * 0.5 + 0.5;
    float core = 0.03 / (r + 0.02);
    float burst = (core + ring * 0.7 + star * 0.5) * (0.25 + uEnergy * 2.8);
    vec3 color = vec3(burst * 1.2, burst * (0.5 + uMid * 0.7), burst * 0.35);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`,
        },
    },
    {
        id: 'builtin:waveform-lattice',
        name: 'Waveform Lattice',
        description: 'Waveform-inspired grid of oscillating audio ribbons.',
        source: 'builtin',
        frame: {
            zoom: { base: 1.0, amplitude: 0.01, frequency: 0.5, waveform: 'sin', audioScale: 0.03 },
            rot: { base: 0.0, amplitude: 0.01, frequency: 0.41, waveform: 'cos', audioScale: 0.02 },
            dx: { base: 0.0, amplitude: 0.012, frequency: 0.48, waveform: 'sin', audioScale: 0.03 },
            dy: { base: 0.0, amplitude: 0.012, frequency: 0.46, waveform: 'cos', audioScale: 0.03 },
            decay: { base: 0.968, amplitude: 0.007, frequency: 0.12, waveform: 'cos' },
        },
        vertex: {
            warpAmount: 0.018,
            warpSpeed: 1.35,
            warpScale: 1.0,
            warpType: 'wave',
        },
        shaders: {
            composite: `precision mediump float;
uniform sampler2D uWarpOutput;
uniform float uTime;
uniform float uEnergy;
uniform float uMid;
varying vec2 vTexCoord;
void main() {
    vec4 color = texture2D(uWarpOutput, vTexCoord);
    float linesX = sin((vTexCoord.x + uTime * 0.08) * 140.0);
    float linesY = sin((vTexCoord.y - uTime * 0.05) * 120.0);
    float lattice = linesX * linesY;
    color.rgb += vec3(0.08, 0.22, 0.35) * lattice * (0.4 + uMid * 1.1);
    color.rgb *= 1.0 + uEnergy * 1.3;
    gl_FragColor = clamp(color, 0.0, 1.0);
}`,
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

const DEFAULT_WAVE = { base: 0, amplitude: 0, frequency: 0, monitorPhase: 0, phase: 0, waveform: 'sin', audioScale: 0 };
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
function validatePresetExpressions(preset) {
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
        // Compatibility hook: no built-in presets are exposed anymore.
        // Callers should treat this as "no preset selected".
        return null;
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
