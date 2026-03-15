/**
 * MilkDrop 2 per-frame variable context.
 *
 * A plain-object-like context that the compiled expressions read/write via
 * ctx[name].  Provides lifecycle methods for the frame loop:
 *   - setReadOnly()   — engine sets time, bass, etc. each frame
 *   - applyBaseVals() — preset's base values loaded once
 *   - resetPerFrame() — restore RW vars to base values before per-frame eqs
 *   - resetTVars()    — zero t1-t8 before each per-pixel vertex
 *   - snapshot()/restore() — blend transitions
 *
 * Pure JS — no GI imports.
 */

/* Default values for per-frame read-write variables */
const RW_DEFAULTS = {
    zoom: 1.0, zoomexp: 1.0, rot: 0.0, warp: 1.0,
    cx: 0.5, cy: 0.5, dx: 0.0, dy: 0.0, sx: 1.0, sy: 1.0,
    decay: 0.98,
    wave_mode: 0, wave_a: 0.8, wave_r: 1.0, wave_g: 1.0, wave_b: 1.0,
    wave_x: 0.5, wave_y: 0.5, wave_scale: 1.0, wave_smoothing: 0.75,
    wave_mystery: 0.0,
    ob_size: 0.01, ob_r: 0.0, ob_g: 0.0, ob_b: 0.0, ob_a: 0.0,
    ib_size: 0.01, ib_r: 0.25, ib_g: 0.25, ib_b: 0.25, ib_a: 0.0,
    mv_x: 12.0, mv_y: 9.0, mv_dx: 0.0, mv_dy: 0.0, mv_l: 0.9,
    mv_r: 1.0, mv_g: 1.0, mv_b: 1.0, mv_a: 0.0,
    b1n: 0.0, b2n: 0.0, b3n: 0.0, b1x: 1.0, b2x: 1.0, b3x: 1.0, b1ed: 0.25,
    darken_center: 0, gamma: 1.0,
    echo_zoom: 1.0, echo_alpha: 0.0, echo_orient: 0,
    invert: 0, brighten: 0, darken: 0, solarize: 0, wrap: 1,
    additivewave: 0, wave_dots: 0, wave_thick: 0,
    monitor: 0.0,
};

const RW_KEYS = Object.keys(RW_DEFAULTS);

export class FrameContext {
    constructor() {
        // Read-only (engine-set) variables
        this.time = 0;
        this.frame = 0;
        this.fps = 30;
        this.progress = 0;
        this.bass = 0;
        this.mid = 0;
        this.treb = 0;
        this.high = 0;
        this.bass_att = 0;
        this.mid_att = 0;
        this.treb_att = 0;
        this.energy = 0;
        this.beat = 0;
        this.meshx = 48;
        this.meshy = 36;
        this.aspectx = 1;
        this.aspecty = 1;
        this.pixelsx = 512;
        this.pixelsy = 512;

        // Random values (fixed at preset load / start)
        this._rand_start = [Math.random(), Math.random(), Math.random(), Math.random()];
        this._rand_preset = [Math.random(), Math.random(), Math.random(), Math.random()];
        this.rand_start = { x: this._rand_start[0], y: this._rand_start[1], z: this._rand_start[2], w: this._rand_start[3] };
        this.rand_preset = { x: this._rand_preset[0], y: this._rand_preset[1], z: this._rand_preset[2], w: this._rand_preset[3] };

        // Per-frame read-write variables (with defaults)
        for (const key of RW_KEYS)
            this[key] = RW_DEFAULTS[key];

        // Q variables q1-q32 (persist across frames)
        for (let i = 1; i <= 32; i++)
            this[`q${i}`] = 0;

        // T variables t1-t8 (per-pixel temporaries)
        for (let i = 1; i <= 8; i++)
            this[`t${i}`] = 0;

        // Reg variables reg00-reg99
        for (let i = 0; i < 100; i++)
            this[`reg${String(i).padStart(2, '0')}`] = 0;

        // Base values snapshot (set by applyBaseVals)
        this._baseVals = { ...RW_DEFAULTS };
    }

    /**
     * Set engine-driven read-only variables for this frame.
     */
    setReadOnly(vals) {
        if (!vals) return;
        const keys = ['time', 'frame', 'fps', 'progress',
            'bass', 'mid', 'treb', 'high', 'bass_att', 'mid_att', 'treb_att', 'energy', 'beat',
            'meshx', 'meshy', 'aspectx', 'aspecty', 'pixelsx', 'pixelsy'];
        for (const k of keys) {
            if (k in vals)
                this[k] = vals[k];
        }

        // Keep high/treb aliases coherent when only one side is provided.
        if (!('high' in vals) && 'treb' in vals)
            this.high = vals.treb;
        if (!('treb' in vals) && 'high' in vals)
            this.treb = vals.high;
    }

    /**
     * Apply preset base values (run once when preset loads).
     */
    applyBaseVals(vals) {
        if (!vals) return;
        for (const key of RW_KEYS)
            this._baseVals[key] = RW_DEFAULTS[key];
        for (const [k, v] of Object.entries(vals)) {
            if (k in RW_DEFAULTS) {
                this._baseVals[k] = v;
                this[k] = v;
            } else {
                // Allow setting q/t/reg vars from baseVals too
                this[k] = v;
            }
        }
    }

    /**
     * Reset per-frame RW variables to base values before running per-frame eqs.
     * Q-vars, t-vars, and reg-vars are NOT reset.
     */
    resetPerFrame() {
        for (const key of RW_KEYS)
            this[key] = this._baseVals[key];
    }

    /**
     * Reset t1-t8 to 0 before each per-pixel vertex evaluation.
     */
    resetTVars() {
        for (let i = 1; i <= 8; i++)
            this[`t${i}`] = 0;
    }

    /**
     * Snapshot all state for blend transitions.
     */
    snapshot() {
        const snap = {};
        for (const key of RW_KEYS)
            snap[key] = this[key];
        for (let i = 1; i <= 32; i++)
            snap[`q${i}`] = this[`q${i}`];
        for (let i = 1; i <= 8; i++)
            snap[`t${i}`] = this[`t${i}`];
        for (let i = 0; i < 100; i++) {
            const k = `reg${String(i).padStart(2, '0')}`;
            snap[k] = this[k];
        }
        return snap;
    }

    /**
     * Restore from a previous snapshot.
     */
    restore(snap) {
        if (!snap) return;
        for (const [k, v] of Object.entries(snap))
            this[k] = v;
    }

    /**
     * Regenerate random values (called on preset change).
     */
    rerollPresetRandom() {
        this._rand_preset = [Math.random(), Math.random(), Math.random(), Math.random()];
        this.rand_preset = { x: this._rand_preset[0], y: this._rand_preset[1], z: this._rand_preset[2], w: this._rand_preset[3] };
    }

    /**
     * Reset for a new preset while keeping large buffers.
     */
    resetForNewPreset() {
        this.rerollPresetRandom();
        for (const key of RW_KEYS) {
            this._baseVals[key] = RW_DEFAULTS[key];
            this[key] = RW_DEFAULTS[key];
        }
        for (let i = 1; i <= 32; i++)
            this[`q${i}`] = 0;
        for (let i = 1; i <= 8; i++)
            this[`t${i}`] = 0;
        for (let i = 0; i < 100; i++)
            this[`reg${String(i).padStart(2, '0')}`] = 0;

        if (this._megabuf)
            this._megabuf.fill(0);
        // gmegabuf persists across presets by design in MilkDrop.
    }
}
