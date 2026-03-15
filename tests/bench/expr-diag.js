import { compile } from '../../src/extension/expr/compiler.js';

const frameFn = compile('zoom = 1.0 + 0.06 * sin(time * 0.8); rot = 0.03 * sin(time * 0.4); decay = 0.95 + 0.03 * sin(time * 0.3); dx = 0.01 * sin(time * 0.5); dy = 0.01 * cos(time * 0.7);');

const ctx = { zoom: 1.0, rot: 0.0, dx: 0.0, dy: 0.0, decay: 0.97, time: 0, frame: 0, fps: 60, bass: 0.5, mid: 0.4 };

for (let i = 0; i < 5; i++) {
    ctx.time = i * 0.5;
    ctx.zoom = 1.0; ctx.rot = 0.0; ctx.dx = 0.0; ctx.dy = 0.0; ctx.decay = 0.97;
    frameFn(ctx);
    print(`t=${ctx.time.toFixed(1)} zoom=${ctx.zoom.toFixed(4)} rot=${ctx.rot.toFixed(4)} dx=${ctx.dx.toFixed(4)} dy=${ctx.dy.toFixed(4)} decay=${ctx.decay.toFixed(4)}`);
}
print('Expression engine: OK');
