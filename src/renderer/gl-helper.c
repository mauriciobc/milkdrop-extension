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
    guchar *pixel_buffer;
    gsize pixel_buffer_size;
} HelperState;

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
    "varying vec2 vTexCoord;\n"
    "void main() {\n"
    "  vec2 uv = aTexCoord;\n"
    "  if (uWarpInShader > 0.5 && uWarpAmount > 0.001) {\n"
    "    float t = uTime;\n"
    "    float e = uEnergy;\n"
    "    float amount = uWarpAmount * (1.0 + e * 0.5);\n"
    "    vec2 c = uv - vec2(0.5);\n"
    "    float dist = length(c);\n"
    "    if (uWarpType < 0.5) {\n"
    "      float disp = sin(dist * uWarpScale * 10.0 - t * uWarpSpeed) * amount;\n"
    "      uv += c / max(dist, 0.001) * disp;\n"
    "    } else if (uWarpType < 1.5) {\n"
    "      float angle = atan(c.y, c.x);\n"
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
    "  gl_FragColor = clamp(color, 0.0, 1.0);\n"
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
emit_frame_stat(unsigned long frame_count, double time_value)
{
    printf("{\"type\":\"frame-stat\",\"frame_count\":%lu,\"time\":%.6f}\n",
        frame_count,
        time_value);
    fflush(stdout);
}

/**
 * Send frame pixels via shared memory: write to memfd, send fd over Unix socket,
 * then emit frame-pixels-fd JSON on stdout. Returns true on success.
 */
static bool
emit_frame_pixels_shm(const guchar *pixels, gsize pixel_count, unsigned long frame_count, int width, int height, int stride, const char *shm_path)
{
#ifdef __linux__
    int memfd = memfd_create("milkdrop-frame", MFD_CLOEXEC);
    if (memfd < 0)
        return false;
    ssize_t n = write(memfd, pixels, pixel_count);
    if (n != (ssize_t)pixel_count) {
        close(memfd);
        return false;
    }
    if (lseek(memfd, 0, SEEK_SET) != 0) {
        close(memfd);
        return false;
    }

    GError *err = NULL;
    GSocketClient *client = g_socket_client_new();
    GSocketConnectable *addr = G_SOCKET_CONNECTABLE(g_unix_socket_address_new(shm_path));
    GSocketConnection *conn = g_socket_client_connect(client, addr, NULL, &err);
    g_object_unref(addr);
    g_object_unref(client);
    if (!conn) {
        if (err) {
            emit_telemetry("shm_send", "warn", err->message, 0);
            g_error_free(err);
        }
        close(memfd);
        return false;
    }

    gboolean ok = g_unix_connection_send_fd(G_UNIX_CONNECTION(conn), memfd, NULL, &err);
    g_object_unref(conn);
    close(memfd);
    if (!ok) {
        if (err) {
            emit_telemetry("shm_send_fd", "warn", err->message, 0);
            g_error_free(err);
        }
        return false;
    }

    printf("{\"type\":\"frame-pixels-fd\",\"frame\":%lu,\"width\":%d,\"height\":%d,\"stride\":%d,\"format\":\"rgba8\"}\n",
        frame_count, width, height, stride);
    fflush(stdout);
    return true;
#else
    (void)pixels;
    (void)pixel_count;
    (void)frame_count;
    (void)width;
    (void)height;
    (void)stride;
    (void)shm_path;
    return false;
#endif
}

static void
emit_frame_pixels(const guchar *pixels, gsize pixel_count, unsigned long frame_count, int width, int height, int stride, HelperState *state)
{
    if (state->shm_socket_path && emit_frame_pixels_shm(pixels, pixel_count, frame_count, width, height, stride, state->shm_socket_path))
        return;

    /* Fallback: Base64 over stdout */
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
    const EGLint context_attributes[] = {
        EGL_CONTEXT_CLIENT_VERSION, 2,
        EGL_NONE,
    };
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

    state->context = eglCreateContext(state->display, config, EGL_NO_CONTEXT, context_attributes);
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
    state->stride = (width > 0 ? width : 1) * 4;
    state->initialized = true;

    const gsize need = (gsize)state->stride * (gsize)state->height;
    if (need > state->pixel_buffer_size) {
        g_free(state->pixel_buffer);
        state->pixel_buffer = g_malloc(need);
        state->pixel_buffer_size = state->pixel_buffer ? need : 0;
    }

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
        glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
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

    glBindBuffer(GL_ARRAY_BUFFER, state->warp_vbo);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)decoded_len, decoded, GL_DYNAMIC_DRAW);
    state->warp_vertex_count = vertex_count;
    g_free(decoded);

    emit_telemetry("mesh_upload", "info", "mesh uploaded", 1);
}

/* ── Render frame (three-pass pipeline) ────────────────────────────── */

static void
render_frame(HelperState *state, double time_value,
             double zoom, double rot, double dx, double dy, double decay_val,
             double energy, double bass, double mid, double high,
             bool warp_in_shader, double warp_amount, double warp_speed, double warp_scale, int warp_type)
{
    if (!state->initialized || !state->program_ready)
        return;

    const int width = state->width > 0 ? state->width : 1;
    const int height = state->height > 0 ? state->height : 1;
    const int stride = state->stride > 0 ? state->stride : width * 4;
    const gsize pixel_count = (gsize)stride * (gsize)height;

    glViewport(0, 0, width, height);

    int src_fbo = state->current_fbo;
    int dst_fbo = 1 - src_fbo;

    /* ── Pass 1: Draw initial content into dst FBO ─────────────────── */
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

    /* ── Pass 2: Warp — sample src FBO through displaced mesh into dst FBO ── */
    /* Blend warp result over the draw result for feedback accumulation */
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

    glBindBuffer(GL_ARRAY_BUFFER, state->warp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, state->warp_vertex_count);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);

    glDisable(GL_BLEND);

    /* ── Pass 3: Composite — read dst FBO, render to pbuffer for readback ── */
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

    glBindBuffer(GL_ARRAY_BUFFER, state->comp_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void *)(2 * sizeof(GLfloat)));
    glDrawArrays(GL_TRIANGLES, 0, FULLSCREEN_QUAD_VERTEX_COUNT);
    glDisableVertexAttribArray(0);
    glDisableVertexAttribArray(1);

    /* Swap ping-pong */
    state->current_fbo = dst_fbo;

    /* ── Readback ──────────────────────────────────────────────────── */
    if (pixel_count > state->pixel_buffer_size || !state->pixel_buffer) {
        emit_telemetry("readback", "warn", "pixel buffer too small", 0);
        return;
    }
    guchar *pixels = state->pixel_buffer;
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);

    GLenum gl_err = glGetError();
    if (gl_err != GL_NO_ERROR) {
        emit_telemetry("readback", "warn", "glReadPixels error", 0);
        return;
    }

    glFinish();
    eglSwapBuffers(state->display, state->surface);
    state->frame_count += 1;
    /* Y flip done in composite shader (uv.y = 1.0 - vTexCoord.y) */
    emit_frame_pixels(pixels, pixel_count, state->frame_count, width, height, stride, state);
    emit_frame_stat(state->frame_count, time_value);
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
        .pixel_buffer = NULL,
        .pixel_buffer_size = 0,
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
            int warp_type = get_int(obj, "warpType", 0);
            if (warp_type < 0) warp_type = 0;
            if (warp_type > 2) warp_type = 2;
            json_object_unref(obj);
            render_frame(&state, time_value, zoom, rot, dx, dy, decay_val,
                         energy, bass, mid, high,
                         warp_in_shader, warp_amount, warp_speed, warp_scale, warp_type);
            continue;
        }

        json_object_unref(obj);
    }

    free(line);
    g_free(state.shm_socket_path);
    shutdown_helper(&state);
    return 0;
}