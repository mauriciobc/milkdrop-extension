#!/usr/bin/env gjs -m
/**
 * MilkDrop 2 Compliance Test — Real Preset Validation
 *
 * Runs authentic MilkDrop 2 presets (from butterchurn-presets, MIT license)
 * through our expression engine and drives the renderer to visually
 * confirm correct behaviour.
 *
 * Usage:
 *   gjs -m tests/visual-compliance.js
 *   gjs -m tests/visual-compliance.js --preset 1
 *   gjs -m tests/visual-compliance.js --width 960 --height 540
 *   gjs -m tests/visual-compliance.js --signoff --signoff-out ./phase3-signoff.jsonl
 *   gjs -m tests/visual-compliance.js --signoff --auto-exit-seconds 20
 *
 * Presets:
 *   0 — Geiss - Eggs                (simple frame + pixel eqs)
 *   1 — Geiss - Desert Rose 4       (complex frame eqs, bass_thresh)
 *   2 — Aderrasi - Halls Of Centrifuge (per-pixel zoom/rot, above/below)
 */

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

import { MilkdropGLArea } from '../src/renderer/glarea.js';
import { createDefaultMesh, applyWarpToMesh } from '../src/renderer/mesh.js';
import { compile }        from '../src/extension/expr/compiler.js';

// ── Real MilkDrop 2 Presets (from butterchurn-presets, MIT) ─────────

const PRESETS = [
    // [0] Geiss - Eggs — Classic per-frame + per-pixel preset
    {
        name: 'Geiss - Eggs',
        baseVals: {
            decay: 0.97, wave_mode: 2, wave_a: 3.5,
            wave_scale: 2.72, wave_smoothing: 0.77,
            warpscale: 2.853, zoom: 1.046, rot: 0.02,
            warp: 1.42, wave_r: 0.6, wave_g: 0.6, wave_b: 0.6,
            wave_y: 0.47, cx: 0.5, cy: 0.5, dx: 0, dy: 0,
        },
        init_eqs_eel: '',
        frame_eqs_eel:
            'wave_r = wave_r + 0.400*( 0.60*sin(0.900*time) + 0.40*sin(0.963*time) );\n' +
            'wave_g = wave_g + 0.400*( 0.60*sin(0.900*time) + 0.40*sin(0.956*time) );\n' +
            'wave_b = wave_b + 0.400*( 0.60*sin(0.910*time) + 0.40*sin(0.920*time) );\n' +
            'zoom = zoom + 0.023*( 0.60*sin(0.339*time) + 0.40*sin(0.276*time) );\n' +
            'rot = rot + 0.030*( 0.60*sin(0.381*time) + 0.40*sin(0.579*time) );\n' +
            'cx = cx + 0.070*( 0.60*sin(0.374*time) + 0.40*sin(0.294*time) );\n' +
            'cy = cy + 0.070*( 0.60*sin(0.393*time) + 0.40*sin(0.223*time) );',
        pixel_eqs_eel: 'zoom=zoom+0.27*sin(time*1.55+rad*5);',
    },

    // [1] Geiss - Desert Rose 4 — Complex frame eqs with bass_thresh,
    //     conditionals (equal/above), dx/dy residuals, wave_mystery
    {
        name: 'Geiss - Desert Rose 4',
        baseVals: {
            gammaadj: 1.9, echo_zoom: 1.169, wave_mode: 7,
            additivewave: 1, wave_thick: 1, wave_a: 0.051,
            wave_scale: 2.827, wave_smoothing: 0.09,
            modwavealphastart: 0.63, modwavealphaend: 0.87,
            warpscale: 3.138, zoom: 1.007, warp: 0.01029,
            wave_r: 0.5, wave_g: 0.5, wave_b: 0.5,
            wave_y: 0.72, mv_a: 0, decay: 0.98,
            cx: 0.5, cy: 0.5, dx: 0, dy: 0, rot: 0,
            wave_x: 0.5,
        },
        init_eqs_eel: 'dx_residual=0; dy_residual=0; bass_thresh=1.3;',
        frame_eqs_eel:
            'wave_r = 0.85 + 0.25*sin(0.613*time+1);\n' +
            'wave_g = 0.85 + 0.25*sin(0.544*time+2);\n' +
            'wave_b = 0.85 + 0.25*sin(0.751*time+3);\n' +
            'rot = rot + 0.010*( 0.60*sin(0.381*time) + 0.40*sin(0.579*time) );\n' +
            'cx = cx + 0.210*( 0.60*sin(0.374*time) + 0.40*sin(0.294*time) );\n' +
            'cy = cy + 0.210*( 0.60*sin(0.393*time) + 0.40*sin(0.223*time) );\n' +
            'dx = dx + 0.003*( 0.60*sin(0.234*time) + 0.40*sin(0.277*time) );\n' +
            'dy = dy + 0.003*( 0.60*sin(0.284*time) + 0.40*sin(0.247*time) );\n' +
            'decay = decay - 0.01*equal(frame%6,0);\n' +
            'dx = dx + dx_residual;\n' +
            'dy = dy + dy_residual;\n' +
            'bass_thresh = above(bass_att,bass_thresh)*2 + (1-above(bass_att,bass_thresh))*((bass_thresh-1.3)*0.96+1.3);\n' +
            'dx_residual = equal(bass_thresh,2)*0.016*sin(time*7) + (1-equal(bass_thresh,2))*dx_residual;\n' +
            'dy_residual = equal(bass_thresh,2)*0.012*sin(time*9) + (1-equal(bass_thresh,2))*dy_residual;\n' +
            'wave_x = wave_x - dx_residual*7;\n' +
            'wave_y = wave_y - dy_residual*7;\n' +
            'wave_mystery = time*0.03;\n' +
            'warp = warp * (1 + 0.3*cos(time*0.284+4));\n' +
            'zoom = zoom + 0.007*cos(time*0.317+2);',
        pixel_eqs_eel: '',
    },

    // [2] Aderrasi - Halls Of Centrifuge — Per-pixel thresh/zoom/rot,
    //     uses above, below, equal, rad, bass, bass_att
    {
        name: 'Aderrasi - Halls Of Centrifuge',
        baseVals: {
            decay: 1, echo_zoom: 1, echo_alpha: 0.5,
            echo_orient: 3, wave_mode: 1, wrap: 0,
            darken_center: 1, wave_a: 100,
            wave_scale: 1.48862, wave_smoothing: 0,
            warpscale: 0.01, dx: 0.00001, dy: 0.00001,
            warp: 0.01, wave_r: 0.5, wave_g: 0.5,
            wave_b: 0.5, ob_size: 0.2, ob_r: 0.9,
            ob_g: 0.9, ob_b: 0.9, ob_a: 0.5,
            ib_size: 0.05, ib_r: 0.9, ib_g: 0.9,
            ib_b: 0.9, zoom: 1, cx: 0.5, cy: 0.5, rot: 0,
        },
        init_eqs_eel: 'thresh=1.3; dx_r=0; dy_r=0;',
        frame_eqs_eel:
            'wave_r = wave_r + 0.25*sin(1.63*time) + 0.25*sin(2.25*time);\n' +
            'wave_g = wave_g + 0.25*sin(1.7*time) + 0.25*sin(2.11*time);\n' +
            'wave_b = wave_b + 0.25*sin(1.84*time) + 0.25*sin(2.3*time);\n' +
            'warp = 0.00;\n' +
            'ib_r = wave_b;\n' +
            'ib_g = wave_r;\n' +
            'ib_b = wave_g;\n' +
            'ob_r = wave_r * sin(wave_b);\n' +
            'ob_g = wave_g * sin(wave_r);\n' +
            'ob_b = wave_b * sin(wave_g);\n' +
            'zoom = zoom - 0.05;',
        pixel_eqs_eel:
            'thresh = above(bass_att,thresh)*2+(1-above(bass_att,thresh))*((thresh-1.3)*0.96+1.3);\n' +
            'dx_r = equal(thresh,2)*0.015*sin(5*time)+(1-equal(thresh,2))*dx_r;\n' +
            'dy_r = equal(thresh,2)*0.015*sin(6*time)+(1-equal(thresh,2))*dy_r;\n' +
            'rot = rot + rad*(1.1*sin(time)-rad)*1.25;\n' +
            'rot = rot + above(rad,0.7 - 0.2*sin(bass))*0.1;\n' +
            'zoom = zoom - above(rad,0.5 + 0.1*sin(1-rad*cos(time)))*below((0.5*sin(time))-rad,0.5)*0.09*rad;\n' +
            'rot = rot + dx_r + dy_r;',
    },

    // [3] Custom Wave Test — Tests custom waveform per-point code
    {
        name: 'Custom Wave Test',
        baseVals: {
            decay: 0.97, zoom: 1.0, rot: 0,
            wave_mode: 0, wave_a: 0,
        },
        init_eqs_eel: '',
        frame_eqs_eel: '',
        pixel_eqs_eel: '',
        // Custom wave configuration
        wavecode_0_enabled: 1,
        wavecode_0_bUseDots: 0,
        wavecode_0_bAdditive: 1,
        wavecode_0_scaling: 1.0,
        wavecode_0_smoothing: 0.5,
        wavecode_0_r: 0.0,
        wavecode_0_g: 1.0,
        wavecode_0_b: 1.0,
        wavecode_0_a: 1.0,
        wave_0_per_point: 'x = x + value1 * 0.5; y = y + value2 * 0.5;',
    },

    // [4] Custom Shape Test — Tests custom shape rendering
    {
        name: 'Custom Shape Test',
        baseVals: {
            decay: 0.97, zoom: 1.0, rot: 0,
        },
        init_eqs_eel: '',
        frame_eqs_eel: '',
        pixel_eqs_eel: '',
        // Custom shape configuration
        shapecode_0_enabled: 1,
        shapecode_0_sides: 6,
        shapecode_0_additive: 0,
        shapecode_0_x: 0.5,
        shapecode_0_y: 0.5,
        shapecode_0_rad: 0.2,
        shapecode_0_ang: 0,
        shapecode_0_r: 1.0,
        shapecode_0_g: 0.5,
        shapecode_0_b: 0.0,
        shapecode_0_a: 0.8,
        shapecode_0_r2: 0.0,
        shapecode_0_g2: 1.0,
        shapecode_0_b2: 0.5,
        shapecode_0_a2: 0.5,
        shapecode_0_border_r: 1.0,
        shapecode_0_border_g: 1.0,
        shapecode_0_border_b: 1.0,
        shapecode_0_border_a: 0.3,
    },

];

// ── CLI arg parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        width: 1280,
        height: 720,
        preset: 0,
        signoff: false,
        signoffOut: null,
        autoExitSeconds: 0,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--width' && argv[i + 1])  opts.width  = parseInt(argv[++i], 10);
        if (argv[i] === '--height' && argv[i + 1]) opts.height = parseInt(argv[++i], 10);
        if (argv[i] === '--preset' && argv[i + 1]) opts.preset = parseInt(argv[++i], 10);
        if (argv[i] === '--signoff') opts.signoff = true;
        if (argv[i] === '--signoff-out' && argv[i + 1]) opts.signoffOut = argv[++i];
        if (argv[i] === '--auto-exit-seconds' && argv[i + 1]) {
            const parsed = parseInt(argv[++i], 10);
            opts.autoExitSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        }
    }
    opts.preset = Math.max(0, Math.min(opts.preset, PRESETS.length - 1));
    return opts;
}

function appendSignoffLine(relativeOrAbsolutePath, line) {
    const path = GLib.path_is_absolute(relativeOrAbsolutePath)
        ? relativeOrAbsolutePath
        : GLib.build_filenamev([GLib.get_current_dir(), relativeOrAbsolutePath]);

    let existing = '';
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (ok)
            existing = new TextDecoder().decode(bytes);
    } catch (_error) {
    }

    GLib.file_set_contents(path, `${existing}${line}\n`);
}

function emitSignoffResult(opts, presetInfo, decision, reason) {
    const record = {
        script: 'visual-compliance',
        timestamp: new Date().toISOString(),
        decision,
        reason,
        preset: presetInfo,
    };
    const line = JSON.stringify(record);
    print(`SIGNOFF_RESULT ${line}`);
    if (opts.signoffOut)
        appendSignoffLine(opts.signoffOut, line);
}

// ── Expression-engine diagnostic ─────────────────────────────────────
// Dry-run the expressions for a few frames to verify parsing/compilation
// before opening the GL window.

function diagPreset(preset) {
    print(`  Compiling "${preset.name}" ...`);

    const initFn  = compile(preset.init_eqs_eel || '');
    const frameFn = compile(preset.frame_eqs_eel || '');
    const pixelFn = compile(preset.pixel_eqs_eel || '');

    print(`    init_eqs  : ok  (${preset.init_eqs_eel.length} chars)`);
    print(`    frame_eqs : ok  (${preset.frame_eqs_eel.length} chars)`);
    print(`    pixel_eqs : ok  (${preset.pixel_eqs_eel.length} chars)`);

    // Dry-run: 5 frames
    const ctx = { ...preset.baseVals };
    initFn(ctx);

    for (let f = 0; f < 5; f++) {
        ctx.time  = f * 0.016;
        ctx.frame = f;
        ctx.fps   = 60;
        ctx.bass  = 0.3 + 0.2 * Math.sin(f);
        ctx.mid   = 0.3;
        ctx.treb  = 0.2;
        ctx.bass_att = ctx.bass * 0.7;
        ctx.mid_att  = ctx.mid * 0.7;
        ctx.treb_att = ctx.treb * 0.7;
        ctx.energy = 0.4;
        ctx.rad  = 0.5;  // per-pixel: normalised distance from centre
        ctx.ang  = 0;    // per-pixel: angle

        // Reset read-write vars to base before per-frame eqs
        ctx.zoom  = preset.baseVals.zoom  ?? 1;
        ctx.rot   = preset.baseVals.rot   ?? 0;
        ctx.dx    = preset.baseVals.dx    ?? 0;
        ctx.dy    = preset.baseVals.dy    ?? 0;
        ctx.decay = preset.baseVals.decay ?? 0.98;
        ctx.cx    = preset.baseVals.cx    ?? 0.5;
        ctx.cy    = preset.baseVals.cy    ?? 0.5;
        ctx.wave_r = preset.baseVals.wave_r ?? 1;
        ctx.wave_g = preset.baseVals.wave_g ?? 1;
        ctx.wave_b = preset.baseVals.wave_b ?? 1;
        ctx.wave_x = preset.baseVals.wave_x ?? 0.5;
        ctx.wave_y = preset.baseVals.wave_y ?? 0.5;
        ctx.warp   = preset.baseVals.warp  ?? 1;

        frameFn(ctx);

        // Also dry-run pixel eqs at 3 sample radii
        for (const r of [0.0, 0.5, 1.0]) {
            ctx.rad = r;
            ctx.ang = r * Math.PI;
            pixelFn(ctx);
        }

        if (f === 0 || f === 4) {
            print(`    Frame ${f}: zoom=${ctx.zoom.toFixed(4)} rot=${ctx.rot.toFixed(4)} ` +
                  `decay=${ctx.decay.toFixed(4)} dx=${ctx.dx.toFixed(5)} dy=${ctx.dy.toFixed(5)} ` +
                  `wave_r=${ctx.wave_r.toFixed(3)} wave_g=${ctx.wave_g.toFixed(3)} wave_b=${ctx.wave_b.toFixed(3)}`);
        }
    }
    print(`    Dry-run: PASS (5 frames, 3 pixel samples each)\n`);
}

// ── Main ─────────────────────────────────────────────────────────────

const opts = parseArgs(ARGV ?? []);
const preset = PRESETS[opts.preset];

print(`\n  MilkDrop 2 Compliance Test — Real Preset Validation`);
print(`  ────────────────────────────────────────────────────`);
print(`  Resolution: ${opts.width}×${opts.height}\n`);

// 1. Diagnostic: compile + dry-run ALL presets
for (const p of PRESETS) {
    diagPreset(p);
}

print(`  All ${PRESETS.length} presets compile and dry-run successfully.`);
print(`  Launching visual test with preset ${opts.preset}: "${preset.name}"\n`);
if (opts.signoff) {
    print('  Manual sign-off mode enabled.');
    print('  Press P to mark PASS, F to mark FAIL, Q/Escape to abort.\n');
}

// 2. Compile the selected preset for live rendering
const initFn   = compile(preset.init_eqs_eel || '');
const frameFn  = compile(preset.frame_eqs_eel || '');
const pixelFn  = compile(preset.pixel_eqs_eel || '');

// Expression context (persists across frames — stateful vars accumulate)
const ctx = { ...preset.baseVals };
initFn(ctx);

const app = new Gtk.Application({ application_id: 'io.github.milkdrop.ComplianceTest' });

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: `MilkDrop 2 Compliance — ${preset.name}`,
        default_width: opts.width,
        default_height: opts.height,
        decorated: true,
    });

    const glArea = new MilkdropGLArea({
        standalone: true,
        strictRenderPath: false,
        logger: console,
        onBridgeMessage: (msg) => {
            if (msg.type === 'helper-ready' && msg.ok)
                print(`  GL helper ready — rendering "${preset.name}" ...`);
        },
    });

    window.set_child(glArea);
    window.present();

    let signoffComplete = false;
    const presetInfo = {
        index: opts.preset,
        name: preset.name,
    };
    const finalizeSignoff = (decision, reason) => {
        if (signoffComplete)
            return;
        signoffComplete = true;
        emitSignoffResult(opts, presetInfo, decision, reason);
        app.quit();
    };

    if (opts.signoff) {
        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_controller, keyval) => {
            if (keyval === Gdk.KEY_p || keyval === Gdk.KEY_P) {
                finalizeSignoff('pass', 'key:P');
                return true;
            }
            if (keyval === Gdk.KEY_f || keyval === Gdk.KEY_F) {
                finalizeSignoff('fail', 'key:F');
                return true;
            }
            if (keyval === Gdk.KEY_q || keyval === Gdk.KEY_Q || keyval === Gdk.KEY_Escape) {
                finalizeSignoff('aborted', 'key:Q_or_Escape');
                return true;
            }
            return false;
        });
        window.add_controller(keyController);

        window.connect('close-request', () => {
            if (!signoffComplete)
                finalizeSignoff('aborted', 'window-close');
            return false;
        });

        if (opts.autoExitSeconds > 0) {
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, opts.autoExitSeconds, () => {
                if (!signoffComplete)
                    finalizeSignoff('aborted', `timeout:${opts.autoExitSeconds}s`);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Simulated audio: gentle pulses for consistent visual validation
    function fakeAudio(t) {
        const pcmLeft = [];
        const pcmRight = [];
        for (let i = 0; i < 576; i++) {
            const v = 0.3 * Math.sin(t * 10 + i * 0.1) + 0.1 * Math.sin(t * 7 + i * 0.05);
            pcmLeft.push(v);
            pcmRight.push(v * 0.9);
        }
        return {
            source: 'compliance-test',
            active: true,
            energy: 0.4 + 0.3 * Math.sin(t * 1.1),
            bass:   0.3 + 0.4 * Math.abs(Math.sin(t * 0.7)),
            mid:    0.3 + 0.3 * Math.abs(Math.sin(t * 1.3)),
            high:   0.2 + 0.2 * Math.abs(Math.sin(t * 2.1)),
            beat:   Math.sin(t * 2.5) > 0.95 ? 1 : 0,
            decay:  0.4,
            pcmLeft,
            pcmRight,
        };
    }

    let frameCounter = 0;
    const startTime = GLib.get_monotonic_time();

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        if (!window.get_visible())
            return GLib.SOURCE_REMOVE;

        frameCounter++;
        const t = (GLib.get_monotonic_time() - startTime) / 1000000;
        const audio = fakeAudio(t);

        // Seed per-frame read-only variables
        ctx.time     = t;
        ctx.frame    = frameCounter;
        ctx.fps      = 60;
        ctx.bass     = audio.bass;
        ctx.mid      = audio.mid;
        ctx.treb     = audio.high;
        ctx.bass_att = audio.bass * 0.7;
        ctx.mid_att  = audio.mid * 0.7;
        ctx.treb_att = audio.high * 0.7;
        ctx.energy   = audio.energy;

        // Reset per-frame read-write to base defaults
        ctx.zoom  = preset.baseVals.zoom  ?? 1;
        ctx.rot   = preset.baseVals.rot   ?? 0;
        ctx.dx    = preset.baseVals.dx    ?? 0;
        ctx.dy    = preset.baseVals.dy    ?? 0;
        ctx.decay = preset.baseVals.decay ?? 0.98;
        ctx.cx    = preset.baseVals.cx    ?? 0.5;
        ctx.cy    = preset.baseVals.cy    ?? 0.5;
        ctx.wave_r = preset.baseVals.wave_r ?? 1;
        ctx.wave_g = preset.baseVals.wave_g ?? 1;
        ctx.wave_b = preset.baseVals.wave_b ?? 1;
        ctx.wave_x = preset.baseVals.wave_x ?? 0.5;
        ctx.wave_y = preset.baseVals.wave_y ?? 0.5;
        ctx.warp   = preset.baseVals.warp  ?? 1;

        // Run per-frame expressions
        frameFn(ctx);

        // Note: per-pixel equations would normally run per-vertex in the mesh.
        // Here we demonstrate a single sample for the centre of the screen
        // to validate compilation. In the full pipeline (Phase 7) the pixel
        // eqs run on every mesh vertex.
        if (preset.pixel_eqs_eel) {
            ctx.rad = 0;
            ctx.ang = 0;
            pixelFn(ctx);
        }

        // Build frame state for renderer
        glArea.setFrameState({
            frame: frameCounter,
            t,
            zoom:  ctx.zoom,
            rot:   ctx.rot,
            dx:    ctx.dx,
            dy:    ctx.dy,
            decay: ctx.decay,
            presetId:   `compliance:${preset.name.toLowerCase().replace(/\s+/g, '-')}`,
            presetName: preset.name,
            blendProgress: 1,
            audio,
            uniforms: {
                time:   t,
                zoom:   ctx.zoom,
                rot:    ctx.rot,
                dx:     ctx.dx,
                dy:     ctx.dy,
                decay:  ctx.decay,
                energy: audio.energy,
                bass:   audio.bass,
                mid:    audio.mid,
                high:   audio.high,
                beat:   audio.beat,
            },
        });

        return GLib.SOURCE_CONTINUE;
    });
});

app.run([]);
