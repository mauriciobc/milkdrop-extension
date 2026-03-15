/**
 * MilkDrop 2 custom shapes.
 *
 * Each shape slot (0-3) has:
 *   - baseVals: default parameters
 *   - init_eqs: run once at preset load
 *   - frame_eqs: run each frame (per instance if num_inst > 1)
 *
 * Shape params: enabled, sides, additive, thickOutline, textured, num_inst,
 *   x, y, rad, ang, tex_ang, tex_zoom,
 *   r, g, b, a, r2, g2, b2, a2,
 *   border_r, border_g, border_b, border_a
 *
 * The evaluator runs the expressions and produces geometry descriptions
 * (center + N ring vertices + colors) for the renderer.
 *
 * Pure JS — no GI imports.
 */

import { compile } from './compiler.js';

const NOOP = (_ctx) => {};

const SHAPE_DEFAULTS = {
    enabled: 0, sides: 4, additive: 0, thickOutline: 0, textured: 0, num_inst: 1,
    x: 0.5, y: 0.5, rad: 0.1, ang: 0, tex_ang: 0, tex_zoom: 1.0,
    r: 1, g: 0, b: 0, a: 0.8,
    r2: 0, g2: 1, b2: 0, a2: 0.5,
    border_r: 1, border_g: 1, border_b: 1, border_a: 0.1,
};

const SHAPE_KEYS = Object.keys(SHAPE_DEFAULTS);

export class CustomShape {
    /**
     * @param {number} index - Shape slot index (0-3)
     */
    constructor(index) {
        this.index = index;
        this._baseVals = { ...SHAPE_DEFAULTS };
        this._vals = { ...SHAPE_DEFAULTS };
        this._initFn = NOOP;
        this._frameFn = NOOP;
    }

    /**
     * Load shape definition from preset.
     * @param {object} def - { baseVals, init_eqs, frame_eqs }
     */
    load(def) {
        if (!def) {
            this._baseVals = { ...SHAPE_DEFAULTS };
            this._initFn = NOOP;
            this._frameFn = NOOP;
            return;
        }

        // Merge base values
        this._baseVals = { ...SHAPE_DEFAULTS };
        if (def.baseVals) {
            for (const [k, v] of Object.entries(def.baseVals)) {
                if (k in SHAPE_DEFAULTS)
                    this._baseVals[k] = v;
            }
        }

        this._initFn = def.init_eqs ? compile(def.init_eqs) : NOOP;
        this._frameFn = def.frame_eqs ? compile(def.frame_eqs) : NOOP;
    }

    /**
     * Run init equations (once per preset load).
     * Can write q-vars to the frame context.
     */
    runInit(frameCtx) {
        // Build a temp context merging shape vals + frame ctx
        const tmpCtx = this._buildShapeCtx(frameCtx);
        this._initFn(tmpCtx);
        // Write back q-vars to frame context
        this._writeBackQVars(tmpCtx, frameCtx);
    }

    /**
     * Run frame equations for the shape (single instance).
     */
    evaluateFrame(frameCtx) {
        this._resetVals();
        const tmpCtx = this._buildShapeCtx(frameCtx);
        tmpCtx.instance = 0;
        this._frameFn(tmpCtx);
        this._readBackVals(tmpCtx);
        this._writeBackQVars(tmpCtx, frameCtx);
    }

    /**
     * Run frame equations for all instances (num_inst).
     * Returns array of geometry descriptions.
     */
    evaluateAllInstances(frameCtx) {
        const numInst = Math.max(1, Math.floor(this._baseVals.num_inst));
        const geoms = [];
        for (let i = 0; i < numInst; i++) {
            this._resetVals();
            const tmpCtx = this._buildShapeCtx(frameCtx);
            tmpCtx.instance = i;
            this._frameFn(tmpCtx);
            this._readBackVals(tmpCtx);
            this._writeBackQVars(tmpCtx, frameCtx);
            const geom = this._buildGeometry();
            if (geom)
                geoms.push(geom);
        }
        return geoms;
    }

    /**
     * Get geometry for the current shape state.
     * Returns null if shape is disabled.
     */
    getGeometry() {
        return this._buildGeometry();
    }

    // ── Internal ──────────────────────────────────────────────────

    _resetVals() {
        for (const key of SHAPE_KEYS)
            this._vals[key] = this._baseVals[key];
    }

    /**
     * Build a temporary context for expression evaluation.
     * Merges shape params + frame context read-only vars + q-vars.
     * T-vars are isolated (start at 0).
     */
    _buildShapeCtx(frameCtx) {
        const ctx = {};

        // Copy read-only frame vars
        const roKeys = ['time', 'frame', 'fps', 'progress',
            'bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att',
            'meshx', 'meshy', 'aspectx', 'aspecty', 'pixelsx', 'pixelsy'];
        for (const k of roKeys)
            ctx[k] = frameCtx[k] ?? 0;

        // Copy q-vars from frame context
        for (let i = 1; i <= 32; i++)
            ctx[`q${i}`] = frameCtx[`q${i}`] ?? 0;

        // Isolated t-vars (start at 0)
        for (let i = 1; i <= 8; i++)
            ctx[`t${i}`] = 0;

        // Copy reg vars
        for (let i = 0; i < 100; i++) {
            const k = `reg${String(i).padStart(2, '0')}`;
            ctx[k] = frameCtx[k] ?? 0;
        }

        // Set shape-specific params
        for (const key of SHAPE_KEYS)
            ctx[key] = this._vals[key];

        return ctx;
    }

    _readBackVals(tmpCtx) {
        for (const key of SHAPE_KEYS) {
            if (key in tmpCtx)
                this._vals[key] = tmpCtx[key];
        }
    }

    _writeBackQVars(tmpCtx, frameCtx) {
        for (let i = 1; i <= 32; i++)
            frameCtx[`q${i}`] = tmpCtx[`q${i}`] ?? frameCtx[`q${i}`];
    }

    _buildGeometry() {
        const v = this._vals;
        if (!v.enabled)
            return null;

        const sides = Math.max(3, Math.floor(v.sides));
        const vertices = [];

        for (let i = 0; i < sides; i++) {
            const angle = v.ang + (i / sides) * Math.PI * 2;
            vertices.push({
                x: v.x + Math.cos(angle) * v.rad,
                y: v.y + Math.sin(angle) * v.rad,
                r: v.r2 ?? 0,
                g: v.g2 ?? 0,
                b: v.b2 ?? 0,
                a: v.a2 ?? 0.5,
            });
        }

        return {
            index: this.index,
            sides,
            x: v.x,
            y: v.y,
            rad: v.rad,
            ang: v.ang,
            r: v.r,
            g: v.g,
            b: v.b,
            a: v.a,
            r2: v.r2 ?? 0,
            g2: v.g2 ?? 0,
            b2: v.b2 ?? 0,
            a2: v.a2 ?? 0.5,
            additive: !!v.additive,
            thickOutline: !!v.thickOutline,
            textured: !!v.textured,
            tex_ang: v.tex_ang ?? 0,
            tex_zoom: v.tex_zoom ?? 1.0,
            border_r: v.border_r ?? 1,
            border_g: v.border_g ?? 1,
            border_b: v.border_b ?? 1,
            border_a: v.border_a ?? 0.1,
            vertices,
        };
    }
}
