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
            description: _('Early implementation controls for monitor visibility and frame rate.'),
        });
        displayPage.add(displayGroup);

        addSwitchRow(displayGroup, settings, 'hide-when-maximized', _('Hide when maximized'), _('Pause visual presence when a window is maximized.'));
        addSwitchRow(displayGroup, settings, 'show-on-empty-desktop-only', _('Empty desktop only'), _('Restrict the renderer to empty-desktop scenarios later in development.'));
        addSpinRow(displayGroup, settings, 'fps-limit', _('FPS limit'), _('Current placeholder frame cap.'), new Gtk.Adjustment({lower: 30, upper: 240, step_increment: 1, page_increment: 10, value: 60}));

        const audioPage = new Adw.PreferencesPage({
            title: _('Audio'),
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(audioPage);

        const audioGroup = new Adw.PreferencesGroup({
            title: _('Signal input'),
            description: _('Audio and evaluator settings are scaffolded but not fully implemented yet.'),
        });
        audioPage.add(audioGroup);

        addSpinRow(audioGroup, settings, 'audio-sensitivity', _('Audio sensitivity'), _('Multiplier applied once the spectrum pipeline is active.'), new Gtk.Adjustment({lower: 0.1, upper: 3.0, step_increment: 0.1, page_increment: 0.5, value: 1.0}));
        addEntryRow(audioGroup, settings, 'audio-source', _('Audio source'), _('Output monitor source name (for example alsa_output...monitor) or auto (never microphone fallback).'));
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
        addSpinRow(advancedGroup, settings, 'blend-time', _('Blend time'), _('Seconds used for preset blending.'), new Gtk.Adjustment({lower: 0.0, upper: 10.0, step_increment: 0.1, page_increment: 0.5, value: 2.0}));
        addEntryRow(advancedGroup, settings, 'preset-directory', _('Preset directory'), _('Optional external preset path.'));

        const statusRow = new Adw.ActionRow({
            title: _('Scaffold status'),
            subtitle: _('Local-first GNOME 47-49 scaffold with standalone renderer placeholder.'),
        });
        aboutGroup.add(statusRow);
    }
}
