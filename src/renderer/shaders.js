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
uniform float uInvert;
uniform float uBrighten;
uniform float uDarken;
uniform float uSolarize;
uniform float uGamma;
uniform float uDarkenCenter;
uniform float uEchoZoom;
uniform float uEchoAlpha;
uniform float uEchoOrient;
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

    // MilkDrop-style post controls.
    float invertAmount = clamp(uInvert, 0.0, 1.0);
    color.rgb = mix(color.rgb, vec3(1.0) - color.rgb, invertAmount);

    color.rgb += vec3(max(uBrighten, 0.0));
    color.rgb *= max(0.0, 1.0 - uDarken);

    vec3 solarized = abs(color.rgb * 2.0 - 1.0);
    color.rgb = mix(color.rgb, solarized, clamp(uSolarize, 0.0, 1.0));

    float gamma = max(uGamma, 0.001);
    color.rgb = pow(max(color.rgb, vec3(0.0)), vec3(1.0 / gamma));

    float centerMask = 1.0 - smoothstep(0.0, 0.55, length(fromCenter));
    float centerDark = clamp(uDarkenCenter, 0.0, 1.0) * centerMask;
    color.rgb *= max(0.0, 1.0 - centerDark * 0.85);

    float echoAlpha = clamp(uEchoAlpha, 0.0, 1.0);
    if (echoAlpha > 0.0001) {
        vec2 centered = vTexCoord - vec2(0.5);
        float orient = floor(clamp(uEchoOrient, 0.0, 3.0) + 0.5);
        if (orient < 0.5) {
            centered = centered;
        } else if (orient < 1.5) {
            centered = vec2(-centered.x, centered.y);
        } else if (orient < 2.5) {
            centered = vec2(centered.x, -centered.y);
        } else {
            centered = vec2(-centered.x, -centered.y);
        }
        float echoZoom = max(uEchoZoom, 0.001);
        vec2 echoUv = clamp(centered / echoZoom + vec2(0.5), vec2(0.0), vec2(1.0));
        vec4 echoColor = texture2D(uWarpOutput, echoUv);
        color.rgb = mix(color.rgb, echoColor.rgb, echoAlpha);
    }

    gl_FragColor = clamp(color, 0.0, 1.0);
}
`;

export const BORDER_VERTEX_SHADER = `\
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    vTexCoord = aTexCoord;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const BORDER_FRAGMENT_SHADER = `\
precision mediump float;
uniform float uOBSize;
uniform vec4 uOBColor;
uniform float uIBSize;
uniform vec4 uIBColor;
varying vec2 vTexCoord;

void main() {
    float edgeDist = min(
        min(vTexCoord.x, 1.0 - vTexCoord.x),
        min(vTexCoord.y, 1.0 - vTexCoord.y)
    );

    float obSize = clamp(uOBSize, 0.0, 0.5);
    float outerMask = 1.0 - step(obSize, edgeDist);
    vec4 outer = vec4(uOBColor.rgb, clamp(uOBColor.a, 0.0, 1.0) * outerMask);

    float ibInset = clamp(uIBSize, 0.0, 0.5);
    float ibThickness = max(0.001, ibInset * 0.5);
    float innerDelta = abs(edgeDist - ibInset);
    float innerMask = 1.0 - smoothstep(ibThickness, ibThickness * 2.0, innerDelta);
    vec4 inner = vec4(uIBColor.rgb, clamp(uIBColor.a, 0.0, 1.0) * innerMask);

    gl_FragColor = vec4(mix(outer.rgb, inner.rgb, inner.a), max(outer.a, inner.a));
}
`;

export const MOTION_VECTOR_VERTEX_SHADER = `\
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    vTexCoord = aTexCoord;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const MOTION_VECTOR_FRAGMENT_SHADER = `\
precision mediump float;
uniform vec2 uMVGrid;
uniform vec2 uMVOffset;
uniform float uMVLength;
uniform vec4 uMVColor;
varying vec2 vTexCoord;

void main() {
    vec2 mvGrid = max(uMVGrid, vec2(1.0));
    vec2 cell = fract(vTexCoord * mvGrid) - vec2(0.5);
    vec2 mvOffset = vec2(uMVOffset.x, -uMVOffset.y);
    vec2 dir = normalize(mvOffset + vec2(0.0001, 0.0));
    float normalDistance = abs(dot(cell, vec2(-dir.y, dir.x)));
    float alongDistance = abs(dot(cell, dir));
    float halfLength = clamp(uMVLength, 0.0, 1.0) * 0.5;
    float lineCore = 1.0 - smoothstep(0.01, 0.03, normalDistance);
    float lineExtent = 1.0 - step(halfLength, alongDistance);
    float mask = lineCore * lineExtent;
    gl_FragColor = vec4(uMVColor.rgb, clamp(uMVColor.a, 0.0, 1.0) * mask);
}
`;

export const WAVEFORM_VERTEX_SHADER = `\
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
    vTexCoord = aTexCoord;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const WAVEFORM_FRAGMENT_SHADER = `\
precision mediump float;
uniform vec4 uWaveColor;
uniform float uWaveAlpha;
uniform float uAdditiveWave;
varying vec2 vTexCoord;

void main() {
    float alpha = clamp(uWaveAlpha, 0.0, 1.0);
    if (uAdditiveWave > 0.5)
        gl_FragColor = vec4(uWaveColor.rgb * alpha, alpha);
    else
        gl_FragColor = vec4(uWaveColor.rgb, alpha);
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
