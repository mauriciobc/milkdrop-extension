/**
 * IPC serialization micro-benchmarks.
 *
 * Measures JSON.stringify/JSON.parse round-trip cost for typical
 * frame-state payloads matching the milkdrop IPC protocol.
 */

const FRAME_MESSAGE = {
    type: 'frame',
    frame: 2550,
    t: 42.5,
    zoom: 1.02,
    rot: 0.015,
    dx: 0.003,
    dy: -0.002,
    decay: 0.98,
    presetId: 'builtin:demo-wave',
    presetName: 'Demo Wave',
    blendProgress: 1.0,
    audio: {
        source: 'pulse',
        active: true,
        energy: 0.45,
        bass: 0.52,
        mid: 0.38,
        high: 0.22,
        beat: 0,
        decay: 0.98,
        pcmLeft: new Array(576).fill(0),
        pcmRight: new Array(576).fill(0),
    },
};

const PRESET_LOAD_MESSAGE = {
    type: 'preset-load',
    presetId: 'builtin:hypnotic-tunnel',
    preset: {
        id: 'builtin:hypnotic-tunnel',
        name: 'Hypnotic Tunnel',
        frame: {
            zoom: {base: 1.03, amplitude: 0.016, frequency: 0.3, waveform: 'sin', audioScale: 0.07},
            rot: {base: 0.008, amplitude: 0.02, frequency: 0.22, waveform: 'sin', audioScale: 0.04},
            dx: {base: 0.0, amplitude: 0.004, frequency: 0.12, waveform: 'cos'},
            dy: {base: 0.0, amplitude: 0.004, frequency: 0.14, waveform: 'sin'},
            decay: {base: 0.958, amplitude: 0.004, frequency: 0.09, waveform: 'cos'},
        },
        vertex: {warpAmount: 0.03, warpSpeed: 0.9, warpScale: 1.7, warpType: 'angular'},
        shaders: {
            draw: 'precision mediump float; void main() { gl_FragColor = vec4(1.0); }',
            warp: null,
            composite: 'precision mediump float; void main() { gl_FragColor = vec4(1.0); }',
        },
    },
};

const CONTROL_MESSAGE = {type: 'ready'};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function run(bench) {
    // Frame message serialize
    bench('ipc: JSON.stringify frame', () => {
        JSON.stringify(FRAME_MESSAGE);
    });

    // Frame message full wire format (stringify + newline + encode)
    bench('ipc: frame → wire bytes', () => {
        encoder.encode(`${JSON.stringify(FRAME_MESSAGE)}\n`);
    });

    // Frame message deserialize
    {
        const wire = JSON.stringify(FRAME_MESSAGE);
        bench('ipc: JSON.parse frame', () => {
            JSON.parse(wire);
        });
    }

    // Full round-trip: serialize + deserialize frame
    bench('ipc: frame round-trip', () => {
        JSON.parse(JSON.stringify(FRAME_MESSAGE));
    });

    // Preset-load message (larger payload)
    bench('ipc: JSON.stringify preset-load', () => {
        JSON.stringify(PRESET_LOAD_MESSAGE);
    });

    // Preset-load round-trip
    bench('ipc: preset-load round-trip', () => {
        JSON.parse(JSON.stringify(PRESET_LOAD_MESSAGE));
    });

    // Control message (minimal payload)
    bench('ipc: control message round-trip', () => {
        JSON.parse(JSON.stringify(CONTROL_MESSAGE));
    });
}
