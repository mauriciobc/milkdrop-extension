import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PresetStore, validatePresetExpressions} from '../../src/extension/presets.js';

export async function run(assert) {
    const store = new PresetStore();

    {
        const index = await store.loadIndex();
        assert(Array.isArray(index), 'loadIndex returns array');
        assert(index.length === 0, 'loadIndex is empty when preset-directory is not configured');
    }

    {
        const tempDir = GLib.dir_make_tmp('milkdrop-expr-presets-XXXXXX');
        const presetPath = GLib.build_filenamev([tempDir, 'external-test.milk']);
        const milkText =
            '[preset00]\n' +
            'fZoom=1.01\n' +
            'fRot=0.02\n' +
            'per_frame_1=zoom=zoom+energy*0.1;\n' +
            'per_pixel_1=dx=rad*0.01;\n';
        GLib.file_set_contents(presetPath, milkText);

        const settings = {
            settings_schema: {
                has_key: key => key === 'preset-directory',
            },
            get_string: () => tempDir,
        };

        try {
            const externalStore = new PresetStore({settings});
            const index = await externalStore.loadIndex();
            const externalEntry = index.find(entry => entry.source === 'file') ?? null;
            assert(externalEntry && typeof externalEntry.id === 'string', 'external .milk appears in loadIndex');
            assert(externalEntry.id.startsWith('file:'), 'external .milk index id is file:<absPath>');
            const absPath = externalEntry.id.replace(/^file:/, '');
            assert(absPath === presetPath, 'external .milk index id uses absolute path');

            const loaded = await externalStore.loadPreset(externalEntry.id);
            assert(loaded.source === 'file', 'external expression preset keeps source=file');
            assert(loaded.path === presetPath, 'external .milk preset exposes absolute path for renderer');
            assert(typeof loaded.frame_eqs === 'string' && loaded.frame_eqs.includes('zoom=zoom+energy*0.1'),
                'external .milk preset exposes frame_eqs');
            assert(typeof loaded.pixel_eqs === 'string' && loaded.pixel_eqs.includes('dx=rad*0.01'),
                'external .milk preset exposes pixel_eqs');

            // loadPreset must return a clone (no mutation leaks across calls).
            const first = await externalStore.loadPreset(externalEntry.id);
            first.frame_eqs = 'mutated';
            const second = await externalStore.loadPreset(externalEntry.id);
            assert(second.frame_eqs !== 'mutated', 'loadPreset returns a clone and does not leak mutations');
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
        const tempDir = GLib.dir_make_tmp('milkdrop-invalid-presets-XXXXXX');
        const goodPath = GLib.build_filenamev([tempDir, 'good.milk']);
        const badPath = GLib.build_filenamev([tempDir, 'bad.milk']);
        GLib.file_set_contents(goodPath,
            '[preset00]\nper_frame_1=zoom=zoom+0.01;\n');
        GLib.file_set_contents(badPath,
            '[preset00]\nper_frame_1=a=b&c=d;\n');

        const settings = {
            settings_schema: {
                has_key: key => key === 'preset-directory',
            },
            get_string: () => tempDir,
        };

        try {
            const store = new PresetStore({settings});
            const index = await store.loadIndex();
            assert(index.some(e => e.id.endsWith('good.milk')),
                'valid external .milk stays in index');
            assert(!index.some(e => e.id.endsWith('bad.milk')),
                'invalid-expression .milk is omitted from index');
        } finally {
            for (const p of [goodPath, badPath]) {
                try {
                    Gio.File.new_for_path(p).delete(null);
                } catch (_e) {}
            }
            try {
                Gio.File.new_for_path(tempDir).delete(null);
            } catch (_e) {}
        }
    }

    {
        assert(validatePresetExpressions({
            init_eqs: '',
            frame_eqs: 'zoom=1;',
            pixel_eqs: '',
            customWaves: [null, null, null, null],
            customShapes: [null, null, null, null],
        }), 'validatePresetExpressions accepts minimal preset');
        assert(!validatePresetExpressions({
            init_eqs: '',
            frame_eqs: 'a=b&c=d;',
            pixel_eqs: '',
            customWaves: [null, null, null, null],
            customShapes: [null, null, null, null],
        }), 'validatePresetExpressions rejects bad frame_eqs');
    }

    {
        let threw = false;
        try {
            await store.loadPreset('file:/missing-id.milk');
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
        assert(index.length === 0, 'missing preset-directory key returns empty index without throwing');
    }
}
