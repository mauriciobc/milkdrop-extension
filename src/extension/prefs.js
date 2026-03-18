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

function addEntryRow(group, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const entry = new Gtk.Entry({hexpand: true, valign: Gtk.Align.CENTER});
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(entry);
    row.activatable_widget = entry;
    group.add(row);
}

export default class MilkdropPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(720, 640);

        const displayPage = new Adw.PreferencesPage({
            title: _('Display'),
            icon_name: 'video-display-symbolic',
        });
        window.add(displayPage);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Desktop behavior'),
            description: _('Visibility and performance controls for running the renderer on your desktop.'),
        });
        displayPage.add(displayGroup);

        addSwitchRow(displayGroup, settings, 'hide-when-maximized', _('Hide when maximized'), _('Pause visual presence when a window is maximized.'));
        addSwitchRow(displayGroup, settings, 'show-on-empty-desktop-only', _('Empty desktop only'), _('Pause unless your desktop is empty (no normal windows visible).'));
        addSwitchRow(displayGroup, settings, 'text-overlay-enabled', _('Text overlay'), _('Show or hide status text drawn over visualizations.'));
        addSwitchRow(displayGroup, settings, 'pause-when-fullscreen', _('Pause when fullscreen'), _('Immediately pause rendering while the focused window is fullscreen.'));
        addSwitchRow(displayGroup, settings, 'show-only-when-media-playing', _('Only when media is playing'), _('Pause visualizations when no MPRIS player is playing. Saves CPU and GPU until you start music or video.'));
        addSpinRow(displayGroup, settings, 'fps-limit', _('FPS limit'), _('Limit the renderer frame rate.'), new Gtk.Adjustment({lower: 30, upper: 240, step_increment: 1, page_increment: 10, value: 60}));

        const audioPage = new Adw.PreferencesPage({
            title: _('Audio'),
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(audioPage);

        const audioGroup = new Adw.PreferencesGroup({
            title: _('Signal input'),
            description: _('Audio capture settings used for beat detection and audio-reactive visuals.'),
        });
        audioPage.add(audioGroup);

        addSpinRow(audioGroup, settings, 'audio-sensitivity', _('Audio sensitivity'), _('Multiplier applied to audio-derived values.'), new Gtk.Adjustment({lower: 0.1, upper: 3.0, step_increment: 0.1, page_increment: 0.5, value: 1.0}));
        addEntryRow(audioGroup, settings, 'audio-source', _('Audio source'), _('Output monitor source name (for example alsa_output...monitor) or auto (never microphone fallback).'));
        addSpinRow(audioGroup, settings, 'audio-restart-max-attempts', _('Audio restart max attempts'), _('Applies after audio pipeline restart/reprobe.'), new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 5, value: 3}));
        addSpinRow(audioGroup, settings, 'audio-reprobe-delay-ms', _('Audio reprobe delay (ms)'), _('Applies after audio pipeline restart/reprobe.'), new Gtk.Adjustment({lower: 250, upper: 120000, step_increment: 50, page_increment: 500, value: 2500}));
        addEntryRow(audioGroup, settings, 'eval-backend', _('Evaluator backend'), _('Current values: subprocess, gi, or js.'));

        const advancedPage = new Adw.PreferencesPage({
            title: _('Advanced'),
            icon_name: 'applications-system-symbolic',
        });
        window.add(advancedPage);

        const advancedGroup = new Adw.PreferencesGroup({
            title: _('Renderer'),
            description: _('Debug and preset storage settings.'),
        });
        const aboutGroup = new Adw.PreferencesGroup({
            title: _('Project'),
            description: _('Current scaffold state and installation target.'),
        });

        advancedPage.add(advancedGroup);
        advancedPage.add(aboutGroup);

        addSwitchRow(advancedGroup, settings, 'debug-renderer', _('Debug renderer'), _('Enable verbose renderer logging during development.'));
        addSwitchRow(advancedGroup, settings, 'strict-render-path', _('Strict render path'), _('Disable legacy Base64 frame fallback and require shared-memory frame transport.'));
        addSpinRow(advancedGroup, settings, 'preset-rotation-interval', _('Preset rotation interval'), _('Seconds between automatic preset changes.'), new Gtk.Adjustment({lower: 0, upper: 600, step_increment: 1, page_increment: 10, value: 0}));
        addEntryRow(advancedGroup, settings, 'preset-rotation-mode', _('Preset rotation mode'), _('Use random or sequential. Applies on the next rotation tick.'));
        addSwitchRow(advancedGroup, settings, 'beat-cuts-enabled', _('Beat cuts enabled'), _('Allow beat events to trigger preset changes.'));
        addSpinRow(advancedGroup, settings, 'beat-cut-cooldown-sec', _('Beat-cut cooldown (sec)'), _('Minimum seconds between beat-triggered preset cuts (applies immediately).'), new Gtk.Adjustment({lower: 0.0, upper: 30.0, step_increment: 0.1, page_increment: 0.5, value: 2.0}));
        addSpinRow(advancedGroup, settings, 'blend-time', _('Blend time'), _('Seconds used for preset blending.'), new Gtk.Adjustment({lower: 0.0, upper: 10.0, step_increment: 0.1, page_increment: 0.5, value: 2.0}));
        addEntryRow(advancedGroup, settings, 'preset-directory', _('Preset directory'), _('Optional external preset path.'));
        addEntryRow(advancedGroup, settings, 'preset-path', _('Preset path'), _('Optional preset file path (usually a .milk). When set, automatic rotation is paused.'));

        const statusRow = new Adw.ActionRow({
            title: _('Scaffold status'),
            subtitle: _('Local-first GNOME 47-49 extension with a split-process renderer.'),
        });
        aboutGroup.add(statusRow);
    }
}
