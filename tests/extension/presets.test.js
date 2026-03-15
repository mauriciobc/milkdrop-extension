import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PresetStore} from '../../src/extension/presets.js';

export async function run(assert) {
    const store = new PresetStore();

    {
        const index = await store.loadIndex();
        const ids = new Set(index.map(entry => entry.id));
        const expected = [
            'builtin:demo-wave',
            'builtin:test-geiss-eggs',
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
        const preset = await store.loadPreset('builtin:test-geiss-eggs');
        assert(preset.id === 'builtin:test-geiss-eggs', 'test-geiss-eggs preset has correct id');
        assert(typeof preset.frame_eqs === 'string' && preset.frame_eqs.length > 0,
            'test-geiss-eggs exposes frame_eqs for expression evaluation');
        assert(typeof preset.pixel_eqs === 'string' && preset.pixel_eqs.length > 0,
            'test-geiss-eggs exposes pixel_eqs for expression evaluation');
    }

    {
        const preset = await store.loadPreset('builtin:fractal-bloom');
        assert(preset.id === 'builtin:fractal-bloom', 'fractal-bloom preset has correct id');
        assert(!preset.shaders, 'fractal-bloom has no shaders configured');
    }

    {
        const preset = await store.loadPreset('builtin:particle-comet');
        assert(preset.id === 'builtin:particle-comet', 'particle-comet preset has correct id');
        assert(preset.shaders && typeof preset.shaders.draw === 'string', 'particle-comet is draw-only');
        assert(!preset.shaders.warp && !preset.shaders.composite, 'particle-comet has no warp/composite shader');
    }

    {
        const preset = await store.loadPreset('builtin:waveform-lattice');
        assert(preset.id === 'builtin:waveform-lattice', 'waveform-lattice preset has correct id');
        assert(preset.shaders && typeof preset.shaders.composite === 'string', 'waveform-lattice is composite-only');
        assert(!preset.shaders.draw && !preset.shaders.warp, 'waveform-lattice has no draw/warp shader');
    }

    {
        const preset = await store.loadPreset('builtin:supernova-kick');
        assert(preset.id === 'builtin:supernova-kick', 'supernova-kick preset has correct id');
        assert(preset.shaders && typeof preset.shaders.draw === 'string', 'supernova-kick is draw-only');
        assert(!preset.shaders.warp && !preset.shaders.composite, 'supernova-kick has no warp/composite shader');
    }

    {
        const first = await store.loadPreset('builtin:supernova-kick');
        first.frame.zoom.base = 999;
        const second = await store.loadPreset('builtin:supernova-kick');
        assert(second.frame.zoom.base !== 999, 'loadPreset returns a clone and does not leak mutations');
    }

    {
        const tempDir = GLib.dir_make_tmp('milkdrop-expr-presets-XXXXXX');
        const presetPath = GLib.build_filenamev([tempDir, 'expr-eel.json']);
        const exprPreset = {
            name: 'External Expr EEL',
            description: 'Expression preset loaded from file',
            baseVals: { zoom: 1.01, rot: 0.02 },
            init_eqs_eel: 'q1 = 1;',
            frame_eqs_eel: 'zoom = zoom + energy * 0.1;',
            pixel_eqs_eel: 'dx = rad * 0.01;',
        };

        GLib.file_set_contents(presetPath, JSON.stringify(exprPreset));

        const settings = {
            settings_schema: {
                has_key: key => key === 'preset-directory',
            },
            get_string: () => tempDir,
        };

        try {
            const externalStore = new PresetStore({settings});
            const loaded = await externalStore.loadPreset('file:expr-eel.json');
            assert(loaded.source === 'file', 'external expression preset keeps source=file');
            assert(loaded.init_eqs === 'q1 = 1;', 'external expression preset maps init_eqs_eel');
            assert(loaded.frame_eqs === 'zoom = zoom + energy * 0.1;', 'external expression preset maps frame_eqs_eel');
            assert(loaded.pixel_eqs === 'dx = rad * 0.01;', 'external expression preset maps pixel_eqs_eel');
            assert(loaded.baseVals.zoom === 1.01, 'external expression preset keeps baseVals');
            assert(loaded.vertex === null, 'external expression preset leaves vertex null when unspecified');
        } finally {
            const presetFile = Gio.File.new_for_path(presetPath);
            const dirFile = Gio.File.new_for_path(tempDir);
            try {
                presetFile.delete(null);
            } catch (_error) {
            }
            try {
                dirFile.delete(null);
            } catch (_error) {
            }
        }
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

    {
        let directory = '/tmp/first';
        const settings = {
            settings_schema: {
                has_key: key => key === 'preset-directory',
            },
            get_string: () => directory,
        };
        const dynamicStore = new PresetStore({settings});
        dynamicStore._externalLoaded = true;
        dynamicStore._externalPresets = [{id: 'file:a', name: 'A'}];

        dynamicStore.handleSettingsChanged('preset-directory');

        assert(dynamicStore._externalLoaded === false, 'preset-directory change clears external-loaded cache state');
        assert(dynamicStore._externalPresets.length === 0, 'preset-directory change clears external preset cache');

        directory = '/tmp/second';
        dynamicStore.handleSettingsChanged('preset-directory');
        assert(dynamicStore._externalLoaded === false, 'repeated preset-directory changes remain idempotent');
    }

    {
        const guardedStore = new PresetStore({
            settings: {
                settings_schema: {
                    has_key: () => false,
                },
                get_string: () => {
                    throw new Error('should not be called when key is missing');
                },
            },
        });

        const index = await guardedStore.loadIndex();
        assert(index.length >= 9, 'missing preset-directory key falls back to built-in index without throwing');
    }
}
