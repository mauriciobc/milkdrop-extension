/**
 * MilkDrop-style mesh grid for per-vertex warp evaluation.
 *
 * The grid is a cols×rows set of quads (two triangles each) covering the
 * full-screen texture in normalised [0,1] UV space.  Each vertex carries
 * its UV coordinate and an initial position in clip-space [-1,1].
 *
 * Layout per vertex: [posX, posY, u, v]   (4 floats, 16 bytes/vertex)
 */

const DEFAULT_COLUMNS = 48;
const DEFAULT_ROWS = 36;
const FLOATS_PER_VERTEX = 4; // posX, posY, u, v

function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function wrap01(value) {
    if (value < 0 || value > 1)
        return value - Math.floor(value);
    return value;
}

/**
 * Build a flat Float32Array of triangle vertices for the warp mesh.
 *
 * @param {number} [cols] - number of columns (quad subdivisions along x)
 * @param {number} [rows] - number of rows (quad subdivisions along y)
 * @returns {{vertices: Float32Array, columns: number, rows: number,
 *            vertexCount: number, floatsPerVertex: number, stride: number}}
 */
export function createDefaultMesh(cols = DEFAULT_COLUMNS, rows = DEFAULT_ROWS) {
    const quads = cols * rows;
    const trianglesPerQuad = 2;
    const verticesPerTriangle = 3;
    const totalVertices = quads * trianglesPerQuad * verticesPerTriangle;
    const vertices = new Float32Array(totalVertices * FLOATS_PER_VERTEX);

    let offset = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            // UV corners of this quad
            const u0 = col / cols;
            const u1 = (col + 1) / cols;
            const v0 = row / rows;
            const v1 = (row + 1) / rows;

            // Clip-space corners: UV [0,1] → clip [-1,+1]
            const x0 = u0 * 2 - 1;
            const x1 = u1 * 2 - 1;
            const y0 = v0 * 2 - 1;
            const y1 = v1 * 2 - 1;

            // Triangle 1: top-left, bottom-left, bottom-right
            vertices[offset++] = x0; vertices[offset++] = y0; vertices[offset++] = u0; vertices[offset++] = v0;
            vertices[offset++] = x0; vertices[offset++] = y1; vertices[offset++] = u0; vertices[offset++] = v1;
            vertices[offset++] = x1; vertices[offset++] = y1; vertices[offset++] = u1; vertices[offset++] = v1;

            // Triangle 2: top-left, bottom-right, top-right
            vertices[offset++] = x0; vertices[offset++] = y0; vertices[offset++] = u0; vertices[offset++] = v0;
            vertices[offset++] = x1; vertices[offset++] = y1; vertices[offset++] = u1; vertices[offset++] = v1;
            vertices[offset++] = x1; vertices[offset++] = y0; vertices[offset++] = u1; vertices[offset++] = v0;
        }
    }

    return {
        vertices,
        columns: cols,
        rows,
        vertexCount: totalVertices,
        floatsPerVertex: FLOATS_PER_VERTEX,
        stride: FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT,
    };
}

/**
 * Apply per-vertex warp deformation to a mesh in-place.
 *
 * Each vertex position (first two floats) is displaced based on the
 * frame parameters (zoom, rotation, translation) evaluated at that
 * vertex's UV coordinate.
 *
 * @param {Float32Array} vertices - interleaved vertex data [pos.x, pos.y, u, v, …]
 * @param {number} vertexCount - total number of vertices
 * @param {object} frame - evaluated frame params {zoom, rot, dx, dy, decay}
 * @param {Function|null} evalVertex - optional (u,v,frame)→[u',v'] evaluator
 */
export function applyWarpToMesh(vertices, vertexCount, frame, evalVertex = null) {
    const frameZoom = numberOr(frame.zoom, 1.0);
    const frameRot = numberOr(frame.rot, 0.0);
    const frameDx = numberOr(frame.dx, 0.0);
    const frameDy = numberOr(frame.dy, 0.0);
    const frameCx = numberOr(frame.cx, 0.5);
    const frameCy = numberOr(frame.cy, 0.5);
    const frameSx = numberOr(frame.sx, 1.0);
    const frameSy = numberOr(frame.sy, 1.0);
    const frameZoomExp = numberOr(frame.zoomexp, 1.0);
    const frameWrap = numberOr(frame.wrap, 1.0);

    for (let i = 0; i < vertexCount; i++) {
        const base = i * FLOATS_PER_VERTEX;
        let u = vertices[base + 2];
        let v = vertices[base + 3];

        let zoom = frameZoom;
        let rot = frameRot;
        let dx = frameDx;
        let dy = frameDy;
        let cx = frameCx;
        let cy = frameCy;
        let sx = frameSx;
        let sy = frameSy;
        let zoomexp = frameZoomExp;
        let wrap = frameWrap;

        if (evalVertex) {
            const result = evalVertex(u, v, frame);
            if (Array.isArray(result)) {
                u = numberOr(result[0], u);
                v = numberOr(result[1], v);
            } else if (result && typeof result === 'object') {
                if (result.u !== undefined || result.v !== undefined) {
                    u = numberOr(result.u, u);
                    v = numberOr(result.v, v);
                } else {
                    u += numberOr(result.dx, 0.0);
                    v += numberOr(result.dy, 0.0);
                }

                zoom = numberOr(result.zoom, zoom);
                rot = numberOr(result.rot, rot);
                cx = numberOr(result.cx, cx);
                cy = numberOr(result.cy, cy);
                sx = numberOr(result.sx, sx);
                sy = numberOr(result.sy, sy);
                zoomexp = numberOr(result.zoomexp, zoomexp);
                wrap = numberOr(result.wrap, wrap);
            }
        }

        // Center around pivot, stretch, then apply zoom^zoomexp and rotation.
        let cu = (u - cx) * sx;
        let cv = (v - cy) * sy;

        const safeZoomBase = Math.max(Math.abs(zoom), 1e-6);
        const zoomScaleCandidate = Math.pow(safeZoomBase, zoomexp);
        const zoomScale = Number.isFinite(zoomScaleCandidate) && zoomScaleCandidate > 1e-6
            ? zoomScaleCandidate
            : 1e-6;

        cu /= zoomScale;
        cv /= zoomScale;

        // Apply rotation
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        const ru = cu * cosR - cv * sinR;
        const rv = cu * sinR + cv * cosR;

        // Translate and restore to [0,1]
        let finalU = ru + cx + dx;
        let finalV = rv + cy + dy;

        if (wrap >= 0.5) {
            finalU = wrap01(finalU);
            finalV = wrap01(finalV);
        } else {
            finalU = clamp01(finalU);
            finalV = clamp01(finalV);
        }

        // Map UV back to clip space [-1, +1]
        vertices[base + 0] = finalU * 2 - 1;
        vertices[base + 1] = finalV * 2 - 1;
    }
}
