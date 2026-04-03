import GLib from 'gi://GLib';

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

export function run(assert) {
    const mesonText = readText('meson.build');

    assert(
        mesonText.includes("dependency('libprojectm', required: false)"),
        'meson prefers dependency(\'libprojectm\') before fallback names'
    );

    assert(
        mesonText.includes("dependency('projectM-4', required: false)"),
        'meson keeps fallback dependency(\'projectM-4\') for distro compatibility'
    );

    assert(
        mesonText.includes('projectM 4.x C API headers were not found'),
        'meson fails fast when only unsupported projectM headers are present'
    );
}
