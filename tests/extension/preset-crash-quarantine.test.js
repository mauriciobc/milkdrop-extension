import {PresetCrashQuarantine} from '../../src/extension/preset-crash-quarantine.js';

export async function run(assert) {
    const q = new PresetCrashQuarantine({cooldownMs: 1000});
    const id = 'file:/tmp/preset1.milk';

    assert(!q.isBlacklisted(id, 0), 'not blacklisted before any crash');

    q.recordCrash(id, 1000);
    assert(q.isBlacklisted(id, 1000), 'blacklisted at crash time');
    assert(q.isBlacklisted(id, 1500), 'blacklisted during cooldown window');
    assert(!q.isBlacklisted(id, 2501), 'not blacklisted after cooldown expires');

    const entries = [
        {id, name: 'a', source: 'file'},
        {id: 'file:/tmp/preset2.milk', name: 'b', source: 'file'},
        {id: null, name: 'c', source: 'file'},
    ];

    q.recordCrash('file:/tmp/preset2.milk', 0);
    const filtered = q.filterEligible(entries, 0);
    assert(filtered.length === 1, 'filterEligible removes blacklisted entries and ignores invalid ones');
    assert(filtered[0]?.id === id, 'filterEligible keeps only non-blacklisted entries');

    // Basic input validation
    assert(!q.recordCrash(null, 0), 'recordCrash ignores invalid presetId');
}

