export const IPC_PROTOCOL_VERSION = 2;
export const IPC_MIN_SUPPORTED_VERSION = 1;

export function normalizeProtocolVersion(message) {
    const version = Number(message?.protocolVersion ?? 1);
    if (!Number.isFinite(version))
        return 1;
    return Math.trunc(version);
}

export function isSupportedProtocolVersion(version) {
    return version >= IPC_MIN_SUPPORTED_VERSION && version <= IPC_PROTOCOL_VERSION;
}
