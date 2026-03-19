/**
 * Pure helpers for probe/graceful-commit decisions.
 */

export function shouldCommitByFrames({probeActive, probeCrashed, frameCounter, probeFrameTarget}) {
    if (!probeActive)
        return false;
    if (probeCrashed)
        return false;
    if (typeof frameCounter !== 'number' || typeof probeFrameTarget !== 'number')
        return false;
    return frameCounter >= probeFrameTarget;
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

