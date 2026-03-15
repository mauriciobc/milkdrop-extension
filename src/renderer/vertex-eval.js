/**
 * Per-vertex expression evaluator for MilkDrop warp mesh.
 *
 * A compiled vertex program receives (u, v) texture coordinates and the
 * current frame state, and returns warped (u', v') coordinates.
 *
 * Supports two modes:
 *   1. Expression-based: per-pixel equations (MilkDrop pixel_eqs strings)
 *   2. Legacy WaveSpec: lightweight specification object
 */

import { PerPixelEvaluator } from '../extension/expr/per-pixel.js';

export class VertexEvaluator {
    constructor() {
        this._source = null;
        this._compiled = null;
        this._perPixel = null;
    }

    /**
     * Compile a per-vertex warp specification.
     *
     * @param {object|string|null} source - Either:
     *   - A string (MilkDrop pixel_eqs expression)
     *   - A spec object { warpAmount, warpSpeed, warpScale, warpType }
     *   - null/undefined for identity
     */
    compile(source) {
        this._source = source ?? null;
        this._perPixel = null;
        this._compiled = null;

        if (!source)
            return;

        // Expression-based per-pixel
        if (typeof source === 'string') {
            this._perPixel = new PerPixelEvaluator();
            this._perPixel.compile(source);
            return;
        }

        // Legacy WaveSpec
        this._compiled = {
            warpAmount: source.warpAmount ?? 0.0,
            warpSpeed: source.warpSpeed ?? 1.0,
            warpScale: source.warpScale ?? 1.0,
            warpType: source.warpType ?? 'radial',
        };
    }

    /**
     * Evaluate a single vertex.
     *
     * @param {number} u - normalised texture coordinate [0,1]
     * @param {number} v - normalised texture coordinate [0,1]
     * @param {object} [frame] - current frame state {t, zoom, rot, dx, dy, decay, audio, _exprCtx}
     * @returns {object} warped texture coordinates and per-pixel overrides
     */
    evaluate(u, v, frame = null) {
        // Expression-based per-pixel path
        if (this._perPixel && frame?._exprCtx) {
            const r = this._perPixel.evaluate(u, v, frame._exprCtx);
            return {
                u: u + r.dx,
                v: v + r.dy,
                zoom: r.zoom,
                rot: r.rot,
                warp: r.warp,
                cx: r.cx,
                cy: r.cy,
                sx: r.sx,
                sy: r.sy,
                zoomexp: r.zoomexp,
            };
        }

        // Default / Legacy path - determine warped UV
        let warpedU = u;
        let warpedV = v;

        if (this._compiled && this._compiled.warpAmount !== 0) {
            const spec = this._compiled;
            const t = frame?.t ?? 0;
            const energy = frame?.audio?.energy ?? 0;

            // Centre around (0.5, 0.5)
            const cu = u - 0.5;
            const cv = v - 0.5;

            switch (spec.warpType) {
            case 'radial': {
                const dist = Math.sqrt(cu * cu + cv * cv);
                const amount = spec.warpAmount * (1 + energy * 0.5);
                const displacement = Math.sin(dist * spec.warpScale * 10 - t * spec.warpSpeed) * amount;
                if (dist >= 0.001) {
                    warpedU = u + cu / dist * displacement;
                    warpedV = v + cv / dist * displacement;
                }
                break;
            }
            case 'angular': {
                const dist = Math.sqrt(cu * cu + cv * cv);
                const angle = Math.atan2(cv, cu);
                const twist = spec.warpAmount * Math.sin(t * spec.warpSpeed) * (1 + energy * 0.3);
                const newAngle = angle + twist * dist * spec.warpScale;
                warpedU = Math.cos(newAngle) * dist + 0.5;
                warpedV = Math.sin(newAngle) * dist + 0.5;
                break;
            }
            case 'wave': {
                const amount = spec.warpAmount * (1 + energy * 0.4);
                warpedU = u + Math.sin(v * spec.warpScale * 6.28 + t * spec.warpSpeed) * amount;
                warpedV = v + Math.cos(u * spec.warpScale * 6.28 + t * spec.warpSpeed * 0.7) * amount;
                break;
            }
            default:
                break;
            }
        }

        return {
            u: warpedU,
            v: warpedV,
            zoom: frame?.zoom ?? 1.0,
            rot: frame?.rot ?? 0.0,
            warp: frame?.warp ?? 1.0,
            cx: frame?.cx ?? 0.5,
            cy: frame?.cy ?? 0.5,
            sx: frame?.sx ?? 1.0,
            sy: frame?.sy ?? 1.0,
            zoomexp: frame?.zoomexp ?? 1.0,
        };
    }
}