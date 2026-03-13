const DEFAULT_DECAY = 0.98;
const DEFAULT_ZOOM = 1.0;

export class Evaluator {
    constructor() {
        this._preset = null;
        this._blendFrom = null;
        this._blendStartTime = 0;
        this._blendDuration = 0;
    }

    loadPreset(preset, blendDuration = 0) {
        if (blendDuration > 0 && this._preset) {
            this._blendFrom = this._preset;
            this._blendStartTime = -1; // will be set on first evaluateFrame
            this._blendDuration = blendDuration;
        } else {
            this._blendFrom = null;
            this._blendDuration = 0;
        }
        this._preset = preset ?? null;
    }

    evaluateFrame(frameState) {
        const time = frameState.t ?? 0;

        // Initialise blend start time on first frame after preset switch
        if (this._blendFrom && this._blendStartTime < 0)
            this._blendStartTime = time;

        const blendProgress = this._getBlendProgress(time);
        const preset = this._preset;
        const audio = {
            energy: 0,
            bass: 0,
            mid: 0,
            high: 0,
            beat: 0,
            decay: 0,
            ...(frameState.audio ?? {}),
        };
        const monitor = frameState.monitor ?? 0;

        let zoom = this._evaluateWave(preset?.frame?.zoom, time, monitor, DEFAULT_ZOOM, audio.energy);
        let rot = this._evaluateWave(preset?.frame?.rot, time, monitor, 0.0, audio.mid);
        let dx = this._evaluateWave(preset?.frame?.dx, time, monitor, 0.0, audio.bass);
        let dy = this._evaluateWave(preset?.frame?.dy, time, monitor, 0.0, audio.high);
        let decay = this._evaluateWave(preset?.frame?.decay, time, monitor, DEFAULT_DECAY, audio.decay);

        if (blendProgress < 1 && this._blendFrom) {
            const t = this._smoothstep(blendProgress);
            const oldZoom = this._evaluateWave(this._blendFrom?.frame?.zoom, time, monitor, DEFAULT_ZOOM, audio.energy);
            const oldRot = this._evaluateWave(this._blendFrom?.frame?.rot, time, monitor, 0.0, audio.mid);
            const oldDx = this._evaluateWave(this._blendFrom?.frame?.dx, time, monitor, 0.0, audio.bass);
            const oldDy = this._evaluateWave(this._blendFrom?.frame?.dy, time, monitor, 0.0, audio.high);
            const oldDecay = this._evaluateWave(this._blendFrom?.frame?.decay, time, monitor, DEFAULT_DECAY, audio.decay);

            zoom = oldZoom + (zoom - oldZoom) * t;
            rot = oldRot + (rot - oldRot) * t;
            dx = oldDx + (dx - oldDx) * t;
            dy = oldDy + (dy - oldDy) * t;
            decay = oldDecay + (decay - oldDecay) * t;
        }

        return {
            ...frameState,
            audio,
            presetId: preset?.id ?? 'builtin:demo-wave',
            presetName: preset?.name ?? 'Demo Wave',
            blendProgress,
            zoom,
            rot,
            dx,
            dy,
            decay,
            uniforms: {
                time,
                zoom,
                rot,
                dx,
                dy,
                decay,
                energy: audio.energy,
                bass: audio.bass,
                mid: audio.mid,
                high: audio.high,
                beat: audio.beat,
            },
        };
    }

    destroy() {
        this._preset = null;
        this._blendFrom = null;
    }

    _getBlendProgress(time) {
        if (!this._blendFrom || this._blendDuration <= 0)
            return 1;

        const elapsed = time - this._blendStartTime;
        if (elapsed >= this._blendDuration) {
            this._blendFrom = null;
            this._blendDuration = 0;
            return 1;
        }

        return Math.max(0, Math.min(1, elapsed / this._blendDuration));
    }

    _smoothstep(t) {
        return t * t * (3 - 2 * t);
    }

    _evaluateWave(spec, time, monitor, fallback, audioValue) {
        if (!spec)
            return fallback;

        const base = spec.base ?? fallback;
        const amplitude = spec.amplitude ?? 0;
        const frequency = spec.frequency ?? 0;
        const monitorPhase = spec.monitorPhase ?? 0;
        const phase = spec.phase ?? 0;
        const waveformInput = time * frequency + monitor * monitorPhase + phase;
        const wave = spec.waveform === 'cos'
            ? Math.cos(waveformInput)
            : Math.sin(waveformInput);
        const audioScale = spec.audioScale ?? 0;

        return base + amplitude * wave + audioValue * audioScale;
    }
}
