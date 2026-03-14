/**
 * Preset micro-benchmarks.
 *
 * Benchmarks preset sanitisation, cloning, and lookup operations.
 * Does not require filesystem access — uses synthetic data.
 */

const VALID_WARP_TYPES = new Set(['radial', 'angular', 'wave']);
const VALID_WAVEFORMS = new Set(['sin', 'cos']);

function sanitiseNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_WAVE = {base: 0, amplitude: 0, frequency: 0, monitorPhase: 0, phase: 0, waveform: 'sin', audioScale: 0};
const DEFAULT_ZOOM_WAVE = {...DEFAULT_WAVE, base: 1.0};
const DEFAULT_DECAY_WAVE = {...DEFAULT_WAVE, base: 0.98};

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

const BOOTSTRAP_FRAME = {
    zoom: {base: 1.0, amplitude: 0.02, frequency: 0.5, monitorPhase: 0.2, waveform: 'sin', audioScale: 0.15},
    rot: {base: 0.0, amplitude: 0.012, frequency: 0.25, monitorPhase: 0.15, waveform: 'sin', audioScale: 0.06},
    dx: {base: 0.0, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.04},
    dy: {base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos', audioScale: 0.04},
    decay: {base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin'},
};

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
    } : BOOTSTRAP_FRAME;

    const vertex = raw.vertex && typeof raw.vertex === 'object' ? {
        warpAmount: sanitiseNumber(raw.vertex.warpAmount, 0.015),
        warpSpeed: sanitiseNumber(raw.vertex.warpSpeed, 1.0),
        warpScale: sanitiseNumber(raw.vertex.warpScale, 1.0),
        warpType: VALID_WARP_TYPES.has(raw.vertex.warpType) ? raw.vertex.warpType : 'radial',
    } : {warpAmount: 0.015, warpSpeed: 1.0, warpScale: 1.0, warpType: 'radial'};

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

// Generate synthetic raw preset data
function makeSyntheticRawPreset(index) {
    return {
        name: `Bench Preset ${index}`,
        description: `Synthetic benchmark preset number ${index}`,
        frame: {
            zoom: {base: 1.0 + Math.random() * 0.05, amplitude: Math.random() * 0.03, frequency: Math.random(), waveform: 'sin', audioScale: Math.random() * 0.1},
            rot: {base: Math.random() * 0.01, amplitude: Math.random() * 0.02, frequency: Math.random() * 0.5, waveform: 'cos', audioScale: Math.random() * 0.05},
            dx: {base: 0, amplitude: Math.random() * 0.02, frequency: Math.random() * 0.5, waveform: 'sin'},
            dy: {base: 0, amplitude: Math.random() * 0.02, frequency: Math.random() * 0.4, waveform: 'cos'},
            decay: {base: 0.95 + Math.random() * 0.03, amplitude: 0, frequency: 0, waveform: 'sin'},
        },
        vertex: {
            warpAmount: Math.random() * 0.04,
            warpSpeed: 0.5 + Math.random(),
            warpScale: 0.8 + Math.random() * 0.6,
            warpType: ['radial', 'angular', 'wave'][index % 3],
        },
        shaders: index % 2 === 0 ? {
            draw: 'precision mediump float; void main() { gl_FragColor = vec4(1.0); }',
        } : null,
    };
}

export function run(bench) {
    // Generate test data
    const rawPresets = [];
    for (let i = 0; i < 50; i++)
        rawPresets.push(makeSyntheticRawPreset(i));

    // Preset sanitisation
    {
        let idx = 0;
        bench('presets: sanitisePreset', () => {
            sanitisePreset(rawPresets[idx % rawPresets.length], `preset-${idx}.json`);
            idx++;
        });
    }

    // Preset cloning (JSON round-trip)
    {
        const sanitised = sanitisePreset(rawPresets[0], 'preset-0.json');
        bench('presets: clone (JSON round-trip)', () => {
            JSON.parse(JSON.stringify(sanitised));
        });
    }

    // Preset lookup in array (simulates loadPreset search)
    {
        const presetList = rawPresets.map((raw, i) => sanitisePreset(raw, `preset-${i}.json`));
        const targetId = presetList[25].id;
        bench('presets: find by id (50 presets)', () => {
            presetList.find(p => p.id === targetId);
        });
    }

    // Wave spec sanitisation (inner hot path)
    {
        const rawWave = {base: 1.02, amplitude: 0.016, frequency: 0.3, waveform: 'sin', audioScale: 0.07, monitorPhase: 0.15, phase: 0.5};
        bench('presets: sanitiseWaveSpec', () => {
            sanitiseWaveSpec(rawWave, DEFAULT_ZOOM_WAVE);
        });
    }

    // Batch sanitisation (50 presets, simulates directory load)
    bench('presets: batch sanitise 50 presets', () => {
        for (let i = 0; i < rawPresets.length; i++)
            sanitisePreset(rawPresets[i], `preset-${i}.json`);
    }, {iterations: 1000});
}
