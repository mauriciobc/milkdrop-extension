/**
 * End-to-end benchmark: launches the renderer in --benchmark mode,
 * feeds synthetic frames via IPC, and collects timing stats.
 *
 * Usage: gjs -m tests/bench/e2e.js [--frames N] [--width W] [--height H]
 *
 * Requires the GL helper binary to be built (meson build).
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ARGV_RAW = imports.system?.programArgs ?? ARGV ?? [];

function parseFlag(flag, fallback) {
    const idx = ARGV_RAW.indexOf(flag);
    if (idx < 0 || idx + 1 >= ARGV_RAW.length)
        return fallback;
    const val = Number(ARGV_RAW[idx + 1]);
    return Number.isFinite(val) && val > 0 ? val : fallback;
}

const frames = parseFlag('--frames', 300);
const width = parseFlag('--width', 1280);
const height = parseFlag('--height', 720);

function findRendererPath() {
    const moduleFile = Gio.File.new_for_uri(import.meta.url);
    const repoRoot = moduleFile.get_parent().get_parent().get_path();
    return GLib.build_filenamev([repoRoot, 'src', 'renderer', 'renderer.js']);
}

function main() {
    const rendererPath = findRendererPath();
    if (!Gio.File.new_for_path(rendererPath).query_exists(null)) {
        printerr(`Renderer not found at ${rendererPath}`);
        imports.system.exit(1);
    }

    print(`Milkdrop E2E Benchmark`);
    print(`  renderer: ${rendererPath}`);
    print(`  resolution: ${width}x${height}, frames: ${frames}`);
    print('');

    const argv = [
        'gjs', '-m', rendererPath,
        '--benchmark',
        '--benchmark-frames', `${frames}`,
        '--standalone',
        '--width', `${width}`,
        '--height', `${height}`,
    ];

    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    });

    let proc;
    try {
        proc = launcher.spawnv(argv);
    } catch (e) {
        printerr(`Failed to launch renderer: ${e.message}`);
        imports.system.exit(1);
    }

    const [, stdout] = proc.communicate_utf8(null, null);

    if (stdout)
        print(stdout);

    const exitOk = proc.get_exit_status() === 0;
    if (!exitOk)
        printerr(`Renderer exited with code ${proc.get_exit_status()}`);

    imports.system.exit(exitOk ? 0 : 1);
}

main();
