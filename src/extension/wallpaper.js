import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Graphene from 'gi://Graphene';

import {RENDERER_TITLE_PREFIX} from './windowTitle.js';

export {RENDERER_TITLE_PREFIX};

const BACKGROUND_FADE_ANIMATION_TIME = 1000;
const RENDERER_POLL_INTERVAL_MS = 1000;

/**
 * LiveWallpaper is a Clutter.Clone of the renderer window actor, inserted
 * as a child of every BackgroundActor so the animated output shows up in
 * the overview, workspace thumbnails, and any other place GNOME Shell
 * renders the background stack.
 */
export const LiveWallpaper = GObject.registerClass(
    class LiveWallpaper extends St.Widget {
        constructor(backgroundActor) {
            super({
                layout_manager: new Clutter.BinLayout(),
                width: backgroundActor.width,
                height: backgroundActor.height,
                x_expand: true,
                y_expand: true,
                opacity: 0,
            });

            this._monitorIndex = backgroundActor.monitor;
            this._wallpaper = null;
            this._pollSourceId = 0;
            this._destroyed = false;
            this.connect('destroy', () => {
                this._destroyed = true;
                if (this._pollSourceId) {
                    GLib.source_remove(this._pollSourceId);
                    this._pollSourceId = 0;
                }
                if (this._wallpaperIdleId) {
                    GLib.source_remove(this._wallpaperIdleId);
                    this._wallpaperIdleId = 0;
                }

                // Just clear references. Clutter handles children.
                this._wallpaper = null;
                this._wallpaperDestroyId = 0;
            });

            // Stack ourselves on top of the static background content.
            backgroundActor.layout_manager = new Clutter.BinLayout();
            backgroundActor.add_child(this);

            this._applyWallpaper();
        }

        _applyWallpaper() {
            const tryApply = () => {
                if (this._destroyed) {
                    this._pollSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                try {
                    // Already applied, nothing to do.
                    if (this._wallpaper) {
                        this._pollSourceId = 0;
                        return GLib.SOURCE_REMOVE;
                    }

                    const renderer = this._getRenderer();
                    if (!renderer)
                        return GLib.SOURCE_CONTINUE;

                    this._wallpaper = new Clutter.Clone({
                        source: renderer,
                        pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                    });
                    this._wallpaperDestroyId = this._wallpaper.connect('destroy', () => {
                        const destroyedWallpaper = this._wallpaper;
                        this._wallpaperIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                            // Guard against the LiveWallpaper being finalized by C code
                            // before this idle fires — any property access on `this` can
                            // throw a "already disposed" error in that case.
                            try {
                                this._wallpaperIdleId = 0;
                                if (this._destroyed)
                                    return GLib.SOURCE_REMOVE;
                                try {
                                    if (destroyedWallpaper)
                                        destroyedWallpaper.source = null;
                                    if (this._wallpaper === destroyedWallpaper)
                                        this._wallpaper = null;
                                } catch (_e) {}
                                if (!this._wallpaper)
                                    this._applyWallpaper();
                            } catch (_e) {
                                // LiveWallpaper already finalized — nothing to do.
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    this.add_child(this._wallpaper);
                    this._fade(true);
                    this._pollSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                } catch (_e) {
                    this._pollSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }
            };

            if (tryApply() === GLib.SOURCE_CONTINUE) {
                this._pollSourceId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    RENDERER_POLL_INTERVAL_MS,
                    tryApply
                );
            }
        }

        _getRenderer() {
            // Pass false to bypass our own get_window_actors filter so we can
            // always find the renderer actor even after it is hidden from other
            // shell UI components.
            const windowActors = global.get_window_actors(false);
            return windowActors.find(win =>
                win.meta_window.title?.startsWith(RENDERER_TITLE_PREFIX) &&
                win.meta_window.get_monitor() === this._monitorIndex
            ) ?? null;
        }

        _fade(visible = true) {
            this.ease({
                opacity: visible ? 255 : 0,
                duration: BACKGROUND_FADE_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }
);
