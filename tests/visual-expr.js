#!/usr/bin/env gjs -m
/**
 * Visual test for the MilkDrop expression engine.
 *
 * Opens a GTK4 window and drives the renderer with expression-evaluated
 * frames so you can visually confirm the output.
 *
 * Usage:
 *   gjs -m tests/visual-expr.js
 *   gjs -m tests/visual-expr.js --preset 1    # pick preset 0-2
 *   gjs -m tests/visual-expr.js --width 800 --height 600
 *   gjs -m tests/visual-expr.js --signoff --signoff-out ./phase3-signoff.jsonl
 *   gjs -m tests/visual-expr.js --signoff --auto-exit-seconds 20
 */

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';

import { MilkdropGLArea } from '../src/renderer/glarea.js';
import { compile } from '../src/extension/expr/compiler.js';

// ── Expression-based presets ─────────────────────────────────────────

const PRESETS = [
    {
        name: 'Breathing Zoom',
        description: 'Slow pulsating zoom with rotation',
        baseVals: { zoom: 1.0, rot: 0.0, dx: 0.0, dy: 0.0, decay: 0.97 },
        init_eqs: 'q1 = 0; q2 = 0;',
        frame_eqs: [
            'zoom = 1.0 + 0.06 * sin(time * 0.8);',
            'rot = 0.03 * sin(time * 0.4);',
            'decay = 0.95 + 0.03 * sin(time * 0.3);',
            'dx = 0.01 * sin(time * 0.5);',
            'dy = 0.01 * cos(time * 0.7);',
        ].join(' '),
    },
    {
        name: 'Bass Reactor',
        description: 'Audio-reactive zoom & rotation driven by bass',
        baseVals: { zoom: 1.0, rot: 0.0, dx: 0.0, dy: 0.0, decay: 0.96 },
        init_eqs: 'q1 = 0;',
        frame_eqs: [
            'zoom = 1.0 + 0.08 * bass + 0.02 * sin(time * 1.2);',
            'rot = 0.02 * mid + 0.01 * sin(time * 0.5);',
            'decay = 0.93 + 0.05 * (1.0 - energy);',
            'dx = 0.015 * sin(time * 0.9) * bass;',
            'dy = 0.01 * cos(time * 0.6) * mid;',
            'q1 = q1 + 0.01;',
        ].join(' '),
    },
    {
        name: 'Spiral Drift',
        description: 'Smooth spiraling with time-varying warp',
        baseVals: { zoom: 1.0, rot: 0.0, dx: 0.0, dy: 0.0, decay: 0.98 },
        init_eqs: 'q1 = 0; q2 = 1;',
        frame_eqs: [
            'q1 = q1 + 0.005;',
            'zoom = 1.02 + 0.03 * sin(q1 * 3.0);',
            'rot = 0.05 + 0.03 * cos(time * 0.2);',
            'dx = 0.008 * sin(time * 0.4 + q1);',
            'dy = 0.008 * cos(time * 0.3 + q1);',
            'decay = 0.965 + 0.015 * sin(time * 0.15);',
        ].join(' '),
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
        if (argv[i] === '--width' && argv[i + 1])  opts.width = parseInt(argv[++i], 10);
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
        script: 'visual-expr',
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

// ── Main ─────────────────────────────────────────────────────────────

const opts = parseArgs(ARGV ?? []);
const preset = PRESETS[opts.preset];

print(`\n  MilkDrop Expression Engine — Visual Test`);
print(`  ─────────────────────────────────────────`);
print(`  Preset ${opts.preset}: "${preset.name}"`);
print(`  ${preset.description}`);
print(`  Resolution: ${opts.width}×${opts.height}`);
if (opts.signoff)
    print('  Press P=PASS, F=FAIL, Q/Escape=abort for manual sign-off.\n');
else
    print(`  Press Ctrl+C or close the window to exit.\n`);

// Compile expressions once
const initFn = compile(preset.init_eqs);
const frameFn = compile(preset.frame_eqs);

// Expression context (persists across frames — q vars accumulate)
const ctx = { ...preset.baseVals };

// Run init equations once
initFn(ctx);

const app = new Gtk.Application({ application_id: 'io.github.milkdrop.ExprVisualTest' });

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: `MilkDrop Expr Test — ${preset.name}`,
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
                print('  GL helper ready, rendering...');
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

    // Simulated audio that gently pulses (no real audio capture needed)
    function fakeAudio(t) {
        return {
            source: 'visual-test',
            active: true,
            energy: 0.4 + 0.3 * Math.sin(t * 1.1),
            bass:   0.3 + 0.4 * Math.abs(Math.sin(t * 0.7)),
            mid:    0.3 + 0.3 * Math.abs(Math.sin(t * 1.3)),
            high:   0.2 + 0.2 * Math.abs(Math.sin(t * 2.1)),
            beat:   Math.sin(t * 2.5) > 0.95 ? 1 : 0,
            decay:  0.4,
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

        // Seed expression context with per-frame read-only variables
        ctx.time = t;
        ctx.frame = frameCounter;
        ctx.fps = 60;
        ctx.bass = audio.bass;
        ctx.mid = audio.mid;
        ctx.treb = audio.high;
        ctx.bass_att = audio.bass * 0.7;
        ctx.mid_att = audio.mid * 0.7;
        ctx.treb_att = audio.high * 0.7;
        ctx.energy = audio.energy;

        // Reset per-frame read-write to base defaults before expression runs
        ctx.zoom = preset.baseVals.zoom;
        ctx.rot = preset.baseVals.rot;
        ctx.dx = preset.baseVals.dx;
        ctx.dy = preset.baseVals.dy;
        ctx.decay = preset.baseVals.decay;

        // Run per-frame expressions
        frameFn(ctx);

        // Build frame state for the renderer
        glArea.setFrameState({
            frame: frameCounter,
            t,
            zoom:  ctx.zoom,
            rot:   ctx.rot,
            dx:    ctx.dx,
            dy:    ctx.dy,
            decay: ctx.decay,
            presetId: `expr:${preset.name.toLowerCase().replace(/\s+/g, '-')}`,
            presetName: preset.name,
            blendProgress: 1,
            audio,
            uniforms: {
                time: t,
                zoom:  ctx.zoom,
                rot:   ctx.rot,
                dx:    ctx.dx,
                dy:    ctx.dy,
                decay: ctx.decay,
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
