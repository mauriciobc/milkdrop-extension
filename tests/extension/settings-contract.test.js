import GLib from 'gi://GLib';

const NEW_KEYS = [
    {name: 'text-overlay-enabled', type: 'b', defaultValue: 'true'},
    {name: 'pause-when-fullscreen', type: 'b', defaultValue: 'false'},
    {name: 'audio-restart-max-attempts', type: 'i', defaultValue: '3'},
    {name: 'audio-reprobe-delay-ms', type: 'i', defaultValue: '2500'},
    {name: 'preset-rotation-mode', type: 's', defaultValue: "'random'"},
    {name: 'beat-cut-cooldown-sec', type: 'd', defaultValue: '2.0'},
    {name: 'preset-path', type: 's', defaultValue: "''"},
];

const PREFS_KEYS = [
    'text-overlay-enabled',
    'pause-when-fullscreen',
    'audio-restart-max-attempts',
    'audio-reprobe-delay-ms',
    'preset-rotation-mode',
    'beat-cut-cooldown-sec',
    'preset-path',
];

const RUNTIME_KEY_OWNERS = {
    'text-overlay-enabled': 'src/extension/monitor.js',
    'pause-when-fullscreen': 'src/extension/monitor.js',
    'audio-restart-max-attempts': 'src/extension/audio.js',
    'audio-reprobe-delay-ms': 'src/extension/audio.js',
    'preset-rotation-mode': 'src/extension/monitor.js',
    'beat-cut-cooldown-sec': 'src/extension/monitor.js',
    'preset-path': 'src/extension/monitor.js',
};

function readText(relativePath) {
    const absolute = GLib.build_filenamev([GLib.get_current_dir(), relativePath]);
    const [ok, bytes] = GLib.file_get_contents(absolute);
    if (!ok)
        throw new Error(`Unable to read ${relativePath}`);

    return new TextDecoder().decode(bytes);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function run(assert) {
    const schemaText = readText('src/extension/schemas/org.gnome.shell.extensions.milkdrop.gschema.xml');
    const prefsText = readText('src/extension/prefs.js');

    for (const {name, type, defaultValue} of NEW_KEYS) {
        const keyPattern = new RegExp(`<key\\s+name=\\"${escapeRegex(name)}\\"\\s+type=\\"${escapeRegex(type)}\\">`);
        assert(keyPattern.test(schemaText), `schema defines ${name} with type ${type}`);

        const defaultPattern = new RegExp(`<key\\s+name=\\"${escapeRegex(name)}\\"[^>]*>[\\s\\S]*?<default>${escapeRegex(defaultValue)}<\\/default>`);
        assert(defaultPattern.test(schemaText), `schema default for ${name} is ${defaultValue}`);
    }

    for (const key of PREFS_KEYS)
        assert(prefsText.includes(`'${key}'`), `prefs includes binding for ${key}`);

    for (const [key, ownerPath] of Object.entries(RUNTIME_KEY_OWNERS)) {
        const ownerText = readText(ownerPath);
        assert(ownerText.includes(`'${key}'`), `${ownerPath} references ${key}`);
    }

    assert(schemaText.includes("<choice value='random'/>") && schemaText.includes("<choice value='sequential'/>"),
        'preset-rotation-mode includes random/sequential choices');
}
