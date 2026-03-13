import {PresetStore} from '../../src/extension/presets.js';

export async function run(assert) {
    const store = new PresetStore();

    {
        const index = await store.loadIndex();
        const ids = new Set(index.map(entry => entry.id));
        const expected = [
            'builtin:demo-wave',
            'builtin:angular-drift',
            'builtin:wave-pool',
            'builtin:fractal-bloom',
            'builtin:hypnotic-tunnel',
            'builtin:particle-comet',
            'builtin:supernova-kick',
            'builtin:waveform-lattice',
        ];

        for (const id of expected)
            assert(ids.has(id), `loadIndex includes ${id}`);
    }

    {
        const first = await store.loadPreset('builtin:supernova-kick');
        first.frame.zoom.base = 999;
        const second = await store.loadPreset('builtin:supernova-kick');
        assert(second.frame.zoom.base !== 999, 'loadPreset returns a clone and does not leak mutations');
    }

    {
        const preset = await store.loadPreset('builtin:hypnotic-tunnel');
        assert(preset.shaders && typeof preset.shaders.draw === 'string', 'hypnotic tunnel exposes draw shader');
        assert(preset.shaders && typeof preset.shaders.composite === 'string', 'hypnotic tunnel exposes composite shader');
    }

    {
        let threw = false;
        try {
            await store.loadPreset('builtin:missing-id');
        } catch (_error) {
            threw = true;
        }
        assert(threw, 'loadPreset throws on unknown preset id');
    }
}
