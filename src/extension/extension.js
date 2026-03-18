import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GnomeShellOverride} from './gnomeShellOverride.js';
import {MonitorManager} from './monitor.js';

export default class MilkdropExtension extends Extension {
    enable() {
        try {
            this._settings = this.getSettings();
            const logger = this.getLogger?.() ?? console;
            this._gnomeShellOverride = new GnomeShellOverride({logger});
            this._monitorManager = new MonitorManager({
                extensionPath: this.path,
                settings: this._settings,
                logger,
                gnomeShellOverride: this._gnomeShellOverride,
            });
            this._gnomeShellOverride.enable();
            this._monitorManager.enable();
        } catch (e) {
            global.log?.('Milkdrop enable() failed: ' + e.message);
            console.warn('[GNOME Milkdrop] enable() failed:', e.message, e.stack);
            throw e;
        }
    }

    disable() {
        this._monitorManager?.disable();
        this._monitorManager = null;
        this._gnomeShellOverride?.disable();
        this._gnomeShellOverride = null;
        this._settings = null;
    }
}
