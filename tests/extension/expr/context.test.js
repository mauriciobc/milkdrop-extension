/**
 * Tests for the MilkDrop per-frame variable context system.
 */
import { FrameContext } from '../../../src/extension/expr/context.js';

export function run(assert) {
    // ── Construction defaults ─────────────────────────────────────
    {
        const ctx = new FrameContext();
        assert(ctx.time === 0, 'time defaults to 0');
        assert(ctx.frame === 0, 'frame defaults to 0');
        assert(ctx.fps === 30, 'fps defaults to 30');
        assert(ctx.progress === 0, 'progress defaults to 0');
        assert(ctx.bass === 0, 'bass defaults to 0');
        assert(ctx.mid === 0, 'mid defaults to 0');
        assert(ctx.treb === 0, 'treb defaults to 0');
        assert(ctx.high === 0, 'high defaults to 0');
        assert(ctx.bass_att === 0, 'bass_att defaults to 0');
        assert(ctx.mid_att === 0, 'mid_att defaults to 0');
        assert(ctx.treb_att === 0, 'treb_att defaults to 0');
        assert(ctx.energy === 0, 'energy defaults to 0');
        assert(ctx.beat === 0, 'beat defaults to 0');
        assert(ctx.meshx === 48, 'meshx defaults to 48');
        assert(ctx.meshy === 36, 'meshy defaults to 36');
    }

    // ── Per-frame read-write defaults ─────────────────────────────
    {
        const ctx = new FrameContext();
        assert(ctx.zoom === 1.0, 'zoom defaults to 1.0');
        assert(ctx.rot === 0.0, 'rot defaults to 0.0');
        assert(ctx.decay === 0.98, 'decay defaults to 0.98');
        assert(ctx.dx === 0.0, 'dx defaults to 0.0');
        assert(ctx.dy === 0.0, 'dy defaults to 0.0');
        assert(ctx.cx === 0.5, 'cx defaults to 0.5');
        assert(ctx.cy === 0.5, 'cy defaults to 0.5');
        assert(ctx.sx === 1.0, 'sx defaults to 1.0');
        assert(ctx.sy === 1.0, 'sy defaults to 1.0');
        assert(ctx.warp === 1.0, 'warp defaults to 1.0');
        assert(ctx.zoomexp === 1.0, 'zoomexp defaults to 1.0');
        assert(ctx.wave_a === 0.8, 'wave_a defaults to 0.8');
        assert(ctx.wave_r === 1.0, 'wave_r defaults to 1.0');
        assert(ctx.wave_g === 1.0, 'wave_g defaults to 1.0');
        assert(ctx.wave_b === 1.0, 'wave_b defaults to 1.0');
        assert(ctx.gamma === 1.0, 'gamma defaults to 1.0');
    }

    // ── Read-write variables can be modified ──────────────────────
    {
        const ctx = new FrameContext();
        ctx.zoom = 2.0;
        assert(ctx.zoom === 2.0, 'zoom can be written');
        ctx.rot = 0.5;
        assert(ctx.rot === 0.5, 'rot can be written');
        ctx.decay = 0.85;
        assert(ctx.decay === 0.85, 'decay can be written');
    }

    // ── Q variables q1-q32 ────────────────────────────────────────
    {
        const ctx = new FrameContext();
        for (let i = 1; i <= 32; i++) {
            assert(ctx[`q${i}`] === 0, `q${i} defaults to 0`);
        }
        ctx.q1 = 0.5;
        assert(ctx.q1 === 0.5, 'q1 can be written');
        ctx.q32 = 99;
        assert(ctx.q32 === 99, 'q32 can be written');
    }

    // ── T variables t1-t8 ─────────────────────────────────────────
    {
        const ctx = new FrameContext();
        for (let i = 1; i <= 8; i++) {
            assert(ctx[`t${i}`] === 0, `t${i} defaults to 0`);
        }
        ctx.t1 = 3.14;
        assert(ctx.t1 === 3.14, 't1 can be written');
    }

    // ── Reg variables reg00-reg99 ─────────────────────────────────
    {
        const ctx = new FrameContext();
        assert(ctx.reg00 === 0, 'reg00 defaults to 0');
        assert(ctx.reg99 === 0, 'reg99 defaults to 0');
        ctx.reg00 = 42;
        assert(ctx.reg00 === 42, 'reg00 can be written');
    }

    // ── setReadOnly updates engine-driven vars ────────────────────
    {
        const ctx = new FrameContext();
        ctx.setReadOnly({
            time: 1.5,
            frame: 45,
            fps: 60,
            progress: 0.3,
            bass: 0.8,
            mid: 0.5,
            treb: 0.3,
            energy: 0.75,
            beat: 1,
            bass_att: 0.6,
            mid_att: 0.4,
            treb_att: 0.2,
        });
        assert(ctx.time === 1.5, 'time set via setReadOnly');
        assert(ctx.frame === 45, 'frame set via setReadOnly');
        assert(ctx.fps === 60, 'fps set via setReadOnly');
        assert(ctx.bass === 0.8, 'bass set via setReadOnly');
        assert(ctx.treb === 0.3, 'treb set via setReadOnly');
        assert(ctx.high === 0.3, 'high mirrors treb when not explicitly provided');
        assert(ctx.energy === 0.75, 'energy set via setReadOnly');
        assert(ctx.beat === 1, 'beat set via setReadOnly');
    }

    // ── setReadOnly keeps high/treb aliases coherent ─────────────
    {
        const ctx = new FrameContext();
        ctx.setReadOnly({ high: 0.42 });
        assert(ctx.high === 0.42, 'high set via setReadOnly');
        assert(ctx.treb === 0.42, 'treb mirrors high when treb omitted');
    }

    // ── applyBaseVals sets defaults from preset ───────────────────
    {
        const ctx = new FrameContext();
        ctx.applyBaseVals({
            zoom: 1.05,
            rot: 0.02,
            decay: 0.97,
            warp: 1.42,
            wave_mode: 2,
            wave_a: 3.5,
        });
        assert(ctx.zoom === 1.05, 'baseVals sets zoom');
        assert(ctx.rot === 0.02, 'baseVals sets rot');
        assert(ctx.decay === 0.97, 'baseVals sets decay');
        assert(ctx.warp === 1.42, 'baseVals sets warp');
        assert(ctx.wave_mode === 2, 'baseVals sets wave_mode');
        assert(ctx.wave_a === 3.5, 'baseVals sets wave_a');
    }

    // ── resetPerFrame restores base values but keeps q-vars ───────
    {
        const ctx = new FrameContext();
        ctx.applyBaseVals({ zoom: 1.05, rot: 0.02 });
        ctx.q1 = 10;
        ctx.zoom = 99;
        ctx.rot = 99;
        ctx.resetPerFrame();
        assert(ctx.zoom === 1.05, 'resetPerFrame restores zoom to base');
        assert(ctx.rot === 0.02, 'resetPerFrame restores rot to base');
        assert(ctx.q1 === 10, 'resetPerFrame preserves q1');
    }

    // ── Q variables persist across resetPerFrame ──────────────────
    {
        const ctx = new FrameContext();
        ctx.q5 = 42;
        ctx.resetPerFrame();
        assert(ctx.q5 === 42, 'q5 persists across resetPerFrame');
    }

    // ── T variables reset when resetTVars is called ───────────────
    {
        const ctx = new FrameContext();
        ctx.t1 = 100;
        ctx.t8 = 200;
        ctx.resetTVars();
        assert(ctx.t1 === 0, 't1 reset by resetTVars');
        assert(ctx.t8 === 0, 't8 reset by resetTVars');
    }

    // ── snapshot / restore for blend transitions ──────────────────
    {
        const ctx = new FrameContext();
        ctx.zoom = 2.0;
        ctx.q1 = 7;
        const snap = ctx.snapshot();
        ctx.zoom = 99;
        ctx.q1 = 99;
        ctx.restore(snap);
        assert(ctx.zoom === 2.0, 'restore brings back zoom');
        assert(ctx.q1 === 7, 'restore brings back q1');
    }

    // ── Context works as plain object for compiler ────────────────
    // The compiler accesses ctx[name], so context must look like plain object
    {
        const ctx = new FrameContext();
        ctx.zoom = 1.0;
        ctx['zoom'] = 2.0;
        assert(ctx.zoom === 2.0, 'bracket access works');
        assert(ctx['zoom'] === 2.0, 'bracket read works');
    }

    // ── rand_start / rand_preset are stable arrays ────────────────
    {
        const ctx = new FrameContext();
        assert(Array.isArray(ctx._rand_start), '_rand_start is array');
        assert(ctx._rand_start.length === 4, '_rand_start has 4 elements');
        assert(typeof ctx.rand_start.x === 'number', 'rand_start.x is number');
    }
}
