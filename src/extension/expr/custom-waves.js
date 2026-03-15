/**
 * MilkDrop 2 custom waves.
 *
 * Each wave slot (0-3) has:
 *   - baseVals: default parameters
 *   - init_eqs: run once at preset load
 *   - frame_eqs: run each frame
 *   - point_eqs: run per sample point
 *
 * Wave params: enabled, samples, sep, bSpectrum, bUseDots, bDrawThick, bAdditive,
 *   scaling, smoothing, r, g, b, a
 *
 * Per-point read-only: sample, value1, value2 (audio data).
 * Per-point read-write: x, y, r, g, b, a.
 *
 * Pure JS — no GI imports.
 */

import { compile } from './compiler.js';

const NOOP = (_ctx) => {};

const WAVE_DEFAULTS = {
    enabled: 0, samples: 512, sep: 0, bSpectrum: 0,
    bUseDots: 0, bDrawThick: 0, bAdditive: 0,
    scaling: 1.0, smoothing: 0.5,
    r: 1, g: 1, b: 1, a: 1,
};

const WAVE_KEYS = Object.keys(WAVE_DEFAULTS);

export class CustomWave {
    /**
     * @param {number} index - Wave slot index (0-3)
     */
    constructor(index) {
        this.index = index;
        this._baseVals = { ...WAVE_DEFAULTS };
        this._vals = { ...WAVE_DEFAULTS };
        this._initFn = NOOP;
        this._frameFn = NOOP;
        this._pointFn = NOOP;
    }

    /**
     * Load wave definition from preset.
     * @param {object} def - { baseVals, init_eqs, frame_eqs, point_eqs }
     */
    load(def) {
        if (!def) {
            this._baseVals = { ...WAVE_DEFAULTS };
            this._initFn = NOOP;
            this._frameFn = NOOP;
            this._pointFn = NOOP;
            return;
        }

        this._baseVals = { ...WAVE_DEFAULTS };
        if (def.baseVals) {
            for (const [k, v] of Object.entries(def.baseVals)) {
                if (k in WAVE_DEFAULTS)
                    this._baseVals[k] = v;
            }
        }

        this._initFn = def.init_eqs ? compile(def.init_eqs) : NOOP;
        this._frameFn = def.frame_eqs ? compile(def.frame_eqs) : NOOP;
        this._pointFn = def.point_eqs ? compile(def.point_eqs) : NOOP;
    }

    /**
     * Run init equations (once per preset load).
     */
    runInit(frameCtx) {
        const tmpCtx = this._buildWaveCtx(frameCtx);
        this._initFn(tmpCtx);
        this._writeBackQVars(tmpCtx, frameCtx);
    }

    /**
     * Run frame equations for the wave.
     */
    evaluateFrame(frameCtx) {
        this._resetVals();
        const tmpCtx = this._buildWaveCtx(frameCtx);
        this._frameFn(tmpCtx);
        this._readBackVals(tmpCtx);
        this._writeBackQVars(tmpCtx, frameCtx);
    }

    /**
     * Get current wave state info (after evaluateFrame).
     */
    getWaveInfo() {
        const v = this._vals;
        return {
            index: this.index,
            enabled: !!v.enabled,
            samples: Math.max(1, Math.floor(v.samples)),
            sep: v.sep,
            spectrum: !!v.bSpectrum,
            useDots: !!v.bUseDots,
            drawThick: !!v.bDrawThick,
            additive: !!v.bAdditive,
            scaling: v.scaling,
            smoothing: v.smoothing,
            r: v.r, g: v.g, b: v.b, a: v.a,
        };
    }

    /**
     * Run per-point equations for all sample points.
     * Returns array of {x, y, r, g, b, a} or null if disabled.
     *
     * @param {FrameContext} frameCtx
     * @param {number[]} audio1 - Primary audio data (waveform or spectrum)
     * @param {number[]|null} audio2 - Secondary audio data (for stereo sep)
     */
    evaluatePoints(frameCtx, audio1, audio2) {
        const v = this._vals;
        if (!v.enabled)
            return null;

        const numPoints = Math.min(audio1.length, Math.max(1, Math.floor(v.samples)));
        const points = [];

        for (let i = 0; i < numPoints; i++) {
            const sample = numPoints > 1 ? i / (numPoints - 1) : 0;
            const value1 = audio1[i] ?? 0;
            const value2 = audio2 ? (audio2[i] ?? 0) : 0;

            // Build per-point context
            const ptCtx = this._buildPointCtx(frameCtx, sample, value1, value2);
            this._pointFn(ptCtx);

            points.push({
                x: ptCtx.x,
                y: ptCtx.y,
                r: ptCtx.r,
                g: ptCtx.g,
                b: ptCtx.b,
                a: ptCtx.a,
            });
        }

        return points;
    }

    // ── Internal ──────────────────────────────────────────────────

    _resetVals() {
        for (const key of WAVE_KEYS)
            this._vals[key] = this._baseVals[key];
    }

    _buildWaveCtx(frameCtx) {
        const ctx = {};

        // Read-only frame vars
        const roKeys = ['time', 'frame', 'fps', 'progress',
            'bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att',
            'meshx', 'meshy', 'aspectx', 'aspecty', 'pixelsx', 'pixelsy'];
        for (const k of roKeys)
            ctx[k] = frameCtx[k] ?? 0;

        // Q-vars
        for (let i = 1; i <= 32; i++)
            ctx[`q${i}`] = frameCtx[`q${i}`] ?? 0;

        // Isolated t-vars
        for (let i = 1; i <= 8; i++)
            ctx[`t${i}`] = 0;

        // Reg vars
        for (let i = 0; i < 100; i++) {
            const k = `reg${String(i).padStart(2, '0')}`;
            ctx[k] = frameCtx[k] ?? 0;
        }

        // Wave-specific params
        for (const key of WAVE_KEYS)
            ctx[key] = this._vals[key];

        return ctx;
    }

    _buildPointCtx(frameCtx, sample, value1, value2) {
        const ctx = {};
        const v = this._vals;

        // Read-only frame vars
        const roKeys = ['time', 'frame', 'fps', 'progress',
            'bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att'];
        for (const k of roKeys)
            ctx[k] = frameCtx[k] ?? 0;

        // Q-vars (from frame context, post frame_eqs)
        for (let i = 1; i <= 32; i++)
            ctx[`q${i}`] = frameCtx[`q${i}`] ?? 0;

        // T-vars (isolated per point evaluation, start at 0)
        for (let i = 1; i <= 8; i++)
            ctx[`t${i}`] = 0;

        // Per-point read-only
        ctx.sample = sample;
        ctx.value1 = value1;
        ctx.value2 = value2;

        // Per-point read-write (initial values from wave params)
        ctx.x = 0;
        ctx.y = 0;
        ctx.r = v.r;
        ctx.g = v.g;
        ctx.b = v.b;
        ctx.a = v.a;

        // Wave params readable in per-point
        ctx.scaling = v.scaling;

        return ctx;
    }

    _readBackVals(tmpCtx) {
        for (const key of WAVE_KEYS) {
            if (key in tmpCtx)
                this._vals[key] = tmpCtx[key];
        }
    }

    _writeBackQVars(tmpCtx, frameCtx) {
        for (let i = 1; i <= 32; i++)
            frameCtx[`q${i}`] = tmpCtx[`q${i}`] ?? frameCtx[`q${i}`];
    }
}
