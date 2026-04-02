import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function addSwitchRow(group, settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpinRow(group, settings, key, title, subtitle, adjustment) {
    const row = new Adw.ActionRow({title, subtitle});
    const spin = new Gtk.SpinButton({adjustment, valign: Gtk.Align.CENTER});
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function addAudioSourceRow(group, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const entry = new Gtk.Entry({
        hexpand: true,
        valign: Gtk.Align.CENTER,
        placeholder_text: 'auto or alsa_output.<device>.monitor',
    });
    const autoButton = new Gtk.Button({
        label: _('Use auto'),
        valign: Gtk.Align.CENTER,
    });

    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    autoButton.connect('clicked', () => settings.set_string(key, 'auto'));

    row.add_suffix(entry);
    row.add_suffix(autoButton);
    row.activatable_widget = entry;
    group.add(row);
}

function addComboRow(group, settings, key, title, subtitle, choices) {
    const normalized = choices.map(choice => {
        if (typeof choice === 'string')
            return {value: choice, label: choice};
        return {value: String(choice.value), label: String(choice.label)};
    });

    const model = new Gtk.StringList();
    for (const c of normalized)
        model.append(c.label);

    const row = new Adw.ComboRow({title, subtitle, model});
    const indexOf = (val) => normalized.findIndex(c => c.value === String(val));
    const sync = () => {
        const idx = indexOf(settings.get_string(key));
        if (idx >= 0) row.selected = idx;
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, normalized[row.selected]?.value ?? 'random'));
    settings.connect(`changed::${key}`, sync);
    group.add(row);
}

function addAudioRecoveryExpander(group, settings) {
    const expander = new Adw.ExpanderRow({
        title: _('Audio Recovery'),
        subtitle: _('Use these only when audio keeps dropping or failing to reconnect'),
    });

    const restartRow = new Adw.ActionRow({
        title: _('Restart Attempt Budget'),
        subtitle: _('Maximum restarts before safe fallback mode is enabled'),
    });
    const restartSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 5, value: 3}),
        valign: Gtk.Align.CENTER,
    });
    settings.bind('audio-restart-max-attempts', restartSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    restartRow.add_suffix(restartSpin);
    restartRow.activatable_widget = restartSpin;

    const reprobeRow = new Adw.ActionRow({
        title: _('Reprobe Delay'),
        subtitle: _('Delay before monitor-source discovery retries in fallback mode'),
    });
    const reprobeSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower: 250, upper: 120000, step_increment: 50, page_increment: 500, value: 2500}),
        valign: Gtk.Align.CENTER,
    });
    settings.bind('audio-reprobe-delay-ms', reprobeSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    reprobeRow.add_suffix(reprobeSpin);
    reprobeRow.activatable_widget = reprobeSpin;

    expander.add_row(restartRow);
    expander.add_row(reprobeRow);
    group.add(expander);
}

function addFolderRow(group, settings, key, title, subtitle, parentWindow) {
    const row = new Adw.ActionRow({title, subtitle});
    const entry = new Gtk.Entry({hexpand: true, valign: Gtk.Align.CENTER, editable: false});
    const button = new Gtk.Button({label: _('Select…'), valign: Gtk.Align.CENTER});

    const updateEntry = () => {
        try {
            entry.set_text(settings.get_string(key) ?? '');
        } catch (_e) {
            entry.set_text('');
        }
    };

    updateEntry();
    settings.connect(`changed::${key}`, updateEntry);

    button.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title});
        dialog.select_folder(parentWindow, null, (d, res) => {
            try {
                const file = d.select_folder_finish(res);
                if (!file)
                    return;
                const path = file.get_path?.();
                if (path)
                    settings.set_string(key, path);
            } catch (_e) {}
        });
    });

    row.add_suffix(entry);
    row.add_suffix(button);
    group.add(row);
}

export default class MilkdropPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(720, 640);
        window.search_enabled = true;

        const displayPage = new Adw.PreferencesPage({
            title: _('Display'),
            icon_name: 'video-display-symbolic',
        });
        window.add(displayPage);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Desktop behavior'),
            description: _('Visibility controls for running the renderer on your desktop'),
        });
        const displayPerformanceGroup = new Adw.PreferencesGroup({
            title: _('Performance'),
            description: _('Frame-rate limits that affect CPU and GPU usage'),
        });
        displayPage.add(displayGroup);
        displayPage.add(displayPerformanceGroup);

        addSwitchRow(displayGroup, settings, 'show-only-when-media-playing', _('Only When Media Is Playing'), _('Pause visualizations when no MPRIS player is playing to save CPU and GPU'));
        addSwitchRow(displayGroup, settings, 'pause-when-fullscreen', _('Pause When Fullscreen'), _('Pause rendering while the focused window is fullscreen'));
        addSwitchRow(displayGroup, settings, 'hide-when-maximized', _('Hide When Maximized'), _('Pause visual presence when a window is maximized'));
        addSwitchRow(displayGroup, settings, 'show-on-empty-desktop-only', _('Empty Desktop Only'), _('Pause unless no normal windows are visible'));
        addSwitchRow(displayGroup, settings, 'text-overlay-enabled', _('Text Overlay'), _('Show status text over visualizations'));
        addSpinRow(displayPerformanceGroup, settings, 'fps-limit', _('FPS Limit'), _('Limit the renderer frame rate'), new Gtk.Adjustment({lower: 30, upper: 240, step_increment: 1, page_increment: 10, value: 60}));

        const audioPage = new Adw.PreferencesPage({
            title: _('Audio'),
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(audioPage);

        const audioGroup = new Adw.PreferencesGroup({
            title: _('Audio Input'),
            description: _('Audio capture settings for beat detection and audio-reactive visuals'),
        });
        audioPage.add(audioGroup);

        addAudioSourceRow(audioGroup, settings, 'audio-source', _('Audio Source'), _('Use auto for automatic output monitor selection with no microphone fallback'));
        addAudioRecoveryExpander(audioGroup, settings);

        const presetsPage = new Adw.PreferencesPage({
            title: _('Presets'),
            icon_name: 'media-playlist-shuffle-symbolic',
        });
        window.add(presetsPage);

        const presetGroup = new Adw.PreferencesGroup({
            title: _('Preset Behavior'),
            description: _('Control preset switching and transition behavior'),
        });
        const libraryGroup = new Adw.PreferencesGroup({
            title: _('Preset Library'),
            description: _('Optional external folder used to discover additional .milk presets'),
        });

        presetsPage.add(presetGroup);
        presetsPage.add(libraryGroup);

        addSpinRow(presetGroup, settings, 'preset-rotation-interval', _('Preset Rotation Interval'), _('Seconds between automatic preset changes, set 0 to disable auto-rotation'), new Gtk.Adjustment({lower: 0, upper: 600, step_increment: 1, page_increment: 10, value: 0}));
        addComboRow(
            presetGroup,
            settings,
            'preset-rotation-mode',
            _('Preset Rotation Mode'),
            _('Applies on the next rotation tick'),
            [
                {value: 'random', label: _('Random')},
                {value: 'sequential', label: _('Sequential')},
            ]
        );
        addSwitchRow(presetGroup, settings, 'beat-cuts-enabled', _('Beat Cuts Enabled'), _('Allow beat events to trigger preset changes'));
        addSpinRow(presetGroup, settings, 'beat-cut-cooldown-sec', _('Beat-cut Cooldown'), _('Minimum seconds between beat-triggered preset cuts'), new Gtk.Adjustment({lower: 0.0, upper: 30.0, step_increment: 0.1, page_increment: 0.5, value: 2.0}));
        addSpinRow(presetGroup, settings, 'blend-time', _('Blend Time'), _('Seconds used for preset blending'), new Gtk.Adjustment({lower: 0.0, upper: 10.0, step_increment: 0.1, page_increment: 0.5, value: 2.0}));
        addFolderRow(libraryGroup, settings, 'preset-directory', _('Preset Directory'), _('Optional external preset path'), window);
    }
}
