/**
 * Create a cheap per-frame snapshot that avoids JSON serialization.
 * Scalars are copied; PCM arrays are reused as references for this frame.
 */
export function snapshotAudioForFrame(rawAudio) {
    return {
        source: String(rawAudio?.source ?? 'stub'),
        active: Boolean(rawAudio?.active),
        energy: Number(rawAudio?.energy ?? 0),
        bass: Number(rawAudio?.bass ?? 0),
        mid: Number(rawAudio?.mid ?? 0),
        high: Number(rawAudio?.high ?? 0),
        beat: Number(rawAudio?.beat ?? 0),
        decay: Number(rawAudio?.decay ?? 0),
        pcmLeft: rawAudio?.active ? (rawAudio?.pcmLeft || []) : [],
        pcmRight: rawAudio?.active ? (rawAudio?.pcmRight || []) : [],
    };
}

export function attachAudioSnapshot(evaluated, audioSnapshot) {
    evaluated.audio = audioSnapshot;
}

export function attachPresetPathForHelper(evaluated, helperPresetEnabled, currentPreset) {
    if (helperPresetEnabled && currentPreset?.source === 'file' && currentPreset?.id?.startsWith?.('file:')) {
        evaluated.presetPath = currentPreset.id.replace(/^file:/, '');
        return;
    }
    evaluated.presetPath = undefined;
}
