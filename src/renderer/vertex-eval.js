/**
 * Per-vertex expression evaluator for MilkDrop warp mesh.
 *
 * A compiled vertex program receives (u, v) texture coordinates and the
 * current frame state, and returns warped (u', v') coordinates.
 *
 * The preset's per-vertex code is currently represented as a lightweight
 * specification object rather than arbitrary user code.  This avoids eval()
 * and keeps the renderer safe for the review-first model.
 */

export class VertexEvaluator {
    constructor() {
        this._source = null;
        this._compiled = null;
    }

    /**
     * Compile a per-vertex warp specification.
     *
     * @param {object|null} source - Vertex spec from the preset, e.g.:
     *   { warpAmount: 0.02, warpSpeed: 1.0, warpScale: 1.0, warpType: 'radial' }
     *   If null/undefined, evaluate() returns identity.
     */
    compile(source) {
        this._source = source ?? null;
        if (!source) {
            this._compiled = null;
            return;
        }

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
     * @param {object} [frame] - current frame state {t, zoom, rot, dx, dy, decay, audio}
     * @returns {number[]} [u', v'] warped texture coordinates
     */
    evaluate(u, v, frame = null) {
        if (!this._compiled || this._compiled.warpAmount === 0)
            return [u, v];

        const spec = this._compiled;
        const t = frame?.t ?? 0;
        const energy = frame?.audio?.energy ?? 0;

        // Centre around (0.5, 0.5)
        const cu = u - 0.5;
        const cv = v - 0.5;

        switch (spec.warpType) {
        case 'radial': {
            // Radial distortion: vertices pushed outward/inward based on distance from centre
            const dist = Math.sqrt(cu * cu + cv * cv);
            const amount = spec.warpAmount * (1 + energy * 0.5);
            const displacement = Math.sin(dist * spec.warpScale * 10 - t * spec.warpSpeed) * amount;
            if (dist < 0.001)
                return [u, v];
            return [
                u + cu / dist * displacement,
                v + cv / dist * displacement,
            ];
        }
        case 'angular': {
            // Angular twist: rotate UV angle based on distance
            const dist = Math.sqrt(cu * cu + cv * cv);
            const angle = Math.atan2(cv, cu);
            const twist = spec.warpAmount * Math.sin(t * spec.warpSpeed) * (1 + energy * 0.3);
            const newAngle = angle + twist * dist * spec.warpScale;
            return [
                Math.cos(newAngle) * dist + 0.5,
                Math.sin(newAngle) * dist + 0.5,
            ];
        }
        case 'wave': {
            // Directional wave distortion
            const amount = spec.warpAmount * (1 + energy * 0.4);
            return [
                u + Math.sin(v * spec.warpScale * 6.28 + t * spec.warpSpeed) * amount,
                v + Math.cos(u * spec.warpScale * 6.28 + t * spec.warpSpeed * 0.7) * amount,
            ];
        }
        default:
            return [u, v];
        }
    }
}