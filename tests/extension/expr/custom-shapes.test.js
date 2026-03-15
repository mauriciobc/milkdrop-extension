/**
 * Tests for MilkDrop 2 custom shapes.
 */
import { CustomShape } from '../../../src/extension/expr/custom-shapes.js';
import { FrameContext } from '../../../src/extension/expr/context.js';

const EPSILON = 0.01;
function near(a, b) { return Math.abs(a - b) < EPSILON; }

export function run(assert) {
    // ── Basic shape with defaults ─────────────────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 4, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 0, b: 0, a: 0.8 },
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(geom !== null, 'enabled shape produces geometry');
        assert(geom.sides === 4, 'shape has 4 sides');
        assert(near(geom.x, 0.5), 'shape x = 0.5');
        assert(near(geom.y, 0.5), 'shape y = 0.5');
        assert(near(geom.rad, 0.1), 'shape rad = 0.1');
        assert(near(geom.r, 1), 'shape r = 1');
        assert(near(geom.a, 0.8), 'shape a = 0.8');
    }

    // ── Disabled shape produces null geometry ─────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 0, sides: 4, x: 0.5, y: 0.5, rad: 0.1 },
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(geom === null, 'disabled shape produces null geometry');
    }

    // ── Frame equations modify shape params ───────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 6, x: 0.5, y: 0.5, rad: 0.1, ang: 0,
                        r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 'ang = time * 0.5; rad = 0.1 + bass * 0.3;',
        });
        const ctx = new FrameContext();
        ctx.setReadOnly({ time: 2.0, bass: 1.0 });
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(near(geom.ang, 1.0), 'frame_eqs: ang = time * 0.5 = 1.0');
        assert(near(geom.rad, 0.4), 'frame_eqs: rad = 0.1 + 1.0 * 0.3 = 0.4');
    }

    // ── Init equations run once ───────────────────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 3, x: 0.5, y: 0.5, rad: 0.2,
                        r: 1, g: 1, b: 1, a: 1 },
            init_eqs: 'q1 = 42;',
            frame_eqs: 'rad = q1 * 0.01;',
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(near(geom.rad, 0.42), 'init sets q1, frame reads it for rad');
    }

    // ── 4 independent shapes don't leak state ─────────────────────
    {
        const shapes = [];
        for (let i = 0; i < 4; i++) {
            const s = new CustomShape(i);
            s.load({
                baseVals: { enabled: 1, sides: 3 + i, x: 0.1 * i, y: 0.5,
                            rad: 0.05 * (i + 1), r: 1, g: 1, b: 1, a: 1 },
            });
            shapes.push(s);
        }
        const ctx = new FrameContext();
        for (const s of shapes) {
            s.runInit(ctx);
            s.evaluateFrame(ctx);
        }
        for (let i = 0; i < 4; i++) {
            const geom = shapes[i].getGeometry();
            assert(geom.sides === 3 + i, `shape ${i} has ${3 + i} sides`);
            assert(near(geom.rad, 0.05 * (i + 1)), `shape ${i} rad correct`);
        }
    }

    // ── Geometry produces correct vertex ring ─────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 4, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 0, b: 0, a: 0.8, r2: 0, g2: 1, b2: 0, a2: 0.5 },
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(geom.vertices.length === 4, '4-sided shape has 4 ring vertices');
        // Ring vertices should be at rad distance from center
        for (const v of geom.vertices) {
            const dx = v.x - geom.x;
            const dy = v.y - geom.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            assert(near(dist, 0.1), 'ring vertex at correct radius');
        }
        // Outer color
        assert(near(geom.vertices[0].r, 0), 'ring vertex has r2 color');
        assert(near(geom.vertices[0].g, 1), 'ring vertex has g2 color');
    }

    // ── additive flag ─────────────────────────────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 3, additive: 1, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 1, b: 1, a: 1 },
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(geom.additive === true, 'additive flag preserved');
    }

    // ── textured flag ─────────────────────────────────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 3, textured: 1, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 1, b: 1, a: 1, tex_ang: 0.5, tex_zoom: 2.0 },
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        shape.evaluateFrame(ctx);
        const geom = shape.getGeometry();
        assert(geom.textured === true, 'textured flag preserved');
        assert(near(geom.tex_ang, 0.5), 'tex_ang preserved');
        assert(near(geom.tex_zoom, 2.0), 'tex_zoom preserved');
    }

    // ── num_inst > 1: frame_eqs runs per instance ─────────────────
    {
        const shape = new CustomShape(0);
        shape.load({
            baseVals: { enabled: 1, sides: 3, num_inst: 3, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 'x = x + instance * 0.1;',
        });
        const ctx = new FrameContext();
        shape.runInit(ctx);
        const geoms = shape.evaluateAllInstances(ctx);
        assert(geoms.length === 3, 'num_inst=3 produces 3 geometries');
        assert(near(geoms[0].x, 0.5), 'instance 0: x = 0.5');
        assert(near(geoms[1].x, 0.6), 'instance 1: x = 0.6');
        assert(near(geoms[2].x, 0.7), 'instance 2: x = 0.7');
    }

    // ── T-vars isolated between shapes ────────────────────────────
    {
        const s1 = new CustomShape(0);
        s1.load({
            baseVals: { enabled: 1, sides: 3, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 't1 = 99;',
        });
        const s2 = new CustomShape(1);
        s2.load({
            baseVals: { enabled: 1, sides: 3, x: 0.5, y: 0.5, rad: 0.1,
                        r: 1, g: 1, b: 1, a: 1 },
            frame_eqs: 'rad = t1 * 0.001;',
        });
        const ctx = new FrameContext();
        s1.runInit(ctx);
        s2.runInit(ctx);
        s1.evaluateFrame(ctx);
        s2.evaluateFrame(ctx);
        const geom = s2.getGeometry();
        // t1 should be 0 when s2 runs (isolated), not 99 from s1
        assert(near(geom.rad, 0), 't-vars isolated: s2 sees t1=0');
    }
}
