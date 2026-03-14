/**
 * MilkDrop-style GLSL ES 2.0 shader sources for the warp and composite passes.
 *
 * Warp pass:  Samples the previous frame through a per-vertex-warped mesh.
 *             Applies decay (feedback fade) and the evaluated motion field.
 *
 * Composite:  Takes the warp output, can apply additional visual effects
 *             (tone mapping, vignette, colour adjustment) driven by uniforms.
 */

// ── Warp pass ──────────────────────────────────────────────────────

export const WARP_VERTEX_SHADER = `\
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    vTexCoord = aTexCoord;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const WARP_FRAGMENT_SHADER = `\
precision mediump float;
uniform sampler2D uPrevFrame;
uniform float uDecay;
varying vec2 vTexCoord;
void main() {
    vec2 uv = vTexCoord;
    vec4 prev = texture2D(uPrevFrame, uv);
    gl_FragColor = prev * uDecay;
}
`;

// ── Composite pass ─────────────────────────────────────────────────

export const COMPOSITE_VERTEX_SHADER = `\
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    vTexCoord = aTexCoord;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_SHADER = `\
precision mediump float;
uniform sampler2D uWarpOutput;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
varying vec2 vTexCoord;

void main() {
    vec4 color = texture2D(uWarpOutput, vTexCoord);

    // Audio-reactive brightness boost — strong enough to see with real music
    float boost = 1.0 + uEnergy * 2.0 + uBass * 1.2;
    color.rgb *= boost;

    // Subtle vignette
    vec2 fromCenter = vTexCoord - vec2(0.5);
    float vignette = 1.0 - dot(fromCenter, fromCenter) * 1.2;
    color.rgb *= clamp(vignette, 0.0, 1.0);

    // Time-based colour cycling (very subtle)
    color.r += sin(uTime * 0.4) * 0.02;
    color.g += sin(uTime * 0.3 + 1.0) * 0.02;
    color.b += sin(uTime * 0.5 + 2.0) * 0.02;

    gl_FragColor = clamp(color, 0.0, 1.0);
}
`;

// ── Default draw shader (renders initial content into a blank frame) ──

export const DEFAULT_DRAW_VERTEX_SHADER = `\
attribute vec2 aPosition;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const DEFAULT_DRAW_FRAGMENT_SHADER = `\
precision mediump float;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec2 uResolution;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    // Radial pattern driven by time and audio
    vec2 fromCenter = uv - vec2(0.5);
    float dist = length(fromCenter);
    float angle = atan(fromCenter.y, fromCenter.x);

    float wave1 = sin(dist * 12.0 - uTime * 2.0 + uBass * 6.0) * 0.5 + 0.5;
    float wave2 = sin(angle * 5.0 + uTime * 1.5 + uMid * 4.0) * 0.5 + 0.5;
    float wave3 = sin(dist * 8.0 + angle * 3.0 - uTime + uHigh * 3.0) * 0.5 + 0.5;

    // Energy drives brightness — no hard floor so silence = dark, music = bright
    float energy = 0.15 + uEnergy * 2.5;
    vec3 color = vec3(
        wave1 * 0.6 + wave3 * 0.3,
        wave2 * 0.5 + wave1 * 0.2,
        wave3 * 0.7 + wave2 * 0.2
    ) * energy;

    // Soft falloff at edges
    color *= smoothstep(0.7, 0.3, dist);

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

// ── Legacy aliases for compatibility ──

export const DEFAULT_WARP_SHADER = WARP_FRAGMENT_SHADER;
export const DEFAULT_COMPOSITE_SHADER = COMPOSITE_FRAGMENT_SHADER;
