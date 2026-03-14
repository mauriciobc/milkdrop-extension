/**
 * Compare benchmark results against a baseline and flag regressions.
 *
 * Usage:
 *   gjs -m tests/bench/run.js -- --json > /tmp/current.json
 *   gjs -m tests/bench/check-regression.js /tmp/current.json [--threshold 10]
 *
 * Compares median times. Flags any benchmark where median increased
 * by more than threshold% (default 10%).
 */
import Gio from 'gi://Gio';

const ARGV_RAW = imports.system?.programArgs ?? ARGV ?? [];

function readJSON(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, contents] = file.load_contents(null);
    if (!ok)
        throw new Error(`Failed to read ${path}`);
    return JSON.parse(new TextDecoder().decode(contents));
}

function main() {
    const currentPath = ARGV_RAW[0];
    if (!currentPath) {
        printerr('Usage: gjs -m tests/bench/check-regression.js <current.json> [--threshold N]');
        imports.system.exit(1);
    }

    const thresholdIdx = ARGV_RAW.indexOf('--threshold');
    const threshold = thresholdIdx >= 0 && ARGV_RAW[thresholdIdx + 1]
        ? Number(ARGV_RAW[thresholdIdx + 1])
        : 10;

    // Load baseline from same directory
    const moduleFile = Gio.File.new_for_uri(import.meta.url);
    const baselinePath = moduleFile.get_parent().get_path() + '/baseline.json';

    let baseline;
    try {
        baseline = readJSON(baselinePath);
    } catch (e) {
        print(`No baseline found at ${baselinePath}. Run benchmarks with --json and save as baseline.json first.`);
        imports.system.exit(0);
    }

    if (!baseline.benchmarks || Object.keys(baseline.benchmarks).length === 0) {
        print('Baseline is empty. Run benchmarks and save results to establish a baseline:');
        print('  gjs -m tests/bench/run.js -- --json > tests/bench/baseline.json');
        imports.system.exit(0);
    }

    const current = readJSON(currentPath);
    const currentMap = {};
    for (const b of (current.benchmarks ?? []))
        currentMap[b.name] = b;

    let regressions = 0;
    let compared = 0;

    print(`Regression check (threshold: ${threshold}%)`);
    print('='.repeat(80));

    for (const [name, baselineData] of Object.entries(baseline.benchmarks)) {
        const curr = currentMap[name];
        if (!curr) {
            print(`  SKIP  ${name} (not in current run)`);
            continue;
        }

        compared++;
        const baseMedian = baselineData.median;
        const currMedian = curr.median;

        if (baseMedian === 0) {
            print(`  OK    ${name} (baseline median=0, current=${currMedian}µs)`);
            continue;
        }

        const pctChange = ((currMedian - baseMedian) / baseMedian) * 100;
        const status = pctChange > threshold ? 'REGR' : 'OK  ';

        if (pctChange > threshold)
            regressions++;

        const sign = pctChange >= 0 ? '+' : '';
        print(`  ${status}  ${name.padEnd(44)} ${String(baseMedian).padStart(6)} → ${String(currMedian).padStart(6)} µs (${sign}${pctChange.toFixed(1)}%)`);
    }

    print('='.repeat(80));
    print(`${compared} compared, ${regressions} regression(s) (>${threshold}% median increase)`);

    if (regressions > 0) {
        printerr(`\n${regressions} regression(s) detected!`);
        imports.system.exit(1);
    }
}

main();
