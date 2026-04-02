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

const NOOP = (_ctx) => {};

export class ExpressionEvaluator {
    constructor() {
        this._ctx = new FrameContext();
        this._initFn = NOOP;
        this._frameFn = NOOP;
        this._preset = null;
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
            return;
        }

        if (preset.baseVals)
            this._ctx.applyBaseVals(preset.baseVals);

        this._initFn = preset.init_eqs ? compile(preset.init_eqs) : NOOP;
        this._frameFn = preset.frame_eqs ? compile(preset.frame_eqs) : NOOP;

        this._ctx.rerollPresetRandom();
    }

    /**
     * Inject fixed rand_start/rand_preset for deterministic testing (golden frame).
     * Call after loadPreset and before runInit when generating or comparing goldens.
     * @param {[number,number,number,number]|{x,y,z,w}|null} randStart
     * @param {[number,number,number,number]|{x,y,z,w}|null} randPreset
     */
    setRandForTesting(randStart, randPreset) {
        this._ctx.setRandForTesting(randStart, randPreset);
    }

    /**
     * Run init_eqs once (called after loadPreset, before first frame).
     */
    runInit() {
        this._initFn(this._ctx);
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

        return this._ctx;
    }

    /**
     * Get the current context (for reading q-vars, etc.).
     */
    getContext() {
        return this._ctx;
    }
}
