/**
 * Pure helpers for probe/graceful commit decisions.
 *
 * Frame-based commit used to run before IPC sendFrame in the pump, so a preset
 * could be marked stable and then crash the native helper on that same tick
 * (journal: milkdrop-gl-helper segfault in render_frame). Call sites may require
 * both extension frame count and native helper frame-stat advancement when
 * minHelperFrameAdvance > 0.
 */

export function shouldCommitByFrames({
    probeActive,
    probeCrashed,
    frameCounter,
    probeFrameTarget,
    minHelperFrameAdvance = 0,
    helperFrameMinAdvance = 0,
}) {
    if (!probeActive)
        return false;
    if (probeCrashed)
        return false;
    if (typeof frameCounter !== 'number' || typeof probeFrameTarget !== 'number')
        return false;
    if (frameCounter < probeFrameTarget)
        return false;
    if (minHelperFrameAdvance > 0) {
        if (typeof helperFrameMinAdvance !== 'number' || helperFrameMinAdvance < minHelperFrameAdvance)
            return false;
    }
    return true;
}

export function shouldCommitByTimeout({probeActive, probeCrashed, nowMs, probeStartMs, probeTimeoutMs}) {
    if (!probeActive)
        return false;
    if (probeCrashed)
        return false;
    if (typeof nowMs !== 'number' || typeof probeStartMs !== 'number' || typeof probeTimeoutMs !== 'number')
        return false;
    if (probeTimeoutMs <= 0)
        return false;
    return (nowMs - probeStartMs) >= probeTimeoutMs;
}

