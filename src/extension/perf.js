/**
 * Lightweight performance mark utilities for gnome-milkdrop.
 *
 * Uses GLib.log_structured() to emit marks that Sysprof can capture
 * when the SYSPROF_TRACE_FD environment variable is set (Sysprof 46+).
 *
 * When Sysprof is not capturing, marks are effectively no-ops (just
 * a GLib.get_monotonic_time() call + env check).
 */
import GLib from 'gi://GLib';

const _sysprofEnabled = GLib.getenv('SYSPROF_TRACE_FD') !== null ||
                        GLib.getenv('MILKDROP_PERF_MARKS') === '1';

/**
 * Begin a named performance mark. Returns an opaque token
 * to pass to perfEnd().
 */
export function perfBegin(name) {
    if (!_sysprofEnabled)
        return null;
    return {name, start: GLib.get_monotonic_time()};
}

/**
 * End a performance mark started with perfBegin().
 * Emits a structured log message that Sysprof captures as a mark.
 */
export function perfEnd(token) {
    if (!token)
        return;
    const duration = GLib.get_monotonic_time() - token.start;
    GLib.log_structured('milkdrop-perf', GLib.LogLevelFlags.LEVEL_DEBUG,
        {MESSAGE: `perf: ${token.name} ${duration}µs`,
         MILKDROP_PERF_MARK: token.name,
         MILKDROP_PERF_DURATION_US: `${duration}`});
}
