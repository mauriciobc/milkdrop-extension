import { createDefaultMesh, applyWarpToMesh } from '../../src/renderer/mesh.js';

const FLOATS_PER_VERTEX = 4;

export function run(assert) {
    // createDefaultMesh(cols, rows): vertexCount, columns, rows, floatsPerVertex, stride
    {
        const m = createDefaultMesh(4, 3);
        const expectedVertices = 4 * 3 * 2 * 3; // quads * 2 triangles * 3 vertices
        assert(m.vertexCount === expectedVertices, 'createDefaultMesh vertexCount');
        assert(m.columns === 4 && m.rows === 3, 'createDefaultMesh columns/rows');
        assert(m.floatsPerVertex === FLOATS_PER_VERTEX, 'createDefaultMesh floatsPerVertex');
        assert(m.stride === FLOATS_PER_VERTEX * 4, 'createDefaultMesh stride (4 bytes per float)');
        assert(m.vertices.length === expectedVertices * FLOATS_PER_VERTEX, 'createDefaultMesh vertices length');
    }

    // createDefaultMesh() default 48x36
    {
        const m = createDefaultMesh();
        const expected = 48 * 36 * 2 * 3 * FLOATS_PER_VERTEX;
        assert(m.vertices.length === expected, 'createDefaultMesh() default size');
        assert(m.columns === 48 && m.rows === 36, 'createDefaultMesh() default cols/rows');
    }

    // createDefaultMesh first vertex: pos and UV
    {
        const m = createDefaultMesh(2, 2);
        const x0 = m.vertices[0];
        const y0 = m.vertices[1];
        const u0 = m.vertices[2];
        const v0 = m.vertices[3];
        assert(u0 === 0 && v0 === 0, 'first vertex UV (0,0)');
        assert(x0 === -1 && y0 === -1, 'first vertex clip (-1,-1)');
    }

    // createDefaultMesh last vertex of 2x2 grid: last quad (1,1) top-right corner (u=1, v=0.5)
    {
        const m = createDefaultMesh(2, 2);
        const last = m.vertices.length - FLOATS_PER_VERTEX;
        const u = m.vertices[last + 2];
        const v = m.vertices[last + 3];
        assert(u === 1 && v === 0.5, 'last vertex UV (1,0.5)');
    }

    // applyWarpToMesh: frame zoom/rot/dx/dy, evalVertex null (first vertex UV 0,0 -> zoom 2 -> clip -0.5,-0.5)
    {
        const m = createDefaultMesh(2, 2);
        const frame = { zoom: 2.0, rot: 0, dx: 0, dy: 0 };
        applyWarpToMesh(m.vertices, m.vertexCount, frame, null);
        const base = 0;
        const posX = m.vertices[base + 0];
        const posY = m.vertices[base + 1];
        const expectedClip = -0.5;
        assert(Math.abs(posX - expectedClip) < 1e-5, 'applyWarpToMesh zoom affects pos.x');
        assert(Math.abs(posY - expectedClip) < 1e-5, 'applyWarpToMesh zoom affects pos.y');
    }

    // applyWarpToMesh with evalVertex that offsets u
    {
        const m = createDefaultMesh(2, 2);
        const frame = { zoom: 1.0, rot: 0, dx: 0, dy: 0 };
        const evalVertex = (u, v) => [u + 0.1, v];
        applyWarpToMesh(m.vertices, m.vertexCount, frame, evalVertex);
        const base = 0;
        const posX = m.vertices[base + 0];
        const uOrig = 0;
        const uNew = 0.1;
        const expectedX = (uNew * 2 - 1);
        assert(Math.abs(posX - expectedX) < 1e-5, 'applyWarpToMesh uses evalVertex UV for position');
    }
}
