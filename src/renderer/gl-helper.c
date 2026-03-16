#define _GNU_SOURCE
#include <epoxy/egl.h>
#include <epoxy/gl.h>

#include <glib.h>
#include <gio/gio.h>
#include <gio/gunixconnection.h>
#include <gio/gunixsocketaddress.h>
#include <json-glib/json-glib.h>

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/mman.h>
#endif

#ifdef HAVE_SYSPROF
#include <sysprof-capture.h>
#define PERF_BEGIN(name) gint64 _perf_##name = g_get_monotonic_time()
#define PERF_END(name) \
    do { \
        gint64 _dur = g_get_monotonic_time() - _perf_##name; \
        sysprof_collector_mark(_perf_##name, _dur, "milkdrop", #name, NULL); \
    } while (0)
#else
#define PERF_BEGIN(name) (void)0
#define PERF_END(name) (void)0
#endif

/* ── State ─────────────────────────────────────────────────────────── */

typedef struct {
    EGLDisplay display;
    EGLContext context;
    EGLSurface surface;

    /* Default draw program (initial content) */
    GLuint draw_program;
    GLuint draw_vs;
    GLuint draw_fs;
    GLuint draw_vbo;
    GLint  draw_time_uniform;
    GLint  draw_energy_uniform;
    GLint  draw_bass_uniform;
    GLint  draw_mid_uniform;
    GLint  draw_high_uniform;
    GLint  draw_resolution_uniform;

    /* Warp pass */
    GLuint warp_program;
    GLuint warp_vs;
    GLuint warp_fs;
    GLuint warp_vbo;
    GLint  warp_decay_uniform;
    GLint  warp_prev_frame_uniform;
    GLint  warp_time_uniform;
    GLint  warp_energy_uniform;
    GLint  warp_amount_uniform;
    GLint  warp_speed_uniform;
    GLint  warp_scale_uniform;
    GLint  warp_type_uniform;
    GLint  warp_in_shader_uniform;
    GLint  warp_zoom_uniform;
    GLint  warp_rot_uniform;
    GLint  warp_dx_uniform;
    GLint  warp_dy_uniform;
    int    warp_vertex_count;

    /* Composite pass */
    GLuint comp_program;
    GLuint comp_vs;
    GLuint comp_fs;
    GLuint comp_vbo;
    GLint  comp_warp_output_uniform;
    GLint  comp_time_uniform;
    GLint  comp_energy_uniform;
    GLint  comp_bass_uniform;
    GLint  comp_mid_uniform;
    GLint  comp_high_uniform;
    GLint  comp_decay_uniform;
    GLint  comp_invert_uniform;
    GLint  comp_brighten_uniform;
    GLint  comp_darken_uniform;
    GLint  comp_solarize_uniform;
    GLint  comp_gamma_uniform;
    GLint  comp_darken_center_uniform;
    GLint  comp_echo_zoom_uniform;
    GLint  comp_echo_alpha_uniform;
    GLint  comp_echo_orient_uniform;

    /* Border overlay pass */
    GLuint border_program;
    GLuint border_vs;
    GLuint border_fs;
    GLint  border_ob_size_uniform;
    GLint  border_ob_color_uniform;
    GLint  border_ib_size_uniform;
    GLint  border_ib_color_uniform;

    /* Motion-vector overlay pass */
    GLuint mv_program;
    GLuint mv_vs;
    GLuint mv_fs;
    GLint  mv_grid_uniform;
    GLint  mv_offset_uniform;
    GLint  mv_length_uniform;
    GLint  mv_color_uniform;

    /* Waveform overlay pass */
    GLuint wave_program;
    GLuint wave_vs;
    GLuint wave_fs;
    GLuint wave_vbo;
    GLint  wave_color_uniform;
    GLint  wave_alpha_uniform;
    GLint  wave_scale_uniform;
    GLint  wave_smoothing_uniform;
    GLint  wave_pos_uniform;
    GLint  wave_mode_uniform;
    GLint  wave_mystery_uniform;
    GLint  wave_dots_uniform;
    GLint  wave_thick_uniform;
    GLint  wave_additive_uniform;
    GLint  wave_data_uniform;

    /* Custom waveform pass */
    GLuint custom_wave_vbo;
    GLfloat custom_wave_vertices[512 * 6];
    GLfloat custom_wave_colors[512 * 4];
    int custom_wave_point_count;

    /* Custom shape pass */
    GLuint custom_shape_vbo;
    GLfloat custom_shape_vertices[512];
    GLfloat custom_shape_colors[512];
    GLfloat custom_shape_uvs[512];
    int custom_shape_vertex_count;

    /* Custom shape texture support */
    GLuint custom_shape_texture;
    char texture_cache[256][256];
    int texture_cache_count;

    /* Ping-pong framebuffers */
    GLuint fbo[2];
    GLuint fbo_tex[2];
    int    current_fbo; /* index into fbo[]: 0 or 1 */

    int width;
    int height;
    int stride;
    unsigned long frame_count;
    bool initialized;
    bool program_ready;
    char *shm_socket_path;
    GSocketConnection *shm_conn;
    guchar *pixel_buffer;
    gsize pixel_buffer_size;

    /* PBO async readback (ES 3.0+ only) */
    GLuint pbo[2];
    int    cur_pbo;
    bool   pbo_ready;
    bool   pbo_supported;

    /* Persistent SHM double-buffer */
    int    shm_fd[2];
    void  *shm_map[2];
    gsize  shm_map_size;
    int    shm_cur;
} HelperState;

#define WAVE_SAMPLE_COUNT 64
#define PCM_SAMPLE_COUNT 576

/* ── Default shaders ───────────────────────────────────────────────── */

/* Draw shader: renders initial content (radial pattern) */
static const char *DEFAULT_DRAW_VS =
    "attribute vec2 aPosition;\n"
    "void main() {\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *DEFAULT_DRAW_FS =
    "precision mediump float;\n"
    "uniform float uTime;\n"
    "uniform float uEnergy;\n"
    "uniform float uBass;\n"
    "uniform float uMid;\n"
    "uniform float uHigh;\n"
    "uniform vec2 uResolution;\n"
    "void main() {\n"
    "  vec2 uv = gl_FragCoord.xy / uResolution;\n"
    "  vec2 fc = uv - vec2(0.5);\n"
    "  float dist = length(fc);\n"
    "  float angle = atan(fc.y, fc.x);\n"
    "  float w1 = sin(dist*12.0 - uTime*2.0 + uBass*6.0)*0.5+0.5;\n"
    "  float w2 = sin(angle*5.0 + uTime*1.5 + uMid*4.0)*0.5+0.5;\n"
    "  float w3 = sin(dist*8.0 + angle*3.0 - uTime + uHigh*3.0)*0.5+0.5;\n"
    "  float e = max(0.3, uEnergy);\n"
    "  vec3 c = vec3(w1*0.6+w3*0.3, w2*0.5+w1*0.2, w3*0.7+w2*0.2)*e;\n"
    "  c *= smoothstep(0.7, 0.3, dist);\n"
    "  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);\n"
    "}\n";

/* Warp pass: samples previous frame; can deform UV in vertex shader from uniforms */
static const char *WARP_VS =
    "attribute vec2 aPosition;\n"
    "attribute vec2 aTexCoord;\n"
    "uniform float uTime;\n"
    "uniform float uEnergy;\n"
    "uniform float uWarpAmount;\n"
    "uniform float uWarpSpeed;\n"
    "uniform float uWarpScale;\n"
    "uniform float uWarpType;\n"
    "uniform float uWarpInShader;\n"
    "uniform float uZoom;\n"
    "uniform float uRot;\n"
    "uniform float uDx;\n"
    "uniform float uDy;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vec2 uv = aTexCoord;\n"
    "  /* MilkDrop per-frame warp: zoom, rotate around centre, translate */\n"
    "  vec2 c = uv - vec2(0.5);\n"
    "  c /= max(uZoom, 0.001);\n"
    "  float cosR = cos(uRot);\n"
    "  float sinR = sin(uRot);\n"
    "  uv = vec2(c.x*cosR - c.y*sinR, c.x*sinR + c.y*cosR) + vec2(0.5) + vec2(uDx, uDy);\n"
    "  if (uWarpInShader > 0.5 && uWarpAmount > 0.001) {\n"
    "    float t = uTime;\n"
    "    float e = uEnergy;\n"
    "    float amount = uWarpAmount * (1.0 + e * 0.5);\n"
    "    vec2 wc = uv - vec2(0.5);\n"
    "    float dist = length(wc);\n"
    "    if (uWarpType < 0.5) {\n"
    "      float disp = sin(dist * uWarpScale * 10.0 - t * uWarpSpeed) * amount;\n"
    "      uv += wc / max(dist, 0.001) * disp;\n"
    "    } else if (uWarpType < 1.5) {\n"
    "      float angle = atan(wc.y, wc.x);\n"
    "      float twist = uWarpAmount * sin(t * uWarpSpeed) * (1.0 + e * 0.3);\n"
    "      float newAngle = angle + twist * dist * uWarpScale;\n"
    "      uv = vec2(cos(newAngle), sin(newAngle)) * dist + vec2(0.5);\n"
    "    } else {\n"
    "      amount = uWarpAmount * (1.0 + e * 0.4);\n"
    "      uv += vec2(sin(uv.y * uWarpScale * 6.28 + t * uWarpSpeed),\n"
    "                 cos(uv.x * uWarpScale * 6.28 + t * uWarpSpeed * 0.7)) * amount;\n"
    "    }\n"
    "  }\n"
    "  vTexCoord = uv;\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *WARP_FS =
    "precision mediump float;\n"
    "uniform sampler2D uPrevFrame;\n"
    "uniform float uDecay;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vec4 prev = texture2D(uPrevFrame, vTexCoord);\n"
    "  gl_FragColor = prev * uDecay;\n"
    "}\n";

/* Composite pass: final output with audio reactivity */
static const char *COMP_VS =
    "attribute vec2 aPosition;\n"
    "attribute vec2 aTexCoord;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vTexCoord = aTexCoord;\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *COMP_FS =
    "precision mediump float;\n"
"uniform sampler2D uWarpOutput;\n"
"uniform float uTime;\n"
"uniform float uEnergy;\n"
"uniform float uBass;\n"
"uniform float uInvert;\n"
"uniform float uBrighten;\n"
"uniform float uDarken;\n"
"uniform float uSolarize;\n"
"uniform float uGamma;\n"
"uniform float uDarkenCenter;\n"
"uniform float uEchoZoom;\n"
"uniform float uEchoAlpha;\n"
"uniform float uEchoOrient;\n"
"varying vec2 vTexCoord;\n"
"void main() {\n"
"  vec2 uv = vec2(vTexCoord.x, 1.0 - vTexCoord.y);\n"
"  vec4 color = texture2D(uWarpOutput, uv);\n"
    "  float boost = 1.0 + uEnergy*0.3 + uBass*0.15;\n"
    "  color.rgb *= boost;\n"
    "  vec2 fc = vTexCoord - vec2(0.5);\n"
    "  float vignette = 1.0 - dot(fc, fc)*1.2;\n"
    "  color.rgb *= clamp(vignette, 0.0, 1.0);\n"
    "  color.r += sin(uTime*0.4)*0.02;\n"
    "  color.g += sin(uTime*0.3+1.0)*0.02;\n"
    "  color.b += sin(uTime*0.5+2.0)*0.02;\n"
    "  float invertAmount = clamp(uInvert, 0.0, 1.0);\n"
    "  color.rgb = mix(color.rgb, vec3(1.0) - color.rgb, invertAmount);\n"
    "  color.rgb += vec3(max(uBrighten, 0.0));\n"
    "  color.rgb *= max(0.0, 1.0 - uDarken);\n"
    "  vec3 solarized = abs(color.rgb * 2.0 - 1.0);\n"
    "  color.rgb = mix(color.rgb, solarized, clamp(uSolarize, 0.0, 1.0));\n"
    "  float gamma = max(uGamma, 0.001);\n"
    "  color.rgb = pow(max(color.rgb, vec3(0.0)), vec3(1.0 / gamma));\n"
    "  float centerMask = 1.0 - smoothstep(0.0, 0.55, length(fc));\n"
    "  float centerDark = clamp(uDarkenCenter, 0.0, 1.0) * centerMask;\n"
    "  color.rgb *= max(0.0, 1.0 - centerDark * 0.85);\n"
    "  float echoAlpha = clamp(uEchoAlpha, 0.0, 1.0);\n"
    "  if (echoAlpha > 0.0001) {\n"
    "    vec2 centered = vTexCoord - vec2(0.5);\n"
    "    float orient = floor(clamp(uEchoOrient, 0.0, 3.0) + 0.5);\n"
    "    if (orient < 0.5) {\n"
    "      centered = centered;\n"
    "    } else if (orient < 1.5) {\n"
    "      centered = vec2(-centered.x, centered.y);\n"
    "    } else if (orient < 2.5) {\n"
    "      centered = vec2(centered.x, -centered.y);\n"
    "    } else {\n"
    "      centered = vec2(-centered.x, -centered.y);\n"
    "    }\n"
    "    float echoZoom = max(uEchoZoom, 0.001);\n"
    "    vec2 echoUv = clamp(centered / echoZoom + vec2(0.5), vec2(0.0), vec2(1.0));\n"
    "    vec4 echoColor = texture2D(uWarpOutput, echoUv);\n"
    "    color.rgb = mix(color.rgb, echoColor.rgb, echoAlpha);\n"
    "  }\n"
    "  gl_FragColor = clamp(color, 0.0, 1.0);\n"
    "}\n";

static const char *BORDER_VS =
    "attribute vec2 aPosition;\n"
    "attribute vec2 aTexCoord;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vTexCoord = aTexCoord;\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *BORDER_FS =
    "precision mediump float;\n"
    "uniform float uOBSize;\n"
    "uniform vec4 uOBColor;\n"
    "uniform float uIBSize;\n"
    "uniform vec4 uIBColor;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  float edgeDist = min(min(vTexCoord.x, 1.0 - vTexCoord.x), min(vTexCoord.y, 1.0 - vTexCoord.y));\n"
    "  float obSize = clamp(uOBSize, 0.0, 0.5);\n"
    "  float outerMask = 1.0 - step(obSize, edgeDist);\n"
    "  vec4 outer = vec4(uOBColor.rgb, clamp(uOBColor.a, 0.0, 1.0) * outerMask);\n"
    "  float ibInset = clamp(uIBSize, 0.0, 0.5);\n"
    "  float ibThickness = max(0.001, ibInset * 0.5);\n"
    "  float innerDelta = abs(edgeDist - ibInset);\n"
    "  float innerMask = 1.0 - smoothstep(ibThickness, ibThickness * 2.0, innerDelta);\n"
    "  vec4 inner = vec4(uIBColor.rgb, clamp(uIBColor.a, 0.0, 1.0) * innerMask);\n"
    "  gl_FragColor = vec4(mix(outer.rgb, inner.rgb, inner.a), max(outer.a, inner.a));\n"
    "}\n";

static const char *MV_VS =
    "attribute vec2 aPosition;\n"
    "attribute vec2 aTexCoord;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vTexCoord = aTexCoord;\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *MV_FS =
    "precision mediump float;\n"
    "uniform vec2 uMVGrid;\n"
    "uniform vec2 uMVOffset;\n"
    "uniform float uMVLength;\n"
    "uniform vec4 uMVColor;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vec2 mvGrid = max(uMVGrid, vec2(1.0));\n"
    "  vec2 cell = fract(vTexCoord * mvGrid) - vec2(0.5);\n"
    "  vec2 mvOffset = vec2(uMVOffset.x, -uMVOffset.y);\n"
    "  vec2 dir = normalize(mvOffset + vec2(0.0001, 0.0));\n"
    "  float normalDistance = abs(dot(cell, vec2(-dir.y, dir.x)));\n"
    "  float alongDistance = abs(dot(cell, dir));\n"
    "  float halfLength = clamp(uMVLength, 0.0, 1.0) * 0.5;\n"
    "  float lineCore = 1.0 - smoothstep(0.01, 0.03, normalDistance);\n"
    "  float lineExtent = 1.0 - step(halfLength, alongDistance);\n"
    "  float mask = lineCore * lineExtent;\n"
    "  gl_FragColor = vec4(uMVColor.rgb, clamp(uMVColor.a, 0.0, 1.0) * mask);\n"
    "}\n";

static const char *WAVE_VS =
    "attribute vec2 aPosition;\n"
    "attribute vec2 aTexCoord;\n"
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vTexCoord = aTexCoord;\n"
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n"
    "}\n";

static const char *WAVE_FS =
    "precision mediump float;\n"
    "uniform vec4 uWaveColor;\n"
    "uniform float uWaveAlpha;\n"
    "uniform float uAdditiveWave;\n"
    "void main() {\n"
    "  float alpha = clamp(uWaveAlpha, 0.0, 1.0);\n"
    "  if (uAdditiveWave > 0.5)\n"
    "    gl_FragColor = vec4(uWaveColor.rgb * alpha, alpha);\n"
    "  else\n"
    "    gl_FragColor = vec4(uWaveColor.rgb, alpha);\n"
    "}\n";

/* ── Full-screen quad for composite/draw ───────────────────────────── */
static const GLfloat FULLSCREEN_QUAD[] = {
    /* pos.x  pos.y  u    v  */
    -1.0f, -1.0f,  0.0f, 0.0f,
     1.0f, -1.0f,  1.0f, 0.0f,
    -1.0f,  1.0f,  0.0f, 1.0f,
     1.0f, -1.0f,  1.0f, 0.0f,
     1.0f,  1.0f,  1.0f, 1.0f,
    -1.0f,  1.0f,  0.0f, 1.0f,
};
static const int FULLSCREEN_QUAD_VERTEX_COUNT = 6;

/* ── Telemetry / output helpers ─────────────────────────────────────── */

static void
emit_telemetry(const char *stage, const char *level, const char *msg, int ok)
{
    printf("{\"type\":\"telemetry\",\"stage\":\"%s\",\"level\":\"%s\",\"ok\":%s,\"msg\":\"%s\"}\n",
        stage,
        level,
        ok ? "true" : "false",
        msg ? msg : "");
    fflush(stdout);
}

static void
emit_shader_error(const char *stage, const char *msg)
{
    printf("{\"type\":\"shader_error\",\"stage\":\"%s\",\"msg\":\"%s\"}\n",
        stage,
        msg ? msg : "unknown shader error");
    fflush(stdout);
}

static void
emit_frame_stat(unsigned long frame_count, double time_value,
                gint64 render_us, gint64 readback_us)
{
    printf("{\"type\":\"frame-stat\",\"frame_count\":%lu,\"time\":%.6f,\"render_us\":%" G_GINT64_FORMAT ",\"readback_us\":%" G_GINT64_FORMAT "}\n",
        frame_count,
        time_value,
        render_us,
        readback_us);
    fflush(stdout);
}

/**
 * Send frame pixels via shared memory: write to memfd, send fd over Unix socket,
 * then emit frame-pixels-fd JSON on stdout. Returns true on success.
 */
static void
close_shm_connection(HelperState *state)
{
    if (!state || !state->shm_conn)
        return;

    g_object_unref(state->shm_conn);
    state->shm_conn = NULL;
}

static bool
ensure_shm_connection(HelperState *state)
{
    if (!state || !state->shm_socket_path)
        return false;

    if (state->shm_conn)
        return true;

    GError *err = NULL;
    GSocketClient *client = g_socket_client_new();
    GSocketConnectable *addr = G_SOCKET_CONNECTABLE(g_unix_socket_address_new(state->shm_socket_path));
    GSocketConnection *conn = g_socket_client_connect(client, addr, NULL, &err);
    g_object_unref(addr);
    g_object_unref(client);
    if (!conn) {
        if (err) {
            emit_telemetry("shm_connect", "warn", err->message, 0);
            g_error_free(err);
        }
        return false;
    }

    state->shm_conn = conn;
    GSocket *socket = g_socket_connection_get_socket(conn);
    if (socket)
        g_socket_set_timeout(socket, 1);
    return true;
}

static bool
emit_frame_pixels_shm_fd(HelperState *state, int memfd, unsigned long frame_count, int width, int height, int stride)
{
#ifdef __linux__
    if (!ensure_shm_connection(state))
        return false;

    GError *err = NULL;
    gboolean ok = g_unix_connection_send_fd(G_UNIX_CONNECTION(state->shm_conn), memfd, NULL, &err);
    if (!ok) {
        if (err) {
            emit_telemetry("shm_send_fd", "warn", err->message, 0);
            g_error_free(err);
            err = NULL;
        }
        close_shm_connection(state);

        if (!ensure_shm_connection(state))
            return false;

        ok = g_unix_connection_send_fd(G_UNIX_CONNECTION(state->shm_conn), memfd, NULL, &err);
        if (!ok) {
            if (err) {
                emit_telemetry("shm_send_fd", "warn", err->message, 0);
                g_error_free(err);
            }
            close_shm_connection(state);
            return false;
        }
    }

    printf("{\"type\":\"frame-pixels-fd\",\"frame\":%lu,\"width\":%d,\"height\":%d,\"stride\":%d,\"format\":\"rgba8\"}\n",
        frame_count, width, height, stride);
    fflush(stdout);
    return true;
#else
    (void)state;
    (void)memfd;
    (void)frame_count;
    (void)width;
    (void)height;
    (void)stride;
    return false;
#endif
}

/* Base64 transport cap: frames larger than this are too big for a single
 * JSON line over a pipe (risk of deadlock / OOM).  Callers should use SHM. */
#define BASE64_MAX_RAW_BYTES (4u * 1024u * 1024u)

static void
emit_frame_pixels_base64(const guchar *pixels, gsize pixel_count, unsigned long frame_count, int width, int height, int stride)
{
    if (pixel_count > BASE64_MAX_RAW_BYTES) {
        emit_telemetry("readback", "warn",
                       "frame too large for base64 transport, enable SHM", 0);
        return;
    }
    gchar *encoded = g_base64_encode(pixels, pixel_count);
    printf("{\"type\":\"frame-pixels\",\"frame\":%lu,\"width\":%d,\"height\":%d,\"stride\":%d,\"format\":\"rgba8\",\"data\":\"%s\"}\n",
        frame_count,
        width,
        height,
        stride,
        encoded ? encoded : "");
    fflush(stdout);
    g_free(encoded);
}

/* ── JSON parsing (json-glib) ───────────────────────────────────────── */

/**
 * Parse a newline-terminated JSON line into a JsonObject.
 * Caller must g_object_unref(result). Returns NULL on parse error.
 */
static JsonObject *
parse_message_line(const char *line)
{
    GError *err = NULL;
    JsonParser *parser = json_parser_new();
    if (!json_parser_load_from_data(parser, line, -1, &err)) {
        if (err) {
            emit_telemetry("json_parse", "warn", err->message, 0);
            g_error_free(err);
        }
        g_object_unref(parser);
        return NULL;
    }
    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        g_object_unref(parser);
        return NULL;
    }
    JsonObject *obj = json_node_dup_object(root);
    g_object_unref(parser);
    return obj;
}

static bool
message_has_type(JsonObject *obj, const char *type)
{
    if (!obj || !json_object_has_member(obj, "type"))
        return false;
    const char *t = json_object_get_string_member(obj, "type");
    return t && g_str_equal(t, type);
}

static double
get_double(JsonObject *obj, const char *key, double fallback)
{
    if (!obj || !json_object_has_member(obj, key))
        return fallback;
    return json_object_get_double_member(obj, key);
}

static int
get_int(JsonObject *obj, const char *key, int fallback)
{
    if (!obj || !json_object_has_member(obj, key))
        return fallback;
    return (int)json_object_get_int_member(obj, key);
}

/**
 * Get string member; returns newly-allocated string (caller g_free) or NULL.
 */
static gchar *
get_string_dup(JsonObject *obj, const char *key)
{
    if (!obj || !json_object_has_member(obj, key))
        return NULL;
    const char *s = json_object_get_string_member(obj, key);
    return s ? g_strdup(s) : NULL;
}

static void
load_shape_texture(HelperState *state, const char *filename)
{
    if (!filename || strlen(filename) == 0)
        return;

    /* Check cache */
    for (int i = 0; i < state->texture_cache_count; i++) {
        if (strcmp(state->texture_cache[i], filename) == 0) {
            return;
        }
    }

    /* Add to cache */
    if (state->texture_cache_count < 256) {
        strncpy(state->texture_cache[state->texture_cache_count], filename, 255);
        state->texture_cache[state->texture_cache_count][255] = '\0';
        state->texture_cache_count++;
    }

    /* Texture loading requires gdk-pixbuf which is not linked */
    /* For now, log the texture request and create a placeholder */
    g_debug("Custom shape texture requested: '%s' (not loaded - gdk-pixbuf not available)", filename);

    /* Create a placeholder gradient texture */
    glBindTexture(GL_TEXTURE_2D, state->custom_shape_texture);
    
    /* Create a simple 2x2 gradient placeholder texture */
    GLubyte placeholder[] = {
        255, 0, 0, 255,    /* Red */
        0, 255, 0, 255,    /* Green */
        0, 0, 255, 255,    /* Blue */
        255, 255, 0, 255,   /* Yellow */
    };
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, placeholder);
}

static int
parse_wave_data(JsonObject *obj, GLfloat out[WAVE_SAMPLE_COUNT])
{
    for (int i = 0; i < WAVE_SAMPLE_COUNT; i++)
        out[i] = 0.0f;

    if (!obj || !json_object_has_member(obj, "wave_data"))
        return 0;

    JsonArray *arr = json_object_get_array_member(obj, "wave_data");
    if (!arr)
        return 0;

    guint len = json_array_get_length(arr);
    int count = (int)MIN((guint)WAVE_SAMPLE_COUNT, len);
    for (int i = 0; i < count; i++) {
        double sample = json_array_get_double_element(arr, i);
        if (!isfinite(sample))
            sample = 0.0;
        if (sample < 0.0)
            sample = 0.0;
        if (sample > 1.0)
            sample = 1.0;
        out[i] = (GLfloat)sample;
    }

    return count;
}

static int
parse_pcm_data(JsonObject *obj, const char *key, GLfloat out[PCM_SAMPLE_COUNT])
{
    for (int i = 0; i < PCM_SAMPLE_COUNT; i++)
        out[i] = 0.0f;

    if (!obj || !json_object_has_member(obj, key))
        return 0;

    JsonArray *arr = json_object_get_array_member(obj, key);
    if (!arr)
        return 0;

    guint len = json_array_get_length(arr);
    int count = (int)MIN((guint)PCM_SAMPLE_COUNT, len);
    for (int i = 0; i < count; i++) {
        double sample = json_array_get_double_element(arr, i);
        if (!isfinite(sample))
            sample = 0.0;
        out[i] = (GLfloat)sample;
    }

    return count;
}

/* ── GL resource cleanup ──────────────────────────────────────────── */

static void
delete_program(GLuint *program, GLuint *vs, GLuint *fs)
{
    if (*program) { glDeleteProgram(*program); *program = 0; }
    if (*vs)      { glDeleteShader(*vs);       *vs = 0; }
    if (*fs)      { glDeleteShader(*fs);       *fs = 0; }
}

static void
destroy_programs(HelperState *state)
{
    delete_program(&state->draw_program, &state->draw_vs, &state->draw_fs);
    if (state->draw_vbo) { glDeleteBuffers(1, &state->draw_vbo); state->draw_vbo = 0; }

    delete_program(&state->warp_program, &state->warp_vs, &state->warp_fs);
    if (state->warp_vbo) { glDeleteBuffers(1, &state->warp_vbo); state->warp_vbo = 0; }
    state->warp_vertex_count = 0;

    delete_program(&state->comp_program, &state->comp_vs, &state->comp_fs);
    if (state->comp_vbo) { glDeleteBuffers(1, &state->comp_vbo); state->comp_vbo = 0; }

    delete_program(&state->border_program, &state->border_vs, &state->border_fs);
    delete_program(&state->mv_program, &state->mv_vs, &state->mv_fs);
    delete_program(&state->wave_program, &state->wave_vs, &state->wave_fs);

    for (int i = 0; i < 2; i++) {
        if (state->fbo[i])     { glDeleteFramebuffers(1, &state->fbo[i]);  state->fbo[i] = 0; }
        if (state->fbo_tex[i]) { glDeleteTextures(1, &state->fbo_tex[i]);  state->fbo_tex[i] = 0; }
    }
    state->current_fbo = 0;
    state->program_ready = false;
}

static void
shutdown_helper(HelperState *state)
{
    destroy_programs(state);

    /* PBO cleanup (requires GL context) */
    if (state->pbo_supported) {
        glDeleteBuffers(2, state->pbo);
        state->pbo[0] = state->pbo[1] = 0;
        state->pbo_supported = false;
        state->pbo_ready = false;
    }

    if (state->display != EGL_NO_DISPLAY) {
        eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (state->context != EGL_NO_CONTEXT)
            eglDestroyContext(state->display, state->context);
        if (state->surface != EGL_NO_SURFACE)
            eglDestroySurface(state->display, state->surface);
        eglTerminate(state->display);
    }

    state->display = EGL_NO_DISPLAY;
    state->context = EGL_NO_CONTEXT;
    state->surface = EGL_NO_SURFACE;
    state->initialized = false;

    /* Persistent SHM cleanup */
#ifdef __linux__
    for (int i = 0; i < 2; i++) {
        if (state->shm_map[i]) {
            munmap(state->shm_map[i], state->shm_map_size);
            state->shm_map[i] = NULL;
        }
        if (state->shm_fd[i] >= 0) {
            close(state->shm_fd[i]);
            state->shm_fd[i] = -1;
        }
    }
    state->shm_map_size = 0;
#endif

    close_shm_connection(state);
    g_free(state->pixel_buffer);
    state->pixel_buffer = NULL;
    state->pixel_buffer_size = 0;
}

/* ── Shader compilation ────────────────────────────────────────────── */

static bool
compile_shader(GLuint shader, const char *source, const char *stage)
{
    GLint status = GL_FALSE;
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    glGetShaderiv(shader, GL_COMPILE_STATUS, &status);
    if (status == GL_TRUE)
        return true;

    char info_log[1024] = {0};
    glGetShaderInfoLog(shader, (GLsizei)sizeof info_log, NULL, info_log);
    emit_shader_error(stage, info_log);
    return false;
}

static bool
link_program(GLuint program, const char *stage)
{
    GLint linked = GL_FALSE;
    glLinkProgram(program);
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (linked == GL_TRUE)
        return true;

    char info_log[1024] = {0};
    glGetProgramInfoLog(program, (GLsizei)sizeof info_log, NULL, info_log);
    emit_shader_error(stage, info_log);
    return false;
}

static GLuint
build_program(const char *vs_src, const char *fs_src,
              GLuint *out_vs, GLuint *out_fs, const char *stage)
{
    *out_vs = glCreateShader(GL_VERTEX_SHADER);
    *out_fs = glCreateShader(GL_FRAGMENT_SHADER);

    if (!compile_shader(*out_vs, vs_src, stage)) return 0;
    if (!compile_shader(*out_fs, fs_src, stage)) return 0;

    GLuint prog = glCreateProgram();
    glAttachShader(prog, *out_vs);
    glAttachShader(prog, *out_fs);
    glBindAttribLocation(prog, 0, "aPosition");
    glBindAttribLocation(prog, 1, "aTexCoord");
    if (!link_program(prog, stage)) { glDeleteProgram(prog); return 0; }
    return prog;
}

/* ── Framebuffer creation ──────────────────────────────────────────── */

static bool
create_fbo(GLuint *fbo, GLuint *tex, int width, int height)
{
    glGenTextures(1, tex);
    glBindTexture(GL_TEXTURE_2D, *tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glGenFramebuffers(1, fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, *fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *tex, 0);

    GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
        emit_telemetry("fbo_init", "error", "framebuffer incomplete", 0);
        return false;
    }
    return true;
}

/* ── EGL initialisation ────────────────────────────────────────────── */

static bool
initialize_egl(HelperState *state, int width, int height)
{
    const EGLint config_attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    /* Try ES 3.0 first (enables PBO async readback), fall back to ES 2.0 */
    const EGLint ctx_attr_3[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
    const EGLint ctx_attr_2[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    EGLint pbuffer_attributes[] = {
        EGL_WIDTH, width > 0 ? width : 1,
        EGL_HEIGHT, height > 0 ? height : 1,
        EGL_NONE,
    };

    state->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (state->display == EGL_NO_DISPLAY) {
        emit_telemetry("helper_init", "error", "eglGetDisplay failed", 0);
        return false;
    }

    if (!eglInitialize(state->display, NULL, NULL)) {
        emit_telemetry("helper_init", "error", "eglInitialize failed", 0);
        return false;
    }

    if (!eglBindAPI(EGL_OPENGL_ES_API)) {
        emit_telemetry("helper_init", "error", "eglBindAPI failed", 0);
        return false;
    }

    EGLConfig config = NULL;
    EGLint config_count = 0;
    if (!eglChooseConfig(state->display, config_attributes, &config, 1, &config_count) || config_count < 1) {
        emit_telemetry("helper_init", "error", "eglChooseConfig failed", 0);
        return false;
    }

    pbuffer_attributes[1] = width > 0 ? width : 1;
    pbuffer_attributes[3] = height > 0 ? height : 1;
    state->surface = eglCreatePbufferSurface(state->display, config, pbuffer_attributes);
    if (state->surface == EGL_NO_SURFACE) {
        emit_telemetry("helper_init", "error", "eglCreatePbufferSurface failed", 0);
        return false;
    }

    state->context = eglCreateContext(state->display, config, EGL_NO_CONTEXT, ctx_attr_3);
    if (state->context == EGL_NO_CONTEXT)
        state->context = eglCreateContext(state->display, config, EGL_NO_CONTEXT, ctx_attr_2);
    if (state->context == EGL_NO_CONTEXT) {
        emit_telemetry("helper_init", "error", "eglCreateContext failed", 0);
        return false;
    }

    if (!eglMakeCurrent(state->display, state->surface, state->surface, state->context)) {
        emit_telemetry("helper_init", "error", "eglMakeCurrent failed", 0);
        return false;
    }

    state->width = width;
    state->height = height;
    state->stride = (int)((gsize)(width > 0 ? width : 1) * 4);
    state->initialized = true;

    const gsize need = (gsize)state->stride * (gsize)state->height;
    if (need > state->pixel_buffer_size) {
        g_free(state->pixel_buffer);
        state->pixel_buffer = g_malloc(need);
        state->pixel_buffer_size = state->pixel_buffer ? need : 0;
    }

    /* PBO async readback — requires ES 3.0+ for GL_PIXEL_PACK_BUFFER */
    state->pbo_supported = (epoxy_gl_version() >= 30);
    if (state->pbo_supported) {
        glGenBuffers(2, state->pbo);
        for (int i = 0; i < 2; i++) {
            glBindBuffer(GL_PIXEL_PACK_BUFFER, state->pbo[i]);
            glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)need, NULL, GL_STREAM_READ);
        }
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        state->cur_pbo = 0;
        state->pbo_ready = false;
    }

    /* Persistent SHM double-buffer — avoids per-frame memfd_create overhead */
#ifdef __linux__
    if (state->shm_socket_path) {
        for (int i = 0; i < 2; i++) {
            state->shm_fd[i] = memfd_create("milkdrop-frame", MFD_CLOEXEC);
            if (state->shm_fd[i] >= 0 && ftruncate(state->shm_fd[i], (off_t)need) == 0) {
                state->shm_map[i] = mmap(NULL, need, PROT_READ | PROT_WRITE,
                                         MAP_SHARED, state->shm_fd[i], 0);
                if (state->shm_map[i] == MAP_FAILED)
                    state->shm_map[i] = NULL;
            }
            if (!state->shm_map[i] && state->shm_fd[i] >= 0) {
                close(state->shm_fd[i]);
                state->shm_fd[i] = -1;
            }
        }
        state->shm_map_size = need;
        state->shm_cur = 0;
    }
#endif

    const GLubyte *renderer = glGetString(GL_RENDERER);
    const char *renderer_name = renderer ? (const char *)renderer : "unknown";
    printf("{\"type\":\"telemetry\",\"stage\":\"helper_init\",\"level\":\"info\",\"ok\":true,\"renderer\":\"%s\"}\n",
        renderer_name);
    fflush(stdout);
    return true;
}

/* ── Compile with custom shader sources ────────────────────────────── */

static bool
compile_custom_program(HelperState *state,
                       const char *custom_draw_fs,
                       const char *custom_warp_fs,
                       const char *custom_comp_fs)
{
    destroy_programs(state);

    /* Draw program */
    const char *draw_fs = (custom_draw_fs && *custom_draw_fs) ? custom_draw_fs : DEFAULT_DRAW_FS;
    state->draw_program = build_program(DEFAULT_DRAW_VS, draw_fs,
                                        &state->draw_vs, &state->draw_fs, "draw");
    if (!state->draw_program) {
        /* Fall back to default on shader error */
        emit_telemetry("draw_compile", "warn", "custom draw shader failed, using default", 0);
        state->draw_program = build_program(DEFAULT_DRAW_VS, DEFAULT_DRAW_FS,
                                            &state->draw_vs, &state->draw_fs, "draw_fallback");
        if (!state->draw_program)
            return false;
    }

    state->draw_time_uniform       = glGetUniformLocation(state->draw_program, "uTime");
    state->draw_energy_uniform     = glGetUniformLocation(state->draw_program, "uEnergy");
    state->draw_bass_uniform       = glGetUniformLocation(state->draw_program, "uBass");
    state->draw_mid_uniform        = glGetUniformLocation(state->draw_program, "uMid");
    state->draw_high_uniform       = glGetUniformLocation(state->draw_program, "uHigh");
    state->draw_resolution_uniform = glGetUniformLocation(state->draw_program, "uResolution");

    glGenBuffers(1, &state->draw_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->draw_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(FULLSCREEN_QUAD), FULLSCREEN_QUAD, GL_STATIC_DRAW);

    /* Warp program */
    const char *warp_fs = (custom_warp_fs && *custom_warp_fs) ? custom_warp_fs : WARP_FS;
    state->warp_program = build_program(WARP_VS, warp_fs,
                                        &state->warp_vs, &state->warp_fs, "warp");
    if (!state->warp_program) {
        emit_telemetry("warp_compile", "warn", "custom warp shader failed, using default", 0);
        state->warp_program = build_program(WARP_VS, WARP_FS,
                                            &state->warp_vs, &state->warp_fs, "warp_fallback");
        if (!state->warp_program)
            return false;
    }

    state->warp_decay_uniform       = glGetUniformLocation(state->warp_program, "uDecay");
    state->warp_prev_frame_uniform  = glGetUniformLocation(state->warp_program, "uPrevFrame");
    state->warp_time_uniform        = glGetUniformLocation(state->warp_program, "uTime");
    state->warp_energy_uniform     = glGetUniformLocation(state->warp_program, "uEnergy");
    state->warp_amount_uniform     = glGetUniformLocation(state->warp_program, "uWarpAmount");
    state->warp_speed_uniform      = glGetUniformLocation(state->warp_program, "uWarpSpeed");
    state->warp_scale_uniform      = glGetUniformLocation(state->warp_program, "uWarpScale");
    state->warp_type_uniform       = glGetUniformLocation(state->warp_program, "uWarpType");
    state->warp_in_shader_uniform  = glGetUniformLocation(state->warp_program, "uWarpInShader");
    state->warp_zoom_uniform          = glGetUniformLocation(state->warp_program, "uZoom");
    state->warp_rot_uniform           = glGetUniformLocation(state->warp_program, "uRot");
    state->warp_dx_uniform            = glGetUniformLocation(state->warp_program, "uDx");
    state->warp_dy_uniform            = glGetUniformLocation(state->warp_program, "uDy");

    glGenBuffers(1, &state->warp_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->warp_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(FULLSCREEN_QUAD), FULLSCREEN_QUAD, GL_STATIC_DRAW);
    state->warp_vertex_count = FULLSCREEN_QUAD_VERTEX_COUNT;

    /* Composite program */
    const char *comp_fs = (custom_comp_fs && *custom_comp_fs) ? custom_comp_fs : COMP_FS;
    state->comp_program = build_program(COMP_VS, comp_fs,
                                        &state->comp_vs, &state->comp_fs, "composite");
    if (!state->comp_program) {
        emit_telemetry("comp_compile", "warn", "custom composite shader failed, using default", 0);
        state->comp_program = build_program(COMP_VS, COMP_FS,
                                            &state->comp_vs, &state->comp_fs, "composite_fallback");
        if (!state->comp_program)
            return false;
    }

    state->comp_warp_output_uniform = glGetUniformLocation(state->comp_program, "uWarpOutput");
    state->comp_time_uniform        = glGetUniformLocation(state->comp_program, "uTime");
    state->comp_energy_uniform      = glGetUniformLocation(state->comp_program, "uEnergy");
    state->comp_bass_uniform        = glGetUniformLocation(state->comp_program, "uBass");
    state->comp_mid_uniform         = glGetUniformLocation(state->comp_program, "uMid");
    state->comp_high_uniform        = glGetUniformLocation(state->comp_program, "uHigh");
    state->comp_decay_uniform       = glGetUniformLocation(state->comp_program, "uDecay");
    state->comp_invert_uniform      = glGetUniformLocation(state->comp_program, "uInvert");
    state->comp_brighten_uniform    = glGetUniformLocation(state->comp_program, "uBrighten");
    state->comp_darken_uniform      = glGetUniformLocation(state->comp_program, "uDarken");
    state->comp_solarize_uniform    = glGetUniformLocation(state->comp_program, "uSolarize");
    state->comp_gamma_uniform       = glGetUniformLocation(state->comp_program, "uGamma");
    state->comp_darken_center_uniform = glGetUniformLocation(state->comp_program, "uDarkenCenter");
    state->comp_echo_zoom_uniform   = glGetUniformLocation(state->comp_program, "uEchoZoom");
    state->comp_echo_alpha_uniform  = glGetUniformLocation(state->comp_program, "uEchoAlpha");
    state->comp_echo_orient_uniform = glGetUniformLocation(state->comp_program, "uEchoOrient");

    state->border_program = build_program(BORDER_VS, BORDER_FS,
                                          &state->border_vs, &state->border_fs, "border");
    if (!state->border_program)
        return false;

    state->border_ob_size_uniform = glGetUniformLocation(state->border_program, "uOBSize");
    state->border_ob_color_uniform = glGetUniformLocation(state->border_program, "uOBColor");
    state->border_ib_size_uniform = glGetUniformLocation(state->border_program, "uIBSize");
    state->border_ib_color_uniform = glGetUniformLocation(state->border_program, "uIBColor");

    state->mv_program = build_program(MV_VS, MV_FS,
                                      &state->mv_vs, &state->mv_fs, "motion_vectors");
    if (!state->mv_program)
        return false;

    state->mv_grid_uniform = glGetUniformLocation(state->mv_program, "uMVGrid");
    state->mv_offset_uniform = glGetUniformLocation(state->mv_program, "uMVOffset");
    state->mv_length_uniform = glGetUniformLocation(state->mv_program, "uMVLength");
    state->mv_color_uniform = glGetUniformLocation(state->mv_program, "uMVColor");

    state->wave_program = build_program(WAVE_VS, WAVE_FS,
                                        &state->wave_vs, &state->wave_fs, "waveform");
    if (!state->wave_program)
        return false;

    state->wave_color_uniform = glGetUniformLocation(state->wave_program, "uWaveColor");
    state->wave_alpha_uniform = glGetUniformLocation(state->wave_program, "uWaveAlpha");
    state->wave_scale_uniform = glGetUniformLocation(state->wave_program, "uWaveScale");
    state->wave_smoothing_uniform = glGetUniformLocation(state->wave_program, "uWaveSmoothing");
    state->wave_pos_uniform = glGetUniformLocation(state->wave_program, "uWavePos");
    state->wave_mode_uniform = glGetUniformLocation(state->wave_program, "uWaveMode");
    state->wave_mystery_uniform = glGetUniformLocation(state->wave_program, "uWaveMystery");
    state->wave_dots_uniform = glGetUniformLocation(state->wave_program, "uWaveDots");
    state->wave_thick_uniform = glGetUniformLocation(state->wave_program, "uWaveThick");
    state->wave_additive_uniform = glGetUniformLocation(state->wave_program, "uAdditiveWave");
    state->wave_data_uniform = glGetUniformLocation(state->wave_program, "uWaveData");

    glGenBuffers(1, &state->wave_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->wave_vbo);
    glBufferData(GL_ARRAY_BUFFER, PCM_SAMPLE_COUNT * 2 * sizeof(GLfloat), NULL, GL_DYNAMIC_DRAW);

    glGenBuffers(1, &state->custom_wave_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->custom_wave_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(state->custom_wave_vertices), NULL, GL_DYNAMIC_DRAW);

    glGenBuffers(1, &state->custom_shape_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->custom_shape_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(state->custom_shape_vertices), NULL, GL_DYNAMIC_DRAW);

    /* Initialize custom shape texture */
    state->custom_shape_texture = 0;
    glGenTextures(1, &state->custom_shape_texture);
    glBindTexture(GL_TEXTURE_2D, state->custom_shape_texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    state->texture_cache_count = 0;

    glGenBuffers(1, &state->comp_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, state->comp_vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(FULLSCREEN_QUAD), FULLSCREEN_QUAD, GL_STATIC_DRAW);

    /* Ping-pong framebuffers */
    for (int i = 0; i < 2; i++) {
        if (!create_fbo(&state->fbo[i], &state->fbo_tex[i], state->width, state->height))
            return false;
    }
    state->current_fbo = 0;

    for (int i = 0; i < 2; i++) {
        glBindFramebuffer(GL_FRAMEBUFFER, state->fbo[i]);
        /* alpha=0 so the warp pass is transparent on the first frame,
         * letting the draw pass content show through unobstructed. */
        glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    state->program_ready = true;
    emit_telemetry("program_ready", "info", "shader pipeline compiled", 1);
    return true;
}

/* ── Compile all programs ──────────────────────────────────────────── */

static bool
compile_default_program(HelperState *state)
{
    return compile_custom_program(state, NULL, NULL, NULL);
}

/* ── Upload warp mesh ──────────────────────────────────────────────── */

static void
upload_mesh(HelperState *state, JsonObject *obj)
{
    gchar *b64 = get_string_dup(obj, "data");
    if (!b64) {
        emit_telemetry("mesh_upload", "warn", "no data field in mesh message", 0);
        return;
    }

    gsize decoded_len = 0;
    guchar *decoded = g_base64_decode(b64, &decoded_len);
    g_free(b64);

    if (!decoded || decoded_len < 16) {
        emit_telemetry("mesh_upload", "warn", "mesh data too small", 0);
        g_free(decoded);
        return;
    }

    int vertex_count = get_int(obj, "vertexCount", 0);
    if (vertex_count <= 0)
        vertex_count = (int)(decoded_len / (4 * sizeof(float)));

    gsize expected = (gsize)vertex_count * 4 * sizeof(float);
    if (decoded_len < expected) {
        emit_telemetry("mesh_upload", "warn", "mesh data smaller than declared vertexCount", 0);
        g_free(decoded);
        return;
    }

    glBindBuffer(GL_ARRAY_BUFFER, state->warp_vbo);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)decoded_len, decoded, GL_DYNAMIC_DRAW);
    state->warp_vertex_count = vertex_count;
    g_free(decoded);

    emit_telemetry("mesh_upload", "info", "mesh uploaded", 1);
}

static void
render_border_overlay(HelperState *state,
                      double ob_size, double ob_r, double ob_g, double ob_b, double ob_a,
                      double ib_size, double ib_r, double ib_g, double ib_b, double ib_a)
{
    if (!state->border_program)
        return;
    if (ob_a <= 0.0001 && ib_a <= 0.0001)
        return;

    glUseProgram(state->border_program);
    if (state->border_ob_size_uniform >= 0)
        glUniform1f(state->border_ob_size_uniform, (GLfloat)ob_size);
    if (state->border_ob_color_uniform >= 0)
        glUniform4f(state->border_ob_color_uniform, (GLfloat)ob_r, (GLfloat)ob_g, (GLfloat)ob_b, (GLfloat)ob_a);
    if (state->border_ib_size_uniform >= 0)
        glUniform1f(state->border_ib_size_uniform, (GLfloat)ib_size);
    if (state->border_ib_color_uniform >= 0)
        glUniform4f(state->border_ib_color_uniform, (GLfloat)ib_r, (GLfloat)ib_g, (GLfloat)ib_b, (GLfloat)ib_a);

    glBindBuffer(GL_ARRAY_BUFFER, state->comp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, FULLSCREEN_QUAD_VERTEX_COUNT);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);
}

static void
render_custom_waves_overlay(HelperState *state,
                           double time_value,
                           double waves_data[], int waves_count,
                           int waves_points[],
                           int waves_dots[], int waves_thick[], int waves_additive[])
{
    if (!state->wave_program || waves_count <= 0)
        return;
    if (!waves_data || !waves_points)
        return;

    glUseProgram(state->wave_program);
    glBindBuffer(GL_ARRAY_BUFFER, state->custom_wave_vbo);

    const int width = state->width > 0 ? state->width : 1;

    for (int w = 0; w < waves_count; w++) {
        int num_points = waves_points[w];
        if (num_points <= 0)
            continue;

        int use_dots = waves_dots ? waves_dots[w] : 0;
        int draw_thick = waves_thick ? waves_thick[w] : 0;
        int additive = waves_additive ? waves_additive[w] : 0;

        if (additive)
            glBlendFunc(GL_ONE, GL_ONE);
        else
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

        GLfloat vertices[512 * 2];
        GLfloat colors[512 * 4];

        for (int p = 0; p < num_points; p++) {
            int idx = (w * 512 + p) * 6;
            vertices[p * 2 + 0] = (GLfloat)waves_data[idx + 0] - 0.5f;
            vertices[p * 2 + 1] = (GLfloat)waves_data[idx + 1] - 0.5f;
            colors[p * 4 + 0] = (GLfloat)waves_data[idx + 2];
            colors[p * 4 + 1] = (GLfloat)waves_data[idx + 3];
            colors[p * 4 + 2] = (GLfloat)waves_data[idx + 4];
            colors[p * 4 + 3] = (GLfloat)waves_data[idx + 5];
        }

        glBufferSubData(GL_ARRAY_BUFFER, 0, num_points * 2 * sizeof(GLfloat), vertices);

        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, (void *)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, 0, (void *)0);

        GLenum draw_mode = use_dots ? GL_POINTS : GL_LINE_STRIP;

        if (draw_thick && !use_dots) {
            const float incrementX = 1.0f / (float)width;
            for (int t = 0; t < 4; t++) {
                for (int i = 0; i < num_points; i++) {
                    switch (t) {
                        case 0: break;
                        case 1: vertices[i * 2] += incrementX; break;
                        case 2: vertices[i * 2 + 1] += incrementX; break;
                        case 3: vertices[i * 2] -= incrementX; break;
                    }
                }
                glBufferSubData(GL_ARRAY_BUFFER, 0, num_points * 2 * sizeof(GLfloat), vertices);
                glDrawArrays(draw_mode, 0, num_points);
            }
        } else {
            glDrawArrays(draw_mode, 0, num_points);
        }

        glDisableVertexAttribArray(0);
        glDisableVertexAttribArray(1);
    }
}

static void
render_custom_shapes_overlay(HelperState *state,
                           double time_value,
                           double shapes_data[], int shapes_count,
                           const char *texture_filenames[])
{
    if (!state->wave_program || shapes_count <= 0)
        return;
    if (!shapes_data)
        return;

    glUseProgram(state->wave_program);
    glBindBuffer(GL_ARRAY_BUFFER, state->custom_shape_vbo);

    int max_shapes = shapes_count > 16 ? 16 : shapes_count;
    for (int s = 0; s < max_shapes; s++) {
        int idx = s * 20;
        double x = shapes_data[idx + 0];
        double y = shapes_data[idx + 1];
        double rad = shapes_data[idx + 2];
        double ang = shapes_data[idx + 3];
        int sides = (int)(shapes_data[idx + 4] + 0.5);
        if (sides < 3) sides = 3;
        if (sides > 100) sides = 100;
        double r = shapes_data[idx + 5];
        double g = shapes_data[idx + 6];
        double b = shapes_data[idx + 7];
        double a = shapes_data[idx + 8];
        double r2 = shapes_data[idx + 9];
        double g2 = shapes_data[idx + 10];
        double b2 = shapes_data[idx + 11];
        double a2 = shapes_data[idx + 12];
        double additive = shapes_data[idx + 13];
        double thick = shapes_data[idx + 14];
        double textured = shapes_data[idx + 19];
        double tex_zoom = 1.0;
        double tex_ang = 0.0;

        if (a <= 0.001 && a2 <= 0.001)
            continue;

        /* Load texture if needed */
        if (textured > 0.5 && texture_filenames && texture_filenames[s]) {
            load_shape_texture(state, texture_filenames[s]);
            glBindTexture(GL_TEXTURE_2D, state->custom_shape_texture);
            glEnable(GL_TEXTURE_2D);
        } else {
            glDisable(GL_TEXTURE_2D);
        }

        if (additive > 0.5)
            glBlendFunc(GL_ONE, GL_ONE);
        else
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

        GLfloat vertices[200];
        GLfloat colors[400];
        GLfloat uvs[200];
        int vert_count = 0;

        /* Center vertex */
        vertices[vert_count * 2] = (GLfloat)x - 0.5f;
        vertices[vert_count * 2 + 1] = (GLfloat)y - 0.5f;
        colors[vert_count * 4] = (GLfloat)r;
        colors[vert_count * 4 + 1] = (GLfloat)g;
        colors[vert_count * 4 + 2] = (GLfloat)b;
        colors[vert_count * 4 + 3] = (GLfloat)a;
        /* Center UV */
        if (textured > 0.5) {
            uvs[vert_count * 2] = 0.5f;
            uvs[vert_count * 2 + 1] = 0.5f;
        }
        vert_count++;

        for (int i = 0; i <= sides; i++) {
            double theta = ang + (double)i / (double)sides * 6.283185307179586;
            double px = x + rad * cos(theta);
            double py = y + rad * sin(theta);
            vertices[vert_count * 2] = (GLfloat)px - 0.5f;
            vertices[vert_count * 2 + 1] = (GLfloat)py - 0.5f;
            colors[vert_count * 4] = (GLfloat)r2;
            colors[vert_count * 4 + 1] = (GLfloat)g2;
            colors[vert_count * 4 + 2] = (GLfloat)b2;
            colors[vert_count * 4 + 3] = (GLfloat)a2;
            /* UV from polar coordinates */
            if (textured > 0.5) {
                float cornerProgress = (float)(i - 1) / (float)sides;
                float uv_ang = cornerProgress * 6.283185f + (float)tex_ang + 3.141592f * 0.25f;
                uvs[vert_count * 2] = 0.5f + 0.5f * cosf(uv_ang) / (float)tex_zoom;
                uvs[vert_count * 2 + 1] = 1.0f - (0.5f + 0.5f * sinf(uv_ang) / (float)tex_zoom);
            }
            vert_count++;
        }

        if (vert_count < 3)
            continue;

        glBufferSubData(GL_ARRAY_BUFFER, 0, vert_count * 2 * sizeof(GLfloat), vertices);

        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, (void *)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, 0, (void *)0);

        if (textured > 0.5) {
            glEnableVertexAttribArray(2);
            glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, 0, (void *)0);
        }

        glDrawArrays(GL_TRIANGLE_FAN, 0, vert_count);

        glDisableVertexAttribArray(0);
        glDisableVertexAttribArray(1);

        if (thick > 0.5) {
            const float incrementX = 1.0f / (float)state->width;
            const float incrementY = 1.0f / (float)state->height;
            for (int t = 0; t < 4; t++) {
                for (int i = 1; i < vert_count; i++) {
                    switch (t) {
                        case 0: break;
                        case 1: vertices[i * 2] += incrementX; break;
                        case 2: vertices[i * 2 + 1] += incrementY; break;
                        case 3: vertices[i * 2] -= incrementX; break;
                    }
                }
                glBufferSubData(GL_ARRAY_BUFFER, 0, vert_count * 2 * sizeof(GLfloat), vertices);
                glDrawArrays(GL_LINE_LOOP, 1, vert_count - 1);
            }
        } else {
            glDrawArrays(GL_LINE_LOOP, 1, vert_count - 1);
        }
    }
}

static void
render_motion_vectors_overlay(HelperState *state,
                              double mv_x, double mv_y, double mv_dx, double mv_dy,
                              double mv_l, double mv_r, double mv_g, double mv_b, double mv_a)
{
    if (!state->mv_program)
        return;
    if (mv_a <= 0.0001 || mv_l <= 0.0001)
        return;

    glUseProgram(state->mv_program);
    if (state->mv_grid_uniform >= 0)
        glUniform2f(state->mv_grid_uniform, (GLfloat)mv_x, (GLfloat)mv_y);
    if (state->mv_offset_uniform >= 0)
        glUniform2f(state->mv_offset_uniform, (GLfloat)mv_dx, (GLfloat)mv_dy);
    if (state->mv_length_uniform >= 0)
        glUniform1f(state->mv_length_uniform, (GLfloat)mv_l);
    if (state->mv_color_uniform >= 0)
        glUniform4f(state->mv_color_uniform, (GLfloat)mv_r, (GLfloat)mv_g, (GLfloat)mv_b, (GLfloat)mv_a);

    glBindBuffer(GL_ARRAY_BUFFER, state->comp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, FULLSCREEN_QUAD_VERTEX_COUNT);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);
}

static void
render_waveform_overlay(HelperState *state,
                        double time_value,
                        double wave_mode, double wave_a, double wave_scale,
                        double wave_smoothing, double wave_x, double wave_y,
                        double wave_dots, double wave_thick, double wave_mystery, double additivewave,
                        double wave_r, double wave_g, double wave_b,
                        const GLfloat wave_data[WAVE_SAMPLE_COUNT], int wave_data_count,
                        const GLfloat pcmLeft[PCM_SAMPLE_COUNT], const GLfloat pcmRight[PCM_SAMPLE_COUNT], int pcm_count)
{
    if (!state->wave_program)
        return;
    if (wave_a <= 0.0001)
        return;

    if (pcm_count <= 0 || (!pcmLeft && !pcmRight))
        return;

    if (additivewave > 0.5)
        glBlendFunc(GL_ONE, GL_ONE);
    else
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    glUseProgram(state->wave_program);
    if (state->wave_color_uniform >= 0)
        glUniform4f(state->wave_color_uniform, (GLfloat)wave_r, (GLfloat)wave_g, (GLfloat)wave_b, 1.0f);
    if (state->wave_alpha_uniform >= 0)
        glUniform1f(state->wave_alpha_uniform, (GLfloat)wave_a);
    if (state->wave_scale_uniform >= 0)
        glUniform1f(state->wave_scale_uniform, (GLfloat)wave_scale);
    if (state->wave_smoothing_uniform >= 0)
        glUniform1f(state->wave_smoothing_uniform, (GLfloat)wave_smoothing);
    if (state->wave_pos_uniform >= 0)
        glUniform2f(state->wave_pos_uniform, (GLfloat)wave_x, (GLfloat)wave_y);
    if (state->wave_mode_uniform >= 0)
        glUniform1f(state->wave_mode_uniform, (GLfloat)wave_mode);
    if (state->wave_mystery_uniform >= 0)
        glUniform1f(state->wave_mystery_uniform, (GLfloat)wave_mystery);
    if (state->wave_dots_uniform >= 0)
        glUniform1f(state->wave_dots_uniform, (GLfloat)wave_dots);
    if (state->wave_thick_uniform >= 0)
        glUniform1f(state->wave_thick_uniform, (GLfloat)wave_thick);
    if (state->wave_additive_uniform >= 0)
        glUniform1f(state->wave_additive_uniform, (GLfloat)additivewave);

    const int samples = pcm_count > 0 ? pcm_count : PCM_SAMPLE_COUNT;
    const int half_samples = samples / 2;

    GLfloat vertices[PCM_SAMPLE_COUNT * 2];
    int vertex_count = 0;

    int mode = (int)wave_mode % 16;

    if (mode == 0 || mode == 9 || mode == 10 || mode == 11) {
        float inv_samples_minus_one = 1.0f / (float)(half_samples);
        for (int i = 0; i < half_samples; i++) {
            float radius = 0.5f + 0.4f * pcmRight[i] + (float)wave_mystery;
            float angle = (float)i * inv_samples_minus_one * 6.283185f + (float)time_value * 0.2f;
            if (i < half_samples / 10) {
                float mix = (float)i / ((float)half_samples * 0.1f);
                mix = 0.5f - 0.5f * cosf(mix * 3.1416f);
                float radius2 = 0.5f + 0.4f * pcmRight[i + half_samples] + (float)wave_mystery;
                radius = radius2 * (1.0f - mix) + radius * mix;
            }
            vertices[vertex_count * 2] = radius * cosf(angle) * 0.5f + (GLfloat)wave_x - 0.5f;
            vertices[vertex_count * 2 + 1] = radius * sinf(angle) * 0.5f + (GLfloat)wave_y - 0.5f;
            vertex_count++;
        }
    } else if (mode == 4 || mode == 8 || mode == 12) {
        for (int i = 0; i < half_samples; i++) {
            float x = -0.5f + ((float)i / (float)half_samples) + (GLfloat)wave_x - 0.5f;
            float y = pcmLeft[i] * (GLfloat)wave_scale * 0.25f + (GLfloat)wave_y - 0.5f;
            vertices[vertex_count * 2] = x;
            vertices[vertex_count * 2 + 1] = y;
            vertex_count++;
        }
    } else if (mode == 5 || mode == 15) {
        float separation = powf(wave_y * 0.5f + 0.5f, 2.0f);
        for (int i = 0; i < half_samples; i++) {
            float x = -0.5f + ((float)i / (float)half_samples) + (GLfloat)wave_x - 0.5f;
            float y1 = pcmLeft[i] * (GLfloat)wave_scale * 0.25f + separation + (GLfloat)wave_y - 0.5f;
            float y2 = pcmRight[i] * (GLfloat)wave_scale * 0.25f - separation + (GLfloat)wave_y - 0.5f;
            vertices[vertex_count * 2] = x;
            vertices[vertex_count * 2 + 1] = y1;
            vertex_count++;
            vertices[vertex_count * 2] = x;
            vertices[vertex_count * 2 + 1] = y2;
            vertex_count++;
        }
    } else if (mode == 1 || mode == 2 || mode == 3 || mode == 6 || mode == 7) {
        for (int i = 0; i < half_samples; i++) {
            float radius = 0.53f + 0.43f * pcmRight[i] + (float)wave_mystery;
            float angle = pcmLeft[i + 32] * 1.57f + (float)time_value * 2.3f;
            vertices[vertex_count * 2] = radius * cosf(angle) * 0.5f + (GLfloat)wave_x - 0.5f;
            vertices[vertex_count * 2 + 1] = radius * sinf(angle) * 0.5f + (GLfloat)wave_y - 0.5f;
            vertex_count++;
        }
    } else {
        for (int i = 0; i < half_samples; i++) {
            float x = -0.5f + ((float)i / (float)half_samples) + (GLfloat)wave_x - 0.5f;
            float y = pcmLeft[i] * (GLfloat)wave_scale * 0.25f + (GLfloat)wave_y - 0.5f;
            vertices[vertex_count * 2] = x;
            vertices[vertex_count * 2 + 1] = y;
            vertex_count++;
        }
    }

    if (vertex_count <= 0)
        return;

    glBindBuffer(GL_ARRAY_BUFFER, state->wave_vbo);
    glBufferSubData(GL_ARRAY_BUFFER, 0, vertex_count * 2 * sizeof(GLfloat), vertices);

    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, (void *)0);

    if (wave_dots > 0.5) {
        glDrawArrays(GL_POINTS, 0, vertex_count);
    } else {
        glDrawArrays(GL_LINE_STRIP, 0, vertex_count);
    }

    glDisableVertexAttribArray(0);

    (void)wave_data;
    (void)wave_data_count;
}

/* ── Render frame (three-pass pipeline) ────────────────────────────── */

static void
render_frame(HelperState *state, double time_value,
             double zoom, double rot, double dx, double dy, double decay_val,
             double energy, double bass, double mid, double high,
             bool warp_in_shader, double warp_amount, double warp_speed, double warp_scale, int warp_type,
             double invert, double brighten, double darken, double solarize, double gamma,
             double darken_center, double echo_zoom, double echo_alpha, double echo_orient,
             double wave_mode, double wave_a, double wave_scale_value,
             double wave_smoothing, double wave_x, double wave_y,
             double wave_dots, double wave_thick, double wave_mystery, double additivewave,
             double wave_r, double wave_g, double wave_b,
             const GLfloat wave_data[WAVE_SAMPLE_COUNT], int wave_data_count,
             const GLfloat pcmLeft[PCM_SAMPLE_COUNT], const GLfloat pcmRight[PCM_SAMPLE_COUNT], int pcm_count,
             double ob_size, double ob_r, double ob_g, double ob_b, double ob_a,
             double ib_size, double ib_r, double ib_g, double ib_b, double ib_a,
             double mv_x, double mv_y, double mv_dx, double mv_dy,
             double mv_l, double mv_r, double mv_g, double mv_b, double mv_a,
             double custom_shapes_data[], int custom_shapes_count,
             double custom_waves_data[], int custom_waves_count, int custom_waves_points[],
             int custom_waves_dots[], int custom_waves_thick[], int custom_waves_additive[])
{
    if (!state->initialized || !state->program_ready)
        return;

    const int width = state->width > 0 ? state->width : 1;
    const int height = state->height > 0 ? state->height : 1;
    const int stride = state->stride > 0 ? state->stride : width * 4;
    const gsize pixel_count = (gsize)stride * (gsize)height;

    gint64 render_start = g_get_monotonic_time();

    glViewport(0, 0, width, height);

    int src_fbo = state->current_fbo;
    int dst_fbo = 1 - src_fbo;

    /* ── Pass 1: Draw initial content into dst FBO ─────────────────── */
    PERF_BEGIN(draw_pass);
    glBindFramebuffer(GL_FRAMEBUFFER, state->fbo[dst_fbo]);
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    glUseProgram(state->draw_program);
    if (state->draw_time_uniform >= 0)
        glUniform1f(state->draw_time_uniform, (GLfloat)time_value);
    if (state->draw_energy_uniform >= 0)
        glUniform1f(state->draw_energy_uniform, (GLfloat)energy);
    if (state->draw_bass_uniform >= 0)
        glUniform1f(state->draw_bass_uniform, (GLfloat)bass);
    if (state->draw_mid_uniform >= 0)
        glUniform1f(state->draw_mid_uniform, (GLfloat)mid);
    if (state->draw_high_uniform >= 0)
        glUniform1f(state->draw_high_uniform, (GLfloat)high);
    if (state->draw_resolution_uniform >= 0)
        glUniform2f(state->draw_resolution_uniform, (GLfloat)width, (GLfloat)height);

    glBindBuffer(GL_ARRAY_BUFFER, state->draw_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, FULLSCREEN_QUAD_VERTEX_COUNT);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);
    PERF_END(draw_pass);

    /* ── Pass 2: Warp — sample src FBO through displaced mesh into dst FBO ── */
    /* Blend warp result over the draw result for feedback accumulation */
    PERF_BEGIN(warp_pass);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    glUseProgram(state->warp_program);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, state->fbo_tex[src_fbo]);
    if (state->warp_prev_frame_uniform >= 0)
        glUniform1i(state->warp_prev_frame_uniform, 0);
    if (state->warp_decay_uniform >= 0)
        glUniform1f(state->warp_decay_uniform, (GLfloat)decay_val);
    if (state->warp_time_uniform >= 0)
        glUniform1f(state->warp_time_uniform, (GLfloat)time_value);
    if (state->warp_energy_uniform >= 0)
        glUniform1f(state->warp_energy_uniform, (GLfloat)energy);
    if (state->warp_amount_uniform >= 0)
        glUniform1f(state->warp_amount_uniform, (GLfloat)warp_amount);
    if (state->warp_speed_uniform >= 0)
        glUniform1f(state->warp_speed_uniform, (GLfloat)warp_speed);
    if (state->warp_scale_uniform >= 0)
        glUniform1f(state->warp_scale_uniform, (GLfloat)warp_scale);
    if (state->warp_type_uniform >= 0)
        glUniform1f(state->warp_type_uniform, (GLfloat)warp_type);
    if (state->warp_in_shader_uniform >= 0)
        glUniform1f(state->warp_in_shader_uniform, warp_in_shader ? 1.0f : 0.0f);
    if (state->warp_zoom_uniform >= 0)
        glUniform1f(state->warp_zoom_uniform, (GLfloat)zoom);
    if (state->warp_rot_uniform >= 0)
        glUniform1f(state->warp_rot_uniform, (GLfloat)rot);
    if (state->warp_dx_uniform >= 0)
        glUniform1f(state->warp_dx_uniform, (GLfloat)dx);
    if (state->warp_dy_uniform >= 0)
        glUniform1f(state->warp_dy_uniform, (GLfloat)dy);

    glBindBuffer(GL_ARRAY_BUFFER, state->warp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, state->warp_vertex_count);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);

    glDisable(GL_BLEND);
    PERF_END(warp_pass);

    /* ── Pass 3: Composite — read dst FBO, render to pbuffer for readback ── */
    PERF_BEGIN(composite_pass);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    glUseProgram(state->comp_program);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, state->fbo_tex[dst_fbo]);
    if (state->comp_warp_output_uniform >= 0)
        glUniform1i(state->comp_warp_output_uniform, 0);
    if (state->comp_time_uniform >= 0)
        glUniform1f(state->comp_time_uniform, (GLfloat)time_value);
    if (state->comp_energy_uniform >= 0)
        glUniform1f(state->comp_energy_uniform, (GLfloat)energy);
    if (state->comp_bass_uniform >= 0)
        glUniform1f(state->comp_bass_uniform, (GLfloat)bass);
    if (state->comp_mid_uniform >= 0)
        glUniform1f(state->comp_mid_uniform, (GLfloat)mid);
    if (state->comp_high_uniform >= 0)
        glUniform1f(state->comp_high_uniform, (GLfloat)high);
    if (state->comp_decay_uniform >= 0)
        glUniform1f(state->comp_decay_uniform, (GLfloat)decay_val);
    if (state->comp_invert_uniform >= 0)
        glUniform1f(state->comp_invert_uniform, (GLfloat)invert);
    if (state->comp_brighten_uniform >= 0)
        glUniform1f(state->comp_brighten_uniform, (GLfloat)brighten);
    if (state->comp_darken_uniform >= 0)
        glUniform1f(state->comp_darken_uniform, (GLfloat)darken);
    if (state->comp_solarize_uniform >= 0)
        glUniform1f(state->comp_solarize_uniform, (GLfloat)solarize);
    if (state->comp_gamma_uniform >= 0)
        glUniform1f(state->comp_gamma_uniform, (GLfloat)gamma);
    if (state->comp_darken_center_uniform >= 0)
        glUniform1f(state->comp_darken_center_uniform, (GLfloat)darken_center);
    if (state->comp_echo_zoom_uniform >= 0)
        glUniform1f(state->comp_echo_zoom_uniform, (GLfloat)echo_zoom);
    if (state->comp_echo_alpha_uniform >= 0)
        glUniform1f(state->comp_echo_alpha_uniform, (GLfloat)echo_alpha);
    if (state->comp_echo_orient_uniform >= 0)
        glUniform1f(state->comp_echo_orient_uniform, (GLfloat)echo_orient);

    glBindBuffer(GL_ARRAY_BUFFER, state->comp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, FULLSCREEN_QUAD_VERTEX_COUNT);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);

    PERF_END(composite_pass);

    /* Custom shapes pass (before built-in waveform) */
    PERF_BEGIN(custom_shape_pass);
    glEnable(GL_BLEND);
    render_custom_shapes_overlay(state, time_value, custom_shapes_data, custom_shapes_count, NULL);
    glDisable(GL_BLEND);
    PERF_END(custom_shape_pass);

    /* Custom waves pass (after custom shapes, before built-in waveform) */
    PERF_BEGIN(custom_wave_pass);
    glEnable(GL_BLEND);
    render_custom_waves_overlay(state, time_value, custom_waves_data, custom_waves_count, custom_waves_points,
                                  custom_waves_dots, custom_waves_thick, custom_waves_additive);
    glDisable(GL_BLEND);
    PERF_END(custom_wave_pass);

    PERF_BEGIN(waveform_pass);
    glEnable(GL_BLEND);
    render_waveform_overlay(state,
                            time_value,
                            wave_mode, wave_a, wave_scale_value,
                            wave_smoothing, wave_x, wave_y,
                            wave_dots, wave_thick, wave_mystery, additivewave,
                            wave_r, wave_g, wave_b,
                            wave_data, wave_data_count,
                            pcmLeft, pcmRight, pcm_count);
    glDisable(GL_BLEND);
    PERF_END(waveform_pass);

    PERF_BEGIN(border_pass);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    render_border_overlay(state, ob_size, ob_r, ob_g, ob_b, ob_a,
                          ib_size, ib_r, ib_g, ib_b, ib_a);
    glDisable(GL_BLEND);
    PERF_END(border_pass);

    PERF_BEGIN(motion_vectors_pass);
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    render_motion_vectors_overlay(state,
                                  mv_x, mv_y, mv_dx, mv_dy,
                                  mv_l, mv_r, mv_g, mv_b, mv_a);
    glDisable(GL_BLEND);
    PERF_END(motion_vectors_pass);

    /* Swap ping-pong */
    state->current_fbo = dst_fbo;

    gint64 render_end = g_get_monotonic_time();
    gint64 render_us = render_end - render_start;
    gint64 readback_start = render_end;

    /* ── Readback ──────────────────────────────────────────────────── */
    PERF_BEGIN(readback);
    if (pixel_count > state->pixel_buffer_size || !state->pixel_buffer) {
        emit_telemetry("readback", "warn", "pixel buffer too small", 0);
        return;
    }

    if (state->pbo_supported) {
        /* PBO double-buffered async readback:
         * - Kick off async DMA for current frame into pbo[cur]
         * - Read previous frame's result from pbo[prev] (already complete)
         * - First frame: sync fallback since no previous PBO is ready */
        int cur = state->cur_pbo;
        int prev = 1 - cur;

        glBindBuffer(GL_PIXEL_PACK_BUFFER, state->pbo[cur]);
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, NULL);

        if (state->pbo_ready) {
            glBindBuffer(GL_PIXEL_PACK_BUFFER, state->pbo[prev]);
            void *mapped = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0,
                                            (GLsizeiptr)pixel_count, GL_MAP_READ_BIT);
            if (mapped) {
                memcpy(state->pixel_buffer, mapped, pixel_count);
                glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
            }
        } else {
            glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, state->pixel_buffer);
            state->pbo_ready = true;
        }
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        state->cur_pbo = prev;
    } else {
        /* Synchronous readback (ES 2.0 fallback) */
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, state->pixel_buffer);
    }

    GLenum gl_err = glGetError();
    if (gl_err != GL_NO_ERROR) {
        emit_telemetry("readback", "warn", "glReadPixels error", 0);
        PERF_END(readback);
        return;
    }

    eglSwapBuffers(state->display, state->surface);
    state->frame_count += 1;

    bool sent = false;
#ifdef __linux__
    if (state->shm_socket_path) {
        int idx = state->shm_cur;
        if (state->shm_map[idx]) {
            /* Persistent SHM: memcpy + send pre-allocated fd.
             * Reset file offset to 0 before sending: SCM_RIGHTS passes the
             * same open-file-description (shared offset) to the receiver, so
             * without the seek the receiver would start reading at EOF after
             * the first round-trip. */
            memcpy(state->shm_map[idx], state->pixel_buffer, pixel_count);
            lseek(state->shm_fd[idx], 0, SEEK_SET);
            sent = emit_frame_pixels_shm_fd(state, state->shm_fd[idx],
                                            state->frame_count, width, height, stride);
            state->shm_cur = 1 - idx;
        } else {
            /* Persistent SHM init failed — per-frame memfd fallback */
            int memfd = memfd_create("milkdrop-frame", MFD_CLOEXEC);
            if (memfd >= 0 && ftruncate(memfd, (off_t)pixel_count) == 0) {
                void *mapped = mmap(NULL, pixel_count, PROT_READ | PROT_WRITE,
                                    MAP_SHARED, memfd, 0);
                if (mapped != MAP_FAILED) {
                    memcpy(mapped, state->pixel_buffer, pixel_count);
                    sent = emit_frame_pixels_shm_fd(state, memfd, state->frame_count,
                                                    width, height, stride);
                    munmap(mapped, pixel_count);
                }
            }
            if (memfd >= 0)
                close(memfd);
        }
    }
#endif

    if (!sent)
        emit_frame_pixels_base64(state->pixel_buffer, pixel_count,
                                 state->frame_count, width, height, stride);

    PERF_END(readback);
    emit_frame_stat(state->frame_count, time_value, render_us,
                    g_get_monotonic_time() - readback_start);
}

/* ── Main loop ─────────────────────────────────────────────────────── */

static void
parse_argv(int argc, char **argv, HelperState *state)
{
    for (int i = 1; i < argc; i++) {
        if (g_str_equal(argv[i], "--shm-socket-path") && i + 1 < argc) {
            g_free(state->shm_socket_path);
            state->shm_socket_path = g_strdup(argv[i + 1]);
            i++;
        }
    }
}

int
main(int argc, char **argv)
{
    HelperState state = {
        .display = EGL_NO_DISPLAY,
        .context = EGL_NO_CONTEXT,
        .surface = EGL_NO_SURFACE,
        .shm_socket_path = NULL,
        .shm_conn = NULL,
        .pixel_buffer = NULL,
        .pixel_buffer_size = 0,
        .pbo = {0, 0},
        .pbo_supported = false,
        .pbo_ready = false,
        .shm_fd = {-1, -1},
        .shm_map = {NULL, NULL},
        .shm_map_size = 0,
        .shm_cur = 0,
    };

    parse_argv(argc, argv, &state);

    char *line = NULL;
    size_t line_capacity = 0;
    while (getline(&line, &line_capacity, stdin) != -1) {
        JsonObject *obj = parse_message_line(line);
        if (!obj) {
            continue;
        }

        if (message_has_type(obj, "shutdown")) {
            json_object_unref(obj);
            break;
        }

        if (message_has_type(obj, "init")) {
            int width = get_int(obj, "width", 1);
            int height = get_int(obj, "height", 1);
            json_object_unref(obj);
            if (!initialize_egl(&state, width, height))
                break;
            continue;
        }

        if (message_has_type(obj, "compile-default")) {
            json_object_unref(obj);
            if (!compile_default_program(&state))
                break;
            continue;
        }

        if (message_has_type(obj, "compile-shaders")) {
            gchar *draw_fs = get_string_dup(obj, "draw");
            gchar *warp_fs = get_string_dup(obj, "warp");
            gchar *comp_fs = get_string_dup(obj, "composite");
            json_object_unref(obj);
            bool ok = compile_custom_program(&state, draw_fs, warp_fs, comp_fs);
            g_free(draw_fs);
            g_free(warp_fs);
            g_free(comp_fs);
            if (!ok)
                break;
            continue;
        }

        if (message_has_type(obj, "mesh")) {
            upload_mesh(&state, obj);
            json_object_unref(obj);
            continue;
        }

        if (message_has_type(obj, "frame")) {
            double time_value = get_double(obj, "time", 0.0);
            double zoom       = get_double(obj, "zoom", 1.0);
            double rot        = get_double(obj, "rot", 0.0);
            double dx         = get_double(obj, "dx", 0.0);
            double dy         = get_double(obj, "dy", 0.0);
            double decay_val  = get_double(obj, "decay", 0.98);
            double energy     = get_double(obj, "energy", 0.0);
            double bass       = get_double(obj, "bass", 0.0);
            double mid        = get_double(obj, "mid", 0.0);
            double high       = get_double(obj, "high", 0.0);
            bool warp_in_shader = json_object_has_member(obj, "warpInShader") &&
                json_object_get_boolean_member(obj, "warpInShader");
            double warp_amount = get_double(obj, "warpAmount", 0.0);
            double warp_speed  = get_double(obj, "warpSpeed", 1.0);
            double warp_scale  = get_double(obj, "warpScale", 1.0);
            double invert      = get_double(obj, "invert", 0.0);
            double brighten    = get_double(obj, "brighten", 0.0);
            double darken      = get_double(obj, "darken", 0.0);
            double solarize    = get_double(obj, "solarize", 0.0);
            double gamma       = get_double(obj, "gamma", 1.0);
            double darken_center = get_double(obj, "darken_center", 0.0);
            double echo_zoom   = get_double(obj, "echo_zoom", 1.0);
            double echo_alpha  = get_double(obj, "echo_alpha", 0.0);
            double echo_orient = get_double(obj, "echo_orient", 0.0);
            double ob_size     = get_double(obj, "ob_size", 0.01);
            double ob_r        = get_double(obj, "ob_r", 0.0);
            double ob_g        = get_double(obj, "ob_g", 0.0);
            double ob_b        = get_double(obj, "ob_b", 0.0);
            double ob_a        = get_double(obj, "ob_a", 0.0);
            double ib_size     = get_double(obj, "ib_size", 0.01);
            double ib_r        = get_double(obj, "ib_r", 0.25);
            double ib_g        = get_double(obj, "ib_g", 0.25);
            double ib_b        = get_double(obj, "ib_b", 0.25);
            double ib_a        = get_double(obj, "ib_a", 0.0);
            double mv_x        = get_double(obj, "mv_x", 12.0);
            double mv_y        = get_double(obj, "mv_y", 9.0);
            double mv_dx       = get_double(obj, "mv_dx", 0.0);
            double mv_dy       = get_double(obj, "mv_dy", 0.0);
            double mv_l        = get_double(obj, "mv_l", 0.9);
            double mv_r        = get_double(obj, "mv_r", 1.0);
            double mv_g        = get_double(obj, "mv_g", 1.0);
            double mv_b        = get_double(obj, "mv_b", 1.0);
            double mv_a        = get_double(obj, "mv_a", 0.0);
            double wave_mode   = get_double(obj, "wave_mode", 0.0);
            double wave_a      = get_double(obj, "wave_a", 0.8);
            double wave_scale_value = get_double(obj, "wave_scale", 1.0);
            double wave_smoothing = get_double(obj, "wave_smoothing", 0.75);
            double wave_x      = get_double(obj, "wave_x", 0.5);
            double wave_y      = get_double(obj, "wave_y", 0.5);
            double wave_dots   = get_double(obj, "wave_dots", 0.0);
            double wave_thick  = get_double(obj, "wave_thick", 0.0);
            double wave_mystery = get_double(obj, "wave_mystery", 0.0);
            double additivewave = get_double(obj, "additivewave", 0.0);
            double wave_r      = get_double(obj, "wave_r", 1.0);
            double wave_g      = get_double(obj, "wave_g", 1.0);
            double wave_b      = get_double(obj, "wave_b", 1.0);
            GLfloat wave_data[WAVE_SAMPLE_COUNT];
            int wave_data_count = parse_wave_data(obj, wave_data);
            GLfloat pcmLeft[PCM_SAMPLE_COUNT];
            GLfloat pcmRight[PCM_SAMPLE_COUNT];
            int pcm_count = parse_pcm_data(obj, "pcmLeft", pcmLeft);
            pcm_count += parse_pcm_data(obj, "pcmRight", pcmRight);
            
            /* Custom waves - parsed from frame message */
            /* customWaves: array of {points:[{x,y,r,g,b,a}], useDots, additive, drawThick} */
            double custom_waves_data[4 * 512 * 6];
            int custom_waves_count = 0;
            int custom_waves_points[4];
            int custom_waves_dots[4];
            int custom_waves_thick[4];
            int custom_waves_additive[4];
            for (int i = 0; i < 4; i++) {
                custom_waves_dots[i] = 0;
                custom_waves_thick[i] = 0;
                custom_waves_additive[i] = 0;
            }
            JsonArray *customWavesArr = json_object_has_member(obj, "customWaves") ?
                json_object_get_array_member(obj, "customWaves") : NULL;
            if (customWavesArr) {
                int arr_len = json_array_get_length(customWavesArr);
                custom_waves_count = arr_len > 4 ? 4 : arr_len;
                for (int w = 0; w < custom_waves_count; w++) {
                    JsonObject *wave = json_array_get_object_element(customWavesArr, w);
                    if (!wave) {
                        custom_waves_points[w] = 0;
                        continue;
                    }
                    custom_waves_dots[w] = get_int(wave, "useDots", 0);
                    custom_waves_thick[w] = get_int(wave, "drawThick", 0);
                    custom_waves_additive[w] = get_int(wave, "additive", 0);
                    JsonArray *pointsArr = json_object_get_array_member(wave, "points");
                    int num_points = pointsArr ? json_array_get_length(pointsArr) : 0;
                    if (num_points > 512) num_points = 512;
                    custom_waves_points[w] = num_points;
                    for (int p = 0; p < num_points; p++) {
                        JsonObject *pt = json_array_get_object_element(pointsArr, p);
                        if (!pt) continue;
                        int idx = (w * 512 + p) * 6;
                        custom_waves_data[idx + 0] = get_double(pt, "x", 0.5);
                        custom_waves_data[idx + 1] = get_double(pt, "y", 0.5);
                        custom_waves_data[idx + 2] = get_double(pt, "r", 1.0);
                        custom_waves_data[idx + 3] = get_double(pt, "g", 1.0);
                        custom_waves_data[idx + 4] = get_double(pt, "b", 1.0);
                        custom_waves_data[idx + 5] = get_double(pt, "a", 1.0);
                    }
                }
            }
            
            /* Custom shapes - parsed from frame message */
            /* customShapes: array of {x,y,rad,ang,sides,r,g,b,a,r2,g2,b2,a2,border_r,g,b,a,additive,thickOutline,textured,tex_ang,tex_zoom} */
            double custom_shapes_data[16 * 20];
            char custom_shape_textures[16][256];
            for (int i = 0; i < 16; i++) custom_shape_textures[i][0] = '\0';
            int custom_shapes_count = 0;
            JsonArray *customShapesArr = json_object_has_member(obj, "customShapes") ?
                json_object_get_array_member(obj, "customShapes") : NULL;
            if (customShapesArr) {
                int arr_len = json_array_get_length(customShapesArr);
                custom_shapes_count = arr_len > 16 ? 16 : arr_len;
                for (int i = 0; i < custom_shapes_count; i++) {
                    JsonObject *shape = json_array_get_object_element(customShapesArr, i);
                    if (!shape) continue;
                    int idx = i * 20;
                    custom_shapes_data[idx + 0] = get_double(shape, "x", 0.5);
                    custom_shapes_data[idx + 1] = get_double(shape, "y", 0.5);
                    custom_shapes_data[idx + 2] = get_double(shape, "rad", 0.1);
                    custom_shapes_data[idx + 3] = get_double(shape, "ang", 0.0);
                    custom_shapes_data[idx + 4] = get_double(shape, "sides", 4.0);
                    custom_shapes_data[idx + 5] = get_double(shape, "r", 1.0);
                    custom_shapes_data[idx + 6] = get_double(shape, "g", 0.0);
                    custom_shapes_data[idx + 7] = get_double(shape, "b", 0.0);
                    custom_shapes_data[idx + 8] = get_double(shape, "a", 0.8);
                    custom_shapes_data[idx + 9] = get_double(shape, "r2", 0.0);
                    custom_shapes_data[idx + 10] = get_double(shape, "g2", 1.0);
                    custom_shapes_data[idx + 11] = get_double(shape, "b2", 0.0);
                    custom_shapes_data[idx + 12] = get_double(shape, "a2", 0.5);
                    custom_shapes_data[idx + 13] = get_double(shape, "additive", 0.0);
                    custom_shapes_data[idx + 14] = get_double(shape, "thickOutline", 0.0);
                    custom_shapes_data[idx + 15] = get_double(shape, "border_r", 1.0);
                    custom_shapes_data[idx + 16] = get_double(shape, "border_g", 1.0);
                    custom_shapes_data[idx + 17] = get_double(shape, "border_b", 1.0);
                    custom_shapes_data[idx + 18] = get_double(shape, "border_a", 0.1);
                    custom_shapes_data[idx + 19] = get_double(shape, "textured", 0.0);
                }
            }
            
            /* Custom shape texture filenames - already declared above */
            if (customShapesArr) {
                for (int i = 0; i < custom_shapes_count; i++) {
                    JsonObject *shape = json_array_get_object_element(customShapesArr, i);
                    if (!shape) continue;
                    gchar *img = get_string_dup(shape, "image");
                    if (img) {
                        strncpy(custom_shape_textures[i], img, 255);
                        custom_shape_textures[i][255] = '\0';
                        g_free(img);
                    }
                }
            }
            
            int warp_type = get_int(obj, "warpType", 0);
            if (warp_type < 0) warp_type = 0;
            if (warp_type > 2) warp_type = 2;
            if (gamma < 0.001)
                gamma = 0.001;
            if (echo_zoom < 0.001)
                echo_zoom = 0.001;
            if (wave_scale_value < 0.0)
                wave_scale_value = 0.0;
            if (wave_smoothing < 0.0)
                wave_smoothing = 0.0;
            if (mv_x < 1.0)
                mv_x = 1.0;
            if (mv_y < 1.0)
                mv_y = 1.0;
            json_object_unref(obj);
            render_frame(&state, time_value, zoom, rot, dx, dy, decay_val,
                         energy, bass, mid, high,
                         warp_in_shader, warp_amount, warp_speed, warp_scale, warp_type,
                         invert, brighten, darken, solarize, gamma,
                         darken_center, echo_zoom, echo_alpha, echo_orient,
                         wave_mode, wave_a, wave_scale_value,
                         wave_smoothing, wave_x, wave_y,
                         wave_dots, wave_thick, wave_mystery, additivewave,
                         wave_r, wave_g, wave_b,
                         wave_data, wave_data_count,
                         pcmLeft, pcmRight, pcm_count,
                         ob_size, ob_r, ob_g, ob_b, ob_a,
                         ib_size, ib_r, ib_g, ib_b, ib_a,
                         mv_x, mv_y, mv_dx, mv_dy,
                         mv_l, mv_r, mv_g, mv_b, mv_a,
                         custom_shapes_data, custom_shapes_count,
                         custom_waves_data, custom_waves_count, custom_waves_points,
                         custom_waves_dots, custom_waves_thick, custom_waves_additive);
            continue;
        }

        json_object_unref(obj);
    }

    free(line);
    g_free(state.shm_socket_path);
    shutdown_helper(&state);
    return 0;
}