/**
 * MilkDrop 2 per-pixel (per-vertex) expression evaluator.
 *
 * Compiles a per_pixel expression string and evaluates it at each mesh vertex.
 * For each vertex the evaluator:
 *   1. Copies per-frame RW vars + q-vars into a per-pixel context
 *   2. Sets read-only per-pixel vars: x, y, rad, ang
 *   3. Resets t1-t8 to 0
 *   4. Runs the compiled per-pixel closure
 *   5. Returns the resulting dx, dy (and optionally zoom, rot, etc.)
 *
 * Pure JS — no GI imports.
 */

import { compile } from './compiler.js';

const NOOP = (_ctx) => {};

export class PerPixelEvaluator {
    constructor() {
        this._fn = NOOP;
    }

    /**
     * Compile a per-pixel expression string.
     * @param {string|null} src
     */
    compile(src) {
        if (!src || src.trim() === '') {
            this._fn = NOOP;
            return;
        }
        this._fn = compile(src);
    }

    /**
     * Evaluate at one vertex. Mutates the frameCtx's t-vars as a side effect
     * (they are reset each call), but preserves q-vars and RW vars.
     *
     * @param {number} x - Normalised X [0,1]
     * @param {number} y - Normalised Y [0,1]
     * @param {FrameContext} frameCtx - The per-frame context (q-vars, RW vars)
     * @returns {{ dx, dy, zoom, rot, warp, cx, cy, sx, sy, zoomexp }}
     */
    evaluate(x, y, frameCtx) {
        // Reset t-vars before each vertex
        frameCtx.resetTVars();

        // Set per-pixel read-only vars
        const cx = x - 0.5;
        const cy = y - 0.5;
        frameCtx.x = x;
        frameCtx.y = y;
        frameCtx.rad = Math.sqrt(cx * cx + cy * cy);
        frameCtx.ang = Math.atan2(cy, cx);

        // Reset per-pixel outputs to defaults (inherited from per-frame)
        const savedDx = frameCtx.dx;
        const savedDy = frameCtx.dy;
        frameCtx.dx = 0;
        frameCtx.dy = 0;

        // Run per-pixel equations
        this._fn(frameCtx);

        // Capture outputs
        const result = {
            dx: frameCtx.dx,
            dy: frameCtx.dy,
            zoom: frameCtx.zoom,
            rot: frameCtx.rot,
            warp: frameCtx.warp,
            cx: frameCtx.cx,
            cy: frameCtx.cy,
            sx: frameCtx.sx,
            sy: frameCtx.sy,
            zoomexp: frameCtx.zoomexp,
        };

        // Restore per-frame dx/dy so next vertex starts fresh
        frameCtx.dx = savedDx;
        frameCtx.dy = savedDy;

        return result;
    }

    /**
     * Evaluate across a full grid of vertices.
     * @param {number} gridX - Number of grid cells in X
     * @param {number} gridY - Number of grid cells in Y
     * @param {FrameContext} frameCtx
     * @returns {Array<{x, y, dx, dy, zoom, rot, ...}>}
     */
    evaluateGrid(gridX, gridY, frameCtx) {
        const results = [];
        for (let gy = 0; gy <= gridY; gy++) {
            for (let gx = 0; gx <= gridX; gx++) {
                const x = gx / gridX;
                const y = gy / gridY;
                const r = this.evaluate(x, y, frameCtx);
                r.x = x;
                r.y = y;
                results.push(r);
            }
        }
        return results;
    }
}
