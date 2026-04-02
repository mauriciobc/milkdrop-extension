/**
 * milkdrop-gl-helper — offscreen EGL renderer using libprojectM.
 *
 * Protocol: JSON lines on stdin (init, resize, preset-change, frame, shutdown);
 * JSON lines on stdout (telemetry, frame-pixels, frame-pixels-fd, frame-stat).
 * Requires: EGL, OpenGL (or GLES 3.0), libprojectM-4, glib, json-glib.
 */

#define _GNU_SOURCE
#include <epoxy/egl.h>
#include <epoxy/gl.h>

#include <projectM-4/core.h>
#include <projectM-4/audio.h>
#include <projectM-4/parameters.h>
#include <projectM-4/render_opengl.h>
#include <projectM-4/types.h>

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
#include <fcntl.h>
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
    EGLConfig  egl_config;

    projectm_handle projectm;
    char *current_preset_path;
    char *texture_search_path;

    GLuint readback_fbo;
    GLuint readback_tex;

    int width;
    int height;
    int stride;
    unsigned long frame_count;
    bool initialized;
    bool invalid_surface_logged;

    char *shm_socket_path;
    GSocketConnection *shm_conn;
    guchar *pixel_buffer;
    gsize pixel_buffer_size;

    int    shm_fd[2];
    void  *shm_map[2];
    gsize  shm_map_size;
    int    shm_cur;
} HelperState;

#define PCM_SAMPLE_COUNT 576

/* ── Helpers ───────────────────────────────────────────────────────── */

static inline void
escape_json_string(const char *src, char *dst, size_t dst_size)
{
    if (!src || !dst || dst_size < 1) return;
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 6 < dst_size; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"')       { dst[j++] = '\\'; dst[j++] = '"'; }
        else if (c == '\\') { dst[j++] = '\\'; dst[j++] = '\\'; }
        else if (c == '\n') { dst[j++] = '\\'; dst[j++] = 'n'; }
        else if (c == '\r') { dst[j++] = '\\'; dst[j++] = 'r'; }
        else if (c == '\t') { dst[j++] = '\\'; dst[j++] = 't'; }
        else if (c < 0x20)  { j += (size_t)snprintf(dst + j, dst_size - j, "\\u%04x", c); }
        else                { dst[j++] = (char)c; }
    }
    dst[j] = '\0';
}

/* ── Telemetry / output helpers ─────────────────────────────────────── */

static void
emit_telemetry(const char *stage, const char *level, const char *msg, int ok)
{
    char escaped[2048];
    escape_json_string(msg ? msg : "", escaped, sizeof(escaped));
    printf("{\"type\":\"telemetry\",\"stage\":\"%s\",\"level\":\"%s\",\"ok\":%s,\"msg\":\"%s\"}\n",
        stage, level, ok ? "true" : "false", escaped);
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

/* ── SHM transport ──────────────────────────────────────────────────── */

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

/*
 * Re-open a memfd through /proc/self/fd so the sent descriptor has an
 * independent file offset. Using duplicated descriptors that share one open
 * file description can cause offset races when queued frame reads overlap.
 */
static int
open_fd_for_send(int fd)
{
#ifdef __linux__
    if (fd < 0)
        return -1;
    char path[64];
    g_snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
    int reopened = open(path, O_RDONLY | O_CLOEXEC);
    if (reopened >= 0)
        return reopened;
    return -1;
#else
    (void)fd;
    return -1;
#endif
}

/* ── JSON parsing (json-glib) ───────────────────────────────────────── */

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

static gchar *
get_string_dup(JsonObject *obj, const char *key)
{
    if (!obj || !json_object_has_member(obj, key))
        return NULL;
    const char *s = json_object_get_string_member(obj, key);
    return s ? g_strdup(s) : NULL;
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

/* ── Framebuffer creation ──────────────────────────────────────────── */

static bool
create_fbo(GLuint *fbo, GLuint *tex, int width, int height)
{
    glGenTextures(1, tex);
    glBindTexture(GL_TEXTURE_2D, *tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glGenFramebuffers(1, fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, *fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *tex, 0);

    GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glBindTexture(GL_TEXTURE_2D, 0);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
        emit_telemetry("fbo_init", "error", "framebuffer incomplete", 0);
        return false;
    }
    return true;
}

/* ── GL load proc for projectM ─────────────────────────────────────── */

static void *
gl_load_proc(const char *name, void *user_data)
{
    (void)user_data;
    return (void *)epoxy_eglGetProcAddress(name);
}

/* ── EGL + projectM initialisation ─────────────────────────────────── */

static bool
initialize_egl(HelperState *state, int width, int height)
{
    width  = width  > 0 ? width  : 1;
    height = height > 0 ? height : 1;

    state->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (state->display == EGL_NO_DISPLAY) {
        emit_telemetry("helper_init", "error", "eglGetDisplay failed", 0);
        return false;
    }

    if (!eglInitialize(state->display, NULL, NULL)) {
        emit_telemetry("helper_init", "error", "eglInitialize failed", 0);
        state->display = EGL_NO_DISPLAY;
        return false;
    }

    /* Try Desktop OpenGL 3.3 Core first (projectM default build). */
    const EGLint gl_config_attribs[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    const EGLint gl_ctx_attribs[] = {
        EGL_CONTEXT_MAJOR_VERSION, 3,
        EGL_CONTEXT_MINOR_VERSION, 3,
        EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
        EGL_NONE,
    };

    /* Fallback: GLES 3.0 (projectM ENABLE_GLES builds, ARM/embedded). */
    const EGLint es_config_attribs[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    const EGLint es_ctx_attribs[] = {
        EGL_CONTEXT_CLIENT_VERSION, 3,
        EGL_NONE,
    };

    EGLConfig config = NULL;
    EGLint num_config = 0;
    bool using_desktop_gl = false;

    if (eglBindAPI(EGL_OPENGL_API) &&
        eglChooseConfig(state->display, gl_config_attribs, &config, 1, &num_config) &&
        num_config >= 1) {
        using_desktop_gl = true;
    } else {
        emit_telemetry("helper_init", "info", "Desktop GL unavailable, trying GLES 3.0", 0);
        if (!eglBindAPI(EGL_OPENGL_ES_API) ||
            !eglChooseConfig(state->display, es_config_attribs, &config, 1, &num_config) ||
            num_config < 1) {
            emit_telemetry("helper_init", "error", "no suitable EGL config (need GL 3.3 or GLES 3.0)", 0);
            eglTerminate(state->display);
            state->display = EGL_NO_DISPLAY;
            return false;
        }
    }

    state->egl_config = config;

    EGLint pbuffer_attribs[] = { EGL_WIDTH, width, EGL_HEIGHT, height, EGL_NONE };
    state->surface = eglCreatePbufferSurface(state->display, config, pbuffer_attribs);
    if (state->surface == EGL_NO_SURFACE) {
        emit_telemetry("helper_init", "error", "eglCreatePbufferSurface failed", 0);
        eglTerminate(state->display);
        state->display = EGL_NO_DISPLAY;
        return false;
    }

    const EGLint *ctx_attribs = using_desktop_gl ? gl_ctx_attribs : es_ctx_attribs;
    state->context = eglCreateContext(state->display, config, EGL_NO_CONTEXT, ctx_attribs);
    if (state->context == EGL_NO_CONTEXT) {
        emit_telemetry("helper_init", "error", "eglCreateContext failed", 0);
        eglDestroySurface(state->display, state->surface);
        eglTerminate(state->display);
        state->display = EGL_NO_DISPLAY;
        state->surface = EGL_NO_SURFACE;
        return false;
    }

    if (!eglMakeCurrent(state->display, state->surface, state->surface, state->context)) {
        emit_telemetry("helper_init", "error", "eglMakeCurrent failed", 0);
        eglDestroyContext(state->display, state->context);
        eglDestroySurface(state->display, state->surface);
        eglTerminate(state->display);
        state->display = EGL_NO_DISPLAY;
        state->context = EGL_NO_CONTEXT;
        state->surface = EGL_NO_SURFACE;
        return false;
    }

    /* Create projectM instance */
    state->projectm = projectm_create_with_opengl_load_proc(gl_load_proc, NULL);
    if (!state->projectm) {
        emit_telemetry("helper_init", "error", "projectm_create failed", 0);
        goto fail_after_egl;
    }

    projectm_set_window_size(state->projectm, (size_t)width, (size_t)height);
    projectm_set_preset_locked(state->projectm, true);
    if (state->texture_search_path) {
        const char *paths[] = { state->texture_search_path };
        projectm_set_texture_search_paths(state->projectm, paths, 1);
    }

    state->width  = width;
    state->height = height;
    state->stride = width * 4;
    state->frame_count = 0;
    state->initialized = true;

    /* Pixel readback buffer */
    gsize need = (gsize)state->stride * (gsize)state->height;
    if (need > state->pixel_buffer_size) {
        g_free(state->pixel_buffer);
        state->pixel_buffer = g_malloc(need);
        state->pixel_buffer_size = state->pixel_buffer ? need : 0;
    }

    /* Readback FBO (texture-backed, avoids unreliable EGL pbuffer reads) */
    if (!create_fbo(&state->readback_fbo, &state->readback_tex, width, height)) {
        emit_telemetry("helper_init", "error", "create readback FBO failed", 0);
        projectm_destroy(state->projectm);
        state->projectm = NULL;
        goto fail_after_egl;
    }

    /* Persistent SHM double-buffer */
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

    const char *renderer = (const char *)glGetString(GL_RENDERER);
    const char *gl_version = (const char *)glGetString(GL_VERSION);
    printf("{\"type\":\"telemetry\",\"stage\":\"helper_init\",\"level\":\"info\",\"ok\":true,\"renderer\":\"projectM-%s\",\"gl\":\"%s\",\"api\":\"%s\"}\n",
        renderer ? renderer : "unknown",
        gl_version ? gl_version : "unknown",
        using_desktop_gl ? "GL" : "GLES");
    fflush(stdout);

    /* Signal readiness — gl-bridge.js recognises stage=program_ready as the
     * "helper is ready to receive frame messages" event. */
    emit_telemetry("program_ready", "info", "projectM rendering pipeline ready", 1);
    return true;

fail_after_egl:
    eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext(state->display, state->context);
    eglDestroySurface(state->display, state->surface);
    eglTerminate(state->display);
    state->display = EGL_NO_DISPLAY;
    state->context = EGL_NO_CONTEXT;
    state->surface = EGL_NO_SURFACE;
    state->initialized = false;
    return false;
}

/* ── Resize ────────────────────────────────────────────────────────── */

static bool
resize_buffers(HelperState *state, int width, int height)
{
    if (!state->initialized || !state->projectm)
        return false;

    width  = width  > 0 ? width  : 1;
    height = height > 0 ? height : 1;

    projectm_set_window_size(state->projectm, (size_t)width, (size_t)height);

    /* Recreate EGL pbuffer surface */
    EGLint pbuf_attr[] = { EGL_WIDTH, width, EGL_HEIGHT, height, EGL_NONE };
    eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (state->surface != EGL_NO_SURFACE)
        eglDestroySurface(state->display, state->surface);
    state->surface = eglCreatePbufferSurface(state->display, state->egl_config, pbuf_attr);
    if (state->surface == EGL_NO_SURFACE) {
        emit_telemetry("resize", "error", "eglCreatePbufferSurface failed", 0);
        state->surface = EGL_NO_SURFACE;
        return false;
    }
    if (!eglMakeCurrent(state->display, state->surface, state->surface, state->context)) {
        emit_telemetry("resize", "error", "eglMakeCurrent failed after resize", 0);
        eglDestroySurface(state->display, state->surface);
        state->surface = EGL_NO_SURFACE;
        return false;
    }
    state->invalid_surface_logged = false;

    state->width  = width;
    state->height = height;
    state->stride = width * 4;

    const gsize need = (gsize)state->stride * (gsize)state->height;

    if (need > state->pixel_buffer_size) {
        g_free(state->pixel_buffer);
        state->pixel_buffer = g_malloc(need);
        state->pixel_buffer_size = state->pixel_buffer ? need : 0;
    }

    /* Recreate readback FBO */
    if (state->readback_fbo) { glDeleteFramebuffers(1, &state->readback_fbo); state->readback_fbo = 0; }
    if (state->readback_tex) { glDeleteTextures(1, &state->readback_tex); state->readback_tex = 0; }
    if (!create_fbo(&state->readback_fbo, &state->readback_tex, width, height)) {
        emit_telemetry("resize", "error", "create readback fbo failed", 0);
        return false;
    }

    /* Recreate SHM double-buffer */
#ifdef __linux__
    if (state->shm_socket_path) {
        for (int i = 0; i < 2; i++) {
            if (state->shm_map[i]) {
                munmap(state->shm_map[i], state->shm_map_size);
                state->shm_map[i] = NULL;
            }
            if (state->shm_fd[i] >= 0) {
                close(state->shm_fd[i]);
                state->shm_fd[i] = -1;
            }
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

    emit_telemetry("resize", "info", "resize_ok", 1);
    return true;
}

/* ── Render frame ──────────────────────────────────────────────────── */

static void
render_frame(HelperState *state, double time_value,
             const float *pcm_left, const float *pcm_right, int pcm_count,
             const char *preset_path)
{
    if (!state->initialized || !state->projectm || !state->readback_fbo)
        return;
    if (state->surface == EGL_NO_SURFACE) {
        if (!state->invalid_surface_logged) {
            emit_telemetry("render", "error", "surface unavailable; skipping frame", 0);
            state->invalid_surface_logged = true;
        }
        return;
    }
    state->invalid_surface_logged = false;

    const int width = state->width;
    const int height = state->height;
    const int stride = state->stride;
    if (width < 1 || height < 1 || stride < width * 4) {
        emit_telemetry("render", "warn", "invalid dimensions; skipping frame", 0);
        return;
    }

    /* Load preset if changed */
    if (preset_path && preset_path[0]) {
        if (!state->current_preset_path || strcmp(preset_path, state->current_preset_path) != 0) {
            if (!g_file_test(preset_path, G_FILE_TEST_IS_REGULAR)) {
                emit_telemetry("preset", "warn", "preset path is not a readable file; skipping load", 0);
            } else {
                g_free(state->current_preset_path);
                state->current_preset_path = g_strdup(preset_path);
                projectm_load_preset_file(state->projectm, preset_path, false);
            }
        }
    }

    projectm_set_frame_time(state->projectm, time_value);

    /* Feed interleaved stereo PCM to projectM */
    if (pcm_count > 0 && pcm_left && pcm_right) {
        unsigned int max_samples = projectm_pcm_get_max_samples();
        int count = (int)((unsigned int)pcm_count > max_samples ? max_samples : (unsigned int)pcm_count);
        float *interleaved = g_alloca((size_t)count * 2 * sizeof(float));
        for (int i = 0; i < count; i++) {
            interleaved[i * 2]     = pcm_left[i];
            interleaved[i * 2 + 1] = pcm_right[i];
        }
        projectm_pcm_add_float(state->projectm, interleaved, (unsigned int)count, PROJECTM_STEREO);
    }

    const gsize pixel_count = (gsize)stride * (gsize)height;

    gint64 render_start = g_get_monotonic_time();

    PERF_BEGIN(projectm_render);
    glBindFramebuffer(GL_FRAMEBUFFER, state->readback_fbo);
    {
        GLenum fb_status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        if (fb_status != GL_FRAMEBUFFER_COMPLETE) {
            char msg[96];
            g_snprintf(msg, sizeof(msg), "readback FBO incomplete (0x%04x)", (unsigned)fb_status);
            emit_telemetry("render", "warn", msg, 0);
            PERF_END(projectm_render);
            return;
        }
    }
    glViewport(0, 0, width, height);
    projectm_opengl_render_frame_fbo(state->projectm, state->readback_fbo);
    PERF_END(projectm_render);

    gint64 render_end = g_get_monotonic_time();
    gint64 render_us = render_end - render_start;
    gint64 readback_start = render_end;

    /* ── Readback ──────────────────────────────────────────────────── */
    PERF_BEGIN(readback);
    if (pixel_count > state->pixel_buffer_size || !state->pixel_buffer) {
        emit_telemetry("readback", "warn", "pixel buffer too small", 0);
        if (state->surface != EGL_NO_SURFACE)
            eglSwapBuffers(state->display, state->surface);
        state->frame_count += 1;
        PERF_END(readback);
        emit_frame_stat(state->frame_count, time_value, render_us, 0);
        return;
    }

    for (int _drain = 0; _drain < 64 && glGetError() != GL_NO_ERROR; _drain++) {}
    glBindFramebuffer(GL_FRAMEBUFFER, state->readback_fbo);

    /* When SHM double-buffer is ready, read directly into the mapped region to
     * avoid a full-frame memcpy after glReadPixels. Retain pixel_buffer as the
     * destination for the temporary-memfd path. */
#ifdef __linux__
    int _shm_direct_idx = -1;
    if (state->shm_socket_path && state->shm_map[state->shm_cur])
        _shm_direct_idx = state->shm_cur;
    guchar *readback_dest = (_shm_direct_idx >= 0)
        ? (guchar *)state->shm_map[_shm_direct_idx]
        : state->pixel_buffer;
#else
    guchar *readback_dest = state->pixel_buffer;
#endif

    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, readback_dest);
    GLenum gl_err = glGetError();
    bool readback_ok = (gl_err == GL_NO_ERROR);
    if (!readback_ok) {
        char errmsg[64];
        g_snprintf(errmsg, sizeof(errmsg), "glReadPixels error (gl_err=0x%04x)", gl_err);
        emit_telemetry("readback", "warn", errmsg, 0);
    }

    if (state->surface != EGL_NO_SURFACE)
        eglSwapBuffers(state->display, state->surface);
    state->frame_count += 1;

    if (readback_ok) {
        bool sent = false;
#ifdef __linux__
        if (state->shm_socket_path) {
            int idx = state->shm_cur;
            if (state->shm_map[idx]) {
                /* Pixels already in shm_map[idx] when _shm_direct_idx >= 0;
                 * only copy if glReadPixels went to pixel_buffer instead. */
                if (_shm_direct_idx < 0)
                    memcpy(state->shm_map[idx], state->pixel_buffer, pixel_count);
                int send_fd = open_fd_for_send(state->shm_fd[idx]);
                if (send_fd >= 0) {
                    sent = emit_frame_pixels_shm_fd(state, send_fd,
                                                    state->frame_count, width, height, stride);
                    close(send_fd);
                } else {
                    emit_telemetry("shm_send_fd", "warn", "failed to reopen shm fd for send", 0);
                }
                state->shm_cur = 1 - idx;
            } else {
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
        if (!sent) {
            emit_telemetry("readback", "warn",
                           "failed to deliver frame pixels via SHM/FD transport", 0);
        }
    }

    PERF_END(readback);
    emit_frame_stat(state->frame_count, time_value, render_us,
                    g_get_monotonic_time() - readback_start);
}

/* ── Shutdown ──────────────────────────────────────────────────────── */

static void
shutdown_helper(HelperState *state)
{
    if (state->projectm) {
        projectm_destroy(state->projectm);
        state->projectm = NULL;
    }

    if (state->readback_fbo) { glDeleteFramebuffers(1, &state->readback_fbo); state->readback_fbo = 0; }
    if (state->readback_tex) { glDeleteTextures(1, &state->readback_tex); state->readback_tex = 0; }

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

/* ── Main loop ─────────────────────────────────────────────────────── */

typedef enum {
    MSG_LOOP_CONTINUE,
    MSG_LOOP_BREAK,
} MessageLoopResult;

static MessageLoopResult
dispatch_stdin_message(JsonObject *obj, HelperState *state)
{
    if (message_has_type(obj, "shutdown")) {
        json_object_unref(obj);
        return MSG_LOOP_BREAK;
    }

    if (message_has_type(obj, "init")) {
        int w = get_int(obj, "width", 320);
        int h = get_int(obj, "height", 180);
        gchar *tex_path = get_string_dup(obj, "texturePath");
        json_object_unref(obj);
        if (tex_path) {
            g_free(state->texture_search_path);
            state->texture_search_path = tex_path;
        }
        if (!initialize_egl(state, w, h))
            return MSG_LOOP_BREAK;
        return MSG_LOOP_CONTINUE;
    }

    if (message_has_type(obj, "resize")) {
        int w = get_int(obj, "width", state->width);
        int h = get_int(obj, "height", state->height);
        json_object_unref(obj);
        if (state->initialized && (w != state->width || h != state->height))
            resize_buffers(state, w, h);
        return MSG_LOOP_CONTINUE;
    }

    if (message_has_type(obj, "preset-change")) {
        gchar *path = get_string_dup(obj, "path");
        json_object_unref(obj);
        if (path) {
            if (g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
                g_free(state->current_preset_path);
                state->current_preset_path = path;
                if (state->projectm)
                    projectm_load_preset_file(state->projectm, path, false);
            } else {
                emit_telemetry("preset", "warn", "preset-change path is not a regular file; ignoring", 0);
                g_free(path);
            }
        }
        return MSG_LOOP_CONTINUE;
    }

    /* Backward-compat: ignore compile-default / compile-shaders / mesh */
    if (message_has_type(obj, "compile-default") ||
        message_has_type(obj, "compile-shaders") ||
        message_has_type(obj, "mesh")) {
        json_object_unref(obj);
        return MSG_LOOP_CONTINUE;
    }

    if (message_has_type(obj, "frame")) {
        double time_value = get_double(obj, "time", 0.0);
        gchar *preset_path = get_string_dup(obj, "presetPath");
        GLfloat pcm_left[PCM_SAMPLE_COUNT];
        GLfloat pcm_right[PCM_SAMPLE_COUNT];
        int pl = parse_pcm_data(obj, "pcmLeft", pcm_left);
        int pr = parse_pcm_data(obj, "pcmRight", pcm_right);
        int pcm_count = pl >= pr ? pl : pr;
        json_object_unref(obj);
        render_frame(state, time_value, pcm_left, pcm_right, pcm_count,
                     preset_path ? preset_path : state->current_preset_path);
        g_free(preset_path);
        return MSG_LOOP_CONTINUE;
    }

    json_object_unref(obj);
    return MSG_LOOP_CONTINUE;
}

static void
parse_argv(int argc, char **argv, HelperState *state)
{
    for (int i = 1; i < argc; i++) {
        if (g_str_equal(argv[i], "--shm-socket-path") && i + 1 < argc) {
            g_free(state->shm_socket_path);
            state->shm_socket_path = g_strdup(argv[i + 1]);
            i++;
        } else if (g_str_equal(argv[i], "--texture-path") && i + 1 < argc) {
            g_free(state->texture_search_path);
            state->texture_search_path = g_strdup(argv[i + 1]);
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
        .projectm = NULL,
        .current_preset_path = NULL,
        .texture_search_path = NULL,
        .shm_socket_path = NULL,
        .shm_conn = NULL,
        .pixel_buffer = NULL,
        .pixel_buffer_size = 0,
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
        if (!obj)
            continue;
        if (dispatch_stdin_message(obj, &state) == MSG_LOOP_BREAK)
            break;
    }
    free(line);

    g_free(state.shm_socket_path);
    g_free(state.current_preset_path);
    g_free(state.texture_search_path);
    shutdown_helper(&state);
    return 0;
}
