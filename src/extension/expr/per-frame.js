/**
 * MilkDrop 2 per-frame expression evaluator.
 *
 * Wraps the expression compiler + FrameContext to provide the per-frame
 * evaluation loop for expression-based presets.
 *
 * Usage:
 *   const ev = new ExpressionEvaluator();
 *   ev.loadPreset(preset);   // compile init + frame + pixel eqs
 *   ev.runInit();             // run init_eqs once
 *   // each frame:
 *   const ctx = ev.evaluateFrame({ time, frame, bass, mid, treb, ... });
 *   // ctx.zoom, ctx.rot, ctx.dx, ctx.dy, ctx.decay are ready
 *
 * Pure JS — no GI imports.
 */

import { compile } from './compiler.js';
import { FrameContext } from './context.js';
import { CustomWave } from './custom-waves.js';
import { CustomShape } from './custom-shapes.js';

const NOOP = (_ctx) => {};

export class ExpressionEvaluator {
    constructor() {
        this._ctx = new FrameContext();
        this._initFn = NOOP;
        this._frameFn = NOOP;
        this._preset = null;
        
        this._customWaves = [
            new CustomWave(0),
            new CustomWave(1),
            new CustomWave(2),
            new CustomWave(3),
        ];
        this._customShapes = [
            new CustomShape(0),
            new CustomShape(1),
            new CustomShape(2),
            new CustomShape(3),
        ];
    }

    /**
     * Load and compile an expression-based preset.
     * @param {object|null} preset  — { baseVals, init_eqs, frame_eqs, ... }
     */
    loadPreset(preset) {
        this._preset = preset ?? null;
        this._ctx.resetForNewPreset();

        if (!preset) {
            this._initFn = NOOP;
            this._frameFn = NOOP;
            this._loadCustomWaves(null);
            this._loadCustomShapes(null);
            return;
        }

        if (preset.baseVals)
            this._ctx.applyBaseVals(preset.baseVals);

        this._initFn = preset.init_eqs ? compile(preset.init_eqs) : NOOP;
        this._frameFn = preset.frame_eqs ? compile(preset.frame_eqs) : NOOP;

        this._loadCustomWaves(preset.customWaves);
        this._loadCustomShapes(preset.customShapes);

        this._ctx.rerollPresetRandom();
    }

    _loadCustomWaves(customWaves) {
        for (let i = 0; i < 4; i++) {
            const waveDef = customWaves && customWaves[i] ? customWaves[i] : null;
            this._customWaves[i].load(waveDef);
        }
    }

    _loadCustomShapes(customShapes) {
        for (let i = 0; i < 4; i++) {
            const shapeDef = customShapes && customShapes[i] ? customShapes[i] : null;
            this._customShapes[i].load(shapeDef);
        }
    }

    /**
     * Run init_eqs once (called after loadPreset, before first frame).
     */
    runInit() {
        this._initFn(this._ctx);
        
        for (let i = 0; i < 4; i++) {
            this._customWaves[i].runInit(this._ctx);
            this._customShapes[i].runInit(this._ctx);
        }
    }

    /**
     * Evaluate one frame. Sets read-only vars, resets RW to base, runs frame_eqs.
     * @param {object} frameState — { time, frame, fps, bass, mid, treb, high, energy, beat, ... }
     * @returns {FrameContext} The context after evaluation (same object, mutated)
     */
    evaluateFrame(frameState) {
        const trebValue = frameState.treb ?? frameState.high ?? 0;
        const highValue = frameState.high ?? frameState.treb ?? 0;

        // Feed engine-driven read-only variables
        this._ctx.setReadOnly({
            time: frameState.time ?? 0,
            frame: frameState.frame ?? 0,
            fps: frameState.fps ?? 30,
            progress: frameState.progress ?? 0,
            bass: frameState.bass ?? 0,
            mid: frameState.mid ?? 0,
            treb: trebValue,
            high: highValue,
            bass_att: frameState.bass_att ?? 0,
            mid_att: frameState.mid_att ?? 0,
            treb_att: frameState.treb_att ?? 0,
            energy: frameState.energy ?? 0,
            beat: frameState.beat ?? 0,
        });

        // Restore per-frame RW vars to base before running per-frame eqs
        this._ctx.resetPerFrame();

        // Run per-frame equations
        this._frameFn(this._ctx);

        // Evaluate custom waves and shapes per-frame
        for (let i = 0; i < 4; i++) {
            this._customWaves[i].evaluateFrame(this._ctx);
            this._customShapes[i].evaluateFrame(this._ctx);
        }

        return this._ctx;
    }

    /**
     * Get custom wave geometry for all enabled waves.
     * @param {object} audioData - { pcmLeft, pcmRight, spectrumLeft, spectrumRight }
     * @returns {Array|null} Array of point arrays or null if no waves enabled
     */
    evaluateCustomWaves(audioData) {
        const results = [];
        
        const pcmLeft = audioData?.pcmLeft || [];
        const pcmRight = audioData?.pcmRight || [];
        const spectrumLeft = audioData?.spectrumLeft || [];
        const spectrumRight = audioData?.spectrumRight || [];

        for (let i = 0; i < 4; i++) {
            const wave = this._customWaves[i];
            const info = wave.getWaveInfo();
            
            if (!info.enabled) {
                results.push(null);
                continue;
            }

            const audio1 = info.spectrum ? spectrumLeft : pcmLeft;
            const audio2 = info.spectrum ? spectrumRight : pcmRight;
            
            const points = wave.evaluatePoints(this._ctx, audio1, audio2);
            results.push({
                points,
                useDots: info.useDots,
                drawThick: info.drawThick,
                additive: info.additive,
            });
        }

        return results;
    }

    /**
     * Get custom shape geometry for all enabled shapes.
     * @returns {Array} Array of shape geometries
     */
    evaluateCustomShapes() {
        const results = [];
        
        for (let i = 0; i < 4; i++) {
            const shape = this._customShapes[i];
            const geoms = shape.evaluateAllInstances(this._ctx);
            if (geoms && geoms.length > 0) {
                results.push(...geoms);
            }
        }

        return results;
    }

    /**
     * Get the current context (for reading q-vars, etc.).
     */
    getContext() {
        return this._ctx;
    }
}
