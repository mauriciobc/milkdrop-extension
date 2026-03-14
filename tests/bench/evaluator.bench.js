/**
 * Evaluator micro-benchmarks.
 *
 * Measures per-frame evaluation cost with and without preset blending.
 */
import { Evaluator } from '../../src/extension/evaluator.js';

const PRESET_A = {
    id: 'bench:a',
    name: 'Bench A',
    frame: {
        zoom: {base: 1.0, amplitude: 0.02, frequency: 0.5, monitorPhase: 0.2, waveform: 'sin', audioScale: 0.15},
        rot: {base: 0.0, amplitude: 0.012, frequency: 0.25, monitorPhase: 0.15, waveform: 'sin', audioScale: 0.06},
        dx: {base: 0.0, amplitude: 0.01, frequency: 0.3, waveform: 'sin', audioScale: 0.04},
        dy: {base: 0.0, amplitude: 0.01, frequency: 0.2, waveform: 'cos', audioScale: 0.04},
        decay: {base: 0.97, amplitude: 0.0, frequency: 0.0, waveform: 'sin'},
    },
};

const PRESET_B = {
    id: 'bench:b',
    name: 'Bench B',
    frame: {
        zoom: {base: 1.03, amplitude: 0.016, frequency: 0.3, waveform: 'sin', audioScale: 0.07},
        rot: {base: 0.008, amplitude: 0.02, frequency: 0.22, waveform: 'sin', audioScale: 0.04},
        dx: {base: 0.0, amplitude: 0.004, frequency: 0.12, waveform: 'cos'},
        dy: {base: 0.0, amplitude: 0.004, frequency: 0.14, waveform: 'sin'},
        decay: {base: 0.958, amplitude: 0.004, frequency: 0.09, waveform: 'cos'},
    },
};

const FRAME_STATE = {
    t: 42.5,
    frame: 2550,
    monitor: 0,
    audio: {energy: 0.45, bass: 0.52, mid: 0.38, high: 0.22, beat: 0, decay: 0.44},
};

export function run(bench) {
    // Single preset, no blending
    {
        const e = new Evaluator();
        e.loadPreset(PRESET_A);
        // Warm the preset path
        e.evaluateFrame(FRAME_STATE);

        bench('evaluator: single preset', () => {
            e.evaluateFrame(FRAME_STATE);
        });
        e.destroy();
    }

    // Null preset (defaults only)
    {
        const e = new Evaluator();
        e.loadPreset(null);
        e.evaluateFrame(FRAME_STATE);

        bench('evaluator: null preset (defaults)', () => {
            e.evaluateFrame(FRAME_STATE);
        });
        e.destroy();
    }

    // Active blend between two presets
    {
        const e = new Evaluator();
        e.loadPreset(PRESET_A);
        e.evaluateFrame({t: 0, monitor: 0, audio: FRAME_STATE.audio});
        e.loadPreset(PRESET_B, 5.0);

        // Evaluate mid-blend (t=2.5 through a 5s blend)
        let t = 0;
        bench('evaluator: blending two presets', () => {
            t += 0.001;
            e.evaluateFrame({...FRAME_STATE, t});
        });
        e.destroy();
    }

    // evaluateFrame with varying time (simulates real frame pump)
    {
        const e = new Evaluator();
        e.loadPreset(PRESET_A);
        let t = 0;
        bench('evaluator: varying time', () => {
            t += 1 / 60;
            e.evaluateFrame({...FRAME_STATE, t});
        });
        e.destroy();
    }
}
