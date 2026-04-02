import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import { LiveWallpaper, RENDERER_TITLE_PREFIX } from './wallpaper.js';

/**
 * GnomeShellOverride injects the live wallpaper into every GNOME Shell
 * background actor and hides the renderer window from all shell UI that
 * would expose it as a regular application window (overview tiles,
 * workspace thumbnails, alt-tab, dash, …).
 *
 * Heavily inspired by gnome-ext-hanabi (jeffshee).
 */
export class GnomeShellOverride {
    constructor({ logger = console } = {}) {
        this._logger = logger;
        this._injectionManager = new InjectionManager();
        this._wallpaperActors = new Set();
    }

    /** Called by MonitorManager when "only when media playing" changes visibility. */
    setMediaOverlayVisibility(visible) {
        const opacity = visible ? 255 : 0;
        const duration = 400;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        for (const actor of this._wallpaperActors) {
            try {
                if (GObject.Object.prototype.toString.call(actor).includes('DISPOSED'))
                    continue;
                if (typeof actor.ease === 'function')
                    actor.ease({ opacity, duration, mode });
                else
                    actor.opacity = opacity;
            } catch (_e) {}
        }
    }

    enable() {
        const thisRef = this;

        // ── Background injection ────────────────────────────────────────────
        // Every BackgroundManager creates one actor per monitor.  We hook into
        // _createBackgroundActor to slip a LiveWallpaper clone on top of each
        // static background so animated output appears in the overview, lock
        // screen, and workspace thumbnails.
        this._injectionManager.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            originalMethod => {
                return function () {
                    const backgroundActor = originalMethod.call(this);
                    this.liveWallpaper = new LiveWallpaper(backgroundActor);
                    thisRef._wallpaperActors.add(this.liveWallpaper);
                    this.liveWallpaper.connect('destroy', actor => {
                        thisRef._wallpaperActors.delete(actor);
                    });
                    return backgroundActor;
                };
            }
        );

        // ── Window filtering ────────────────────────────────────────────────
        // These overrides prevent the renderer window from surfacing as a
        // normal application window anywhere in the shell UI.

        // Overview workspace tiles
        this._injectionManager.overrideMethod(
            Workspace.Workspace.prototype,
            '_isOverviewWindow',
            originalMethod => {
                return function (window) {
                    if (window.title?.startsWith(RENDERER_TITLE_PREFIX))
                        return false;
                    return originalMethod.apply(this, [window]);
                };
            }
        );

        // Small workspace thumbnails (left-side panel in overview)
        this._injectionManager.overrideMethod(
            WorkspaceThumbnail.WorkspaceThumbnail.prototype,
            '_isOverviewWindow',
            originalMethod => {
                return function (window) {
                    if (window.title?.startsWith(RENDERER_TITLE_PREFIX))
                        return false;
                    return originalMethod.apply(this, [window]);
                };
            }
        );

        // Global window actor list used by many shell internals.
        // Accepts an optional hideRenderer flag so LiveWallpaper._getRenderer()
        // can call get_window_actors(false) to bypass this filter.
        this._injectionManager.overrideMethod(
            Shell.Global.prototype,
            'get_window_actors',
            originalMethod => {
                return function (hideRenderer = true) {
                    const windowActors = originalMethod.call(this);
                    return hideRenderer
                        ? windowActors.filter(
                            win => !win.meta_window.title?.startsWith(RENDERER_TITLE_PREFIX)
                        )
                        : windowActors;
                };
            }
        );

        // Alt-tab and Ctrl+Alt+Tab switchers
        this._injectionManager.overrideMethod(
            Meta.Display.prototype,
            'get_tab_list',
            originalMethod => {
                return function (type, workspace) {
                    const metaWindows = originalMethod.apply(this, [type, workspace]);
                    return metaWindows.filter(
                        win => !win.title?.startsWith(RENDERER_TITLE_PREFIX)
                    );
                };
            }
        );

        // Prevent the renderer from being tracked as a running application
        // (dash, app grid, taskbar extensions, …)
        this._injectionManager.overrideMethod(
            Shell.WindowTracker.prototype,
            'get_window_app',
            originalMethod => {
                return function (window) {
                    if (window.title?.startsWith(RENDERER_TITLE_PREFIX))
                        return null;
                    return originalMethod.apply(this, [window]);
                };
            }
        );

        this._reloadBackgrounds();
    }

    disable() {
        this._injectionManager.clear();
        this._reloadBackgrounds();
    }

    _reloadBackgrounds() {
        // Snapshot to array — the 'destroy' signal callback mutates the set.
        const actors = [...this._wallpaperActors];
        this._wallpaperActors.clear();
        const isDisposed = obj => {
            try {
                return (GObject.Object.prototype.toString.call(obj).includes('DISPOSED'));
            } catch (e) {
                return true;
            }
        };

        for (const actor of actors) {
            try {
                if (!isDisposed(actor))
                    actor.destroy();
            } catch (_e) {
                // Actor already disposed
            }
        }

        // Recreate background actors so they pick up (or drop) our override.
        try {
            if (Main.layoutManager?._updateBackgrounds != null)
                Main.layoutManager._updateBackgrounds();
        } catch (_e) { }

        try {
            if (Main.screenShield?._dialog?._updateBackgrounds != null)
                Main.screenShield._dialog._updateBackgrounds();
        } catch (_e) { }

        this._refreshOverviewWorkspaces();
    }

    _refreshOverviewWorkspaces() {
        // Force overview workspace views to rebuild so thumbnails pick up the
        // updated background actors. Private API paths vary by GNOME version.
        const candidates = [
            Main.overview?._overview?._controls?._workspacesDisplay,
            Main.overview?._overview?._workspacesDisplay,
        ];

        for (const candidate of candidates) {
            if (candidate?._updateWorkspacesViews != null) {
                try {
                    candidate._updateWorkspacesViews();
                } catch (error) {
                    this._logger.debug?.(`milkdrop overview refresh failed: ${error.message}`);
                }
                return;
            }
        }

        this._logger.debug?.('milkdrop overview refresh skipped: no compatible workspaces display API found');
    }
}
