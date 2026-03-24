import { ExpressionEvaluator } from './expr/per-frame.js';

const DEFAULT_DECAY = 0.98;
const DEFAULT_ZOOM = 1.0;

const RENDER_CONTROL_DEFAULTS = {
    cx: 0.5,
    cy: 0.5,
    sx: 1.0,
    sy: 1.0,
    zoomexp: 1.0,
    warp: 1.0,
    wrap: 1,
    echo_zoom: 1.0,
    echo_alpha: 0.0,
    echo_orient: 0,
    gamma: 1.0,
    brighten: 0,
    darken: 0,
    solarize: 0,
    invert: 0,
    darken_center: 0,
    ob_size: 0.01,
    ob_r: 0.0,
    ob_g: 0.0,
    ob_b: 0.0,
    ob_a: 0.0,
    ib_size: 0.01,
    ib_r: 0.25,
    ib_g: 0.25,
    ib_b: 0.25,
    ib_a: 0.0,
    mv_x: 12.0,
    mv_y: 9.0,
    mv_dx: 0.0,
    mv_dy: 0.0,
    mv_l: 0.9,
    mv_r: 1.0,
    mv_g: 1.0,
    mv_b: 1.0,
    mv_a: 0.0,
    wave_mode: 0,
    wave_a: 0.8,
    wave_scale: 1.0,
    wave_smoothing: 0.75,
    wave_x: 0.5,
    wave_y: 0.5,
    wave_dots: 0,
    wave_thick: 0,
    additivewave: 0,
    wave_r: 1.0,
    wave_g: 1.0,
    wave_b: 1.0,
};

function _numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function buildRenderControls(source = null) {
    const out = {};
    for (const [key, fallback] of Object.entries(RENDER_CONTROL_DEFAULTS))
        out[key] = _numberOr(source?.[key], fallback);
    return out;
}

function isExpressionPreset(preset) {
    return preset && (typeof preset.init_eqs === 'string' ||
                      typeof preset.frame_eqs === 'string' ||
                      typeof preset.pixel_eqs === 'string');
}

export class Evaluator {
    constructor() {
        this._preset = null;
        this._blendFrom = null;
        this._blendStartTime = 0;
        this._blendDuration = 0;
        this._exprEval = null;
        // Last frame's expr transform values; captured at transition start so the
        // incoming preset can smoothly interpolate away from the outgoing preset.
        this._prevExprCtx = null;
        this._blendFromExprCtx = null;
    }

    loadPreset(preset, blendDuration = 0) {
        if (blendDuration > 0 && this._preset) {
            this._blendFrom = this._preset;
            this._blendStartTime = -1; // will be set on first evaluateFrame
            this._blendDuration = blendDuration;
            // Freeze the outgoing expression context so the incoming preset can
            // interpolate smoothly from it (null when the outgoing preset was not
            // expression-based, in which case no expr blending is performed).
            this._blendFromExprCtx = this._prevExprCtx ?? null;
        } else {
            this._blendFrom = null;
            this._blendDuration = 0;
            this._blendFromExprCtx = null;
        }
        this._preset = preset ?? null;

        // Expression-based preset: compile and init
        if (isExpressionPreset(preset)) {
            if (!this._exprEval)
                this._exprEval = new ExpressionEvaluator();
            this._exprEval.loadPreset(preset);
            this._exprEval.runInit();
        } else {
            this._exprEval = null;
        }
    }

    evaluateFrame(frameState) {
        const time = frameState.t ?? 0;

        // Initialise blend start time on first frame after preset switch
        if (this._blendFrom && this._blendStartTime < 0)
            this._blendStartTime = time;

        const blendProgress = this._getBlendProgress(time);
        const preset = this._preset;
        const incomingAudio = frameState.audio ?? {};
        const audio = {
            energy: 0,
            bass: 0,
            mid: 0,
            high: 0,
            beat: 0,
            decay: 0,
            ...incomingAudio,
            high: incomingAudio.high ?? incomingAudio.treb ?? 0,
        };
        const monitor = frameState.monitor ?? 0;
        const bassAtt = audio.bass_att ?? (audio.bass * 0.7);
        const midAtt = audio.mid_att ?? (audio.mid * 0.7);
        const trebAtt = audio.treb_att ?? (audio.high * 0.7);

        // ── Expression-based preset path ──────────────────────────
        if (this._exprEval) {
            const ctx = this._exprEval.evaluateFrame({
                time,
                frame: frameState.frame ?? 0,
                fps: frameState.fps ?? 30,
                progress: frameState.progress ?? 0,
                bass: audio.bass,
                mid: audio.mid,
                treb: audio.high,
                high: audio.high,
                bass_att: bassAtt,
                mid_att: midAtt,
                treb_att: trebAtt,
                energy: audio.energy,
                beat: audio.beat,
            });

            // Blend transform properties during preset transitions.
            // _blendFromExprCtx holds the outgoing preset's last-frame values,
            // captured in loadPreset().  Without this, switching expression
            // presets produces an instant jump in zoom/rot/dx/dy/decay.
            let zoom = ctx.zoom;
            let rot  = ctx.rot;
            let dx   = ctx.dx;
            let dy   = ctx.dy;
            let decay = ctx.decay;
            if (blendProgress < 1 && this._blendFromExprCtx) {
                const prev = this._blendFromExprCtx;
                const t = this._smoothstep(blendProgress);
                zoom  = (prev.zoom  ?? ctx.zoom)  + (ctx.zoom  - (prev.zoom  ?? ctx.zoom))  * t;
                rot   = (prev.rot   ?? ctx.rot)   + (ctx.rot   - (prev.rot   ?? ctx.rot))   * t;
                dx    = (prev.dx    ?? ctx.dx)    + (ctx.dx    - (prev.dx    ?? ctx.dx))    * t;
                dy    = (prev.dy    ?? ctx.dy)    + (ctx.dy    - (prev.dy    ?? ctx.dy))    * t;
                decay = (prev.decay ?? ctx.decay) + (ctx.decay - (prev.decay ?? ctx.decay)) * t;

                // Update context so per-pixel equations also see the blended values
                ctx.zoom = zoom;
                ctx.rot = rot;
                ctx.dx = dx;
                ctx.dy = dy;
                ctx.decay = decay;
            }
            // Clear frozen blend-from context once the transition is complete.
            if (blendProgress >= 1) this._blendFromExprCtx = null;

            // Capture CURRENT final values (blended if in transition) for the next transition.
            this._prevExprCtx = { zoom, rot, dx, dy, decay };

            const renderControls = buildRenderControls(ctx);

            return {
                ...frameState,
                audio,
                presetId: preset?.id ?? null,
                presetName: preset?.name ?? null,
                blendProgress,
                zoom,
                rot,
                dx,
                dy,
                decay,
                ...renderControls,
            };
        }

        // ── Legacy WaveSpec path ──────────────────────────────────
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

        const renderControls = buildRenderControls(preset);

        // Capture CURRENT final values (blended if in transition) for the next transition.
        this._prevExprCtx = { zoom, rot, dx, dy, decay };

        return {
            ...frameState,
            audio,
            presetId: preset?.id ?? null,
            presetName: preset?.name ?? null,
            blendProgress,
            zoom,
            rot,
            dx,
            dy,
            decay,
            ...renderControls,
        };
    }

    destroy() {
        this._preset = null;
        this._blendFrom = null;
        this._exprEval = null;
        this._prevExprCtx = null;
        this._blendFromExprCtx = null;
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
