/**
 * Benchmark runner for gnome-milkdrop.
 * Run from repo root: gjs -m tests/bench/run.js [--json] [--iterations N] [--warmup N]
 *
 * Each benchmark module exports run(bench), where bench(name, fn, opts) runs
 * fn for N iterations, records wall time via GLib.get_monotonic_time(), and
 * reports min/median/p95/max in microseconds.
 */
import GLib from 'gi://GLib';

const ARGV = imports.system?.programArgs ?? ARGV ?? [];

function parseFlag(flag, fallback) {
    const idx = ARGV.indexOf(flag);
    if (idx < 0 || idx + 1 >= ARGV.length)
        return fallback;
    const val = Number(ARGV[idx + 1]);
    return Number.isFinite(val) && val > 0 ? val : fallback;
}

const jsonOutput = ARGV.includes('--json');
const defaultIterations = parseFlag('--iterations', 10000);
const defaultWarmup = parseFlag('--warmup', 100);

const results = [];

function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.ceil(p / 100 * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function bench(name, fn, opts = {}) {
    const iterations = opts.iterations ?? defaultIterations;
    const warmup = opts.warmup ?? defaultWarmup;

    // Warmup
    for (let i = 0; i < warmup; i++)
        fn();

    // Measure
    const times = new Float64Array(iterations);
    for (let i = 0; i < iterations; i++) {
        const start = GLib.get_monotonic_time();
        fn();
        times[i] = GLib.get_monotonic_time() - start;
    }

    // Sort for percentiles
    times.sort();

    const min = times[0];
    const max = times[times.length - 1];
    const median = percentile(times, 50);
    const p95 = percentile(times, 95);
    const p99 = percentile(times, 99);
    let sum = 0;
    for (let i = 0; i < times.length; i++)
        sum += times[i];
    const mean = sum / times.length;

    const result = {name, iterations, min, median, mean, p95, p99, max};
    results.push(result);

    if (!jsonOutput) {
        const pad = (s, w) => String(s).padStart(w);
        print(`  ${name.padEnd(40)} ${pad(min.toFixed(1), 10)} ${pad(median.toFixed(1), 10)} ${pad(mean.toFixed(1), 10)} ${pad(p95.toFixed(1), 10)} ${pad(p99.toFixed(1), 10)} ${pad(max.toFixed(1), 10)}  (${iterations} iter)`);
    }
}

async function main() {
    if (!jsonOutput) {
        print('Milkdrop Benchmarks');
        print('='.repeat(80));
        print(`  ${'Benchmark'.padEnd(40)} ${'min(µs)'.padStart(10)} ${'med(µs)'.padStart(10)} ${'avg(µs)'.padStart(10)} ${'p95(µs)'.padStart(10)} ${'p99(µs)'.padStart(10)} ${'max(µs)'.padStart(10)}`);
        print('-'.repeat(130));
    }

    const runBench = async (name, modulePath) => {
        try {
            const mod = await import(modulePath);
            if (typeof mod.run === 'function') {
                const maybePromise = mod.run(bench);
                if (maybePromise && typeof maybePromise.then === 'function')
                    await maybePromise;
            } else {
                print(`SKIP: ${name}: module has no run(bench) export`);
            }
        } catch (e) {
            print(`ERROR: ${name}: ${e.message}`);
            if (e.stack)
                printerr(e.stack);
        }
    };

    await runBench('evaluator', './evaluator.bench.js');
    await runBench('audio', './audio.bench.js');
    await runBench('ipc-serialization', './ipc.bench.js');
    await runBench('presets', './presets.bench.js');

    if (jsonOutput) {
        print(JSON.stringify({benchmarks: results, timestamp: new Date().toISOString()}, null, 2));
    } else {
        print('-'.repeat(130));
        print(`\n${results.length} benchmark(s) completed.`);
    }
}

main().catch(e => {
    printerr(e.message);
    if (e.stack)
        printerr(e.stack);
    imports.system.exit(1);
});
