export const RENDERER_TITLE_PREFIX = '@io.github.mauriciobc.MilkdropRenderer!';

export function parseRendererWindowTitle(title) {
    if (typeof title !== 'string' || !title.startsWith(RENDERER_TITLE_PREFIX))
        return null;

    const payload = title.slice(RENDERER_TITLE_PREFIX.length);
    const pipeIndex = payload.lastIndexOf('|');
    if (pipeIndex < 0)
        return null;

    const encodedState = payload.slice(0, pipeIndex).trim();
    const monitorText = payload.slice(pipeIndex + 1).trim();
    if (!encodedState.startsWith('{') || !encodedState.endsWith('}'))
        return null;

    let state;
    try {
        state = JSON.parse(encodedState);
    } catch (_error) {
        return null;
    }

    if (typeof state !== 'object' || state === null || Array.isArray(state))
        return null;

    const monitorIndex = Number.parseInt(monitorText, 10);
    if (!Number.isFinite(monitorIndex) || monitorIndex < 0)
        return null;

    return {
        state,
        monitorIndex,
    };
}