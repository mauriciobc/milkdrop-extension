/**
 * Session-only crash quarantine for presets.
 *
 * Pure logic (no gjs dependencies) so it can be unit-tested.
 */

export class PresetCrashQuarantine {
    constructor({cooldownMs = 10 * 60 * 1000} = {}) {
        this._cooldownMs = Math.max(0, Number(cooldownMs) || 0);
        this._blacklistedUntilById = new Map();
    }

    recordCrash(presetId, nowMs = Date.now()) {
        if (!presetId)
            return false;

        const id = typeof presetId === 'string' ? presetId : String(presetId);
        if (!id)
            return false;

        const until = nowMs + this._cooldownMs;
        this._blacklistedUntilById.set(id, until);
        return true;
    }

    isBlacklisted(presetId, nowMs = Date.now()) {
        if (!presetId)
            return false;

        const id = typeof presetId === 'string' ? presetId : String(presetId);
        if (!id)
            return false;

        const until = this._blacklistedUntilById.get(id);
        if (typeof until !== 'number')
            return false;

        if (nowMs < until)
            return true;

        this._blacklistedUntilById.delete(id);
        return false;
    }

    filterEligible(presetEntries, nowMs = Date.now()) {
        if (!Array.isArray(presetEntries))
            return [];

        const out = [];
        for (const entry of presetEntries) {
            const id = entry?.id;
            if (!id)
                continue;
            if (this.isBlacklisted(id, nowMs))
                continue;
            out.push(entry);
        }
        return out;
    }
}

