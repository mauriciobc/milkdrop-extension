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
    const zoom = frame.zoom ?? 1.0;
    const rot = frame.rot ?? 0.0;
    const dx = frame.dx ?? 0.0;
    const dy = frame.dy ?? 0.0;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);

    for (let i = 0; i < vertexCount; i++) {
        const base = i * FLOATS_PER_VERTEX;
        let u = vertices[base + 2];
        let v = vertices[base + 3];

        if (evalVertex) {
            const result = evalVertex(u, v, frame);
            u = result[0];
            v = result[1];
        }

        // Centre UVs around (0.5, 0.5) for zoom and rotation
        let cu = u - 0.5;
        let cv = v - 0.5;

        // Apply zoom (inward zoom means dividing)
        cu /= zoom;
        cv /= zoom;

        // Apply rotation
        const ru = cu * cosR - cv * sinR;
        const rv = cu * sinR + cv * cosR;

        // Translate and restore to [0,1]
        const finalU = ru + 0.5 + dx;
        const finalV = rv + 0.5 + dy;

        // Map UV back to clip space [-1, +1]
        vertices[base + 0] = finalU * 2 - 1;
        vertices[base + 1] = finalV * 2 - 1;
    }
}
