/*
 * dsh_spike_m4.c — JNI bridge for the Android M4 completion session
 * (carrier + WebView mount + the real nine-primitive gateway binding).
 * Sibling of dsh_spike_jni.c: one fresh dsh_spike_t on the CALLING thread
 * (Kotlin keeps that caller the single HandlerThread), the frozen bridge
 * order — descriptor before eval, gateway dispatch + bus sink registered
 * before eval — and settle/event re-entry points the Kotlin driver hops
 * onto the runtime queue. Kotlin callbacks arrive through the M4Bridge
 * object (onGatewayCall / onBusLine) while the runtime drives eval/pump.
 *
 * The m4 session is process-single (the m4 activity drives exactly one),
 * so the bridge context (global ref + capture file) hangs off one static.
 */
#include <jni.h>
#include <android/log.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dsh_spike_host.h"

#define M4_LOG_TAG "dsh.spike"
#define M4_ERR_MAX 512

/* Last C-side failure description; confined to the runtime thread (every
 * entry point below runs there), so a static buffer cannot race. */
static char g_m4_err[M4_ERR_MAX];

typedef struct m4_ctx {
    JavaVM *vm;
    jobject bridge; /* global ref */
    FILE *capture;
} m4_ctx;

static m4_ctx *g_m4_ctx = NULL;

static void m4_sink_log(void *ud, const char *line) {
    __android_log_print(ANDROID_LOG_INFO, M4_LOG_TAG, "%s", line);
    FILE *capture = (FILE *)ud;
    if (capture) {
        fputs(line, capture);
        fputc('\n', capture);
        fflush(capture);
    }
}

/* JNI env for callbacks: the dispatch/bus callbacks always fire on a thread
 * already attached (they run inside a JNI entry point) — GetEnv succeeds. */
static JNIEnv *m4_env(void) {
    JNIEnv *env = NULL;
    if (!g_m4_ctx ||
        (*g_m4_ctx->vm)->GetEnv(g_m4_ctx->vm, (void **)&env, JNI_VERSION_1_6)
            != JNI_OK) {
        return NULL;
    }
    return env;
}

static void m4_call_void(const char *method, const char *sig, jvalue *args) {
    JNIEnv *env = m4_env();
    if (!env) {
        snprintf(g_m4_err, M4_ERR_MAX, "callback thread not attached");
        return;
    }
    jclass cls = (*env)->GetObjectClass(env, g_m4_ctx->bridge);
    jmethodID mid = (*env)->GetMethodID(env, cls, method, sig);
    (*env)->DeleteLocalRef(env, cls);
    if (!mid) {
        snprintf(g_m4_err, M4_ERR_MAX, "bridge method %s missing", method);
        return;
    }
    (*env)->CallVoidMethodA(env, g_m4_ctx->bridge, mid, args);
}

/* on_call: fires SYNCHRONOUSLY ON THE RUNTIME THREAD during the call. */
static void m4_on_call(void *ud, int call_id, const char *name,
                       const char *args_json) {
    (void)ud;
    JNIEnv *env = m4_env();
    if (!env || !name || !args_json) {
        snprintf(g_m4_err, M4_ERR_MAX, "gateway dispatch without env/args");
        return;
    }
    jstring j_name = (*env)->NewStringUTF(env, name);
    jstring j_args = (*env)->NewStringUTF(env, args_json);
    jvalue args[3];
    args[0].i = call_id;
    args[1].l = j_name;
    args[2].l = j_args;
    m4_call_void("onGatewayCall", "(ILjava/lang/String;Ljava/lang/String;)V",
                 args);
    (*env)->DeleteLocalRef(env, j_name);
    (*env)->DeleteLocalRef(env, j_args);
}

/* Bus sink: one JSON line posted from JS (runtime thread). */
static void m4_on_bus(void *ud, const char *line) {
    (void)ud;
    JNIEnv *env = m4_env();
    if (!env || !line) return;
    jstring j_line = (*env)->NewStringUTF(env, line);
    jvalue args[1];
    args[0].l = j_line;
    m4_call_void("onBusLine", "(Ljava/lang/String;)V", args);
    (*env)->DeleteLocalRef(env, j_line);
}

static char *m4_join(const char *dir, const char *rel) {
    size_t n = strlen(dir) + strlen(rel) + 2;
    char *out = malloc(n);
    if (out) snprintf(out, n, "%s/%s", dir, rel);
    return out;
}

/*
 * Creates the runtime, wires the frozen bridge, evaluates the entry module,
 * and pumps once. Returns the handle (nonzero) or 0 on failure (details via
 * nativeM4Last, same thread).
 */
__attribute__((visibility("default")))
jlong Java_com_dshmobile_spike_SpikeRuntime_nativeM4Begin(
        JNIEnv *env, jobject thiz, jstring j_context, jstring j_entry,
        jstring j_source, jstring j_descriptor, jobject bridge) {
    (void)thiz;
    g_m4_err[0] = 0;
    const char *context = (*env)->GetStringUTFChars(env, j_context, NULL);
    const char *entry = (*env)->GetStringUTFChars(env, j_entry, NULL);
    const char *source = (*env)->GetStringUTFChars(env, j_source, NULL);
    const char *descriptor = (*env)->GetStringUTFChars(env, j_descriptor, NULL);
    if (!context || !entry || !source || !descriptor) {
        snprintf(g_m4_err, M4_ERR_MAX, "GetStringUTFChars failed");
        return 0;
    }
    m4_ctx *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) {
        snprintf(g_m4_err, M4_ERR_MAX, "out of memory");
        return 0;
    }
    ctx->capture = NULL;
    (*env)->GetJavaVM(env, &ctx->vm);
    ctx->bridge = (*env)->NewGlobalRef(env, bridge);
    /* Published BEFORE eval: the gateway dispatch and bus sink callbacks
     * fire while eval/pump run, and they resolve their JNIEnv through it. */
    g_m4_ctx = ctx;
    char *bundle_root = m4_join(context, "spike");
    char *capture_path =
            m4_join(context, "spike-capture-m4-host-binding.log");
    FILE *capture = capture_path ? fopen(capture_path, "w") : NULL;
    dsh_spike_t *spike = NULL;
    if (!bundle_root || !capture) {
        snprintf(g_m4_err, M4_ERR_MAX,
                 "bundle/capture materialization failed");
    } else {
        dsh_spike_sink sink = {m4_sink_log, capture};
        spike = dsh_spike_new(bundle_root, &sink);
        if (!spike) {
            snprintf(g_m4_err, M4_ERR_MAX, "dsh_spike_new failed");
        }
    }
    free(bundle_root);
    free(capture_path);
    if (spike) {
        dsh_spike_set_descriptor(spike, descriptor);
        dsh_spike_set_gateway_dispatch(spike, m4_on_call, ctx);
        dsh_spike_set_bus_sink(spike, m4_on_bus, ctx);
        if (dsh_spike_eval(spike, entry, source) != 0 ||
            dsh_spike_pump(spike) != 0) {
            snprintf(g_m4_err, M4_ERR_MAX, "%s", dsh_spike_error(spike));
            dsh_spike_free(spike);
            spike = NULL;
        }
    }
    if (spike) {
        ctx->capture = capture;
    } else {
        if (capture) fclose(capture);
        (*env)->DeleteGlobalRef(env, ctx->bridge);
        free(ctx);
        g_m4_ctx = NULL;
    }
    (*env)->ReleaseStringUTFChars(env, j_context, context);
    (*env)->ReleaseStringUTFChars(env, j_entry, entry);
    (*env)->ReleaseStringUTFChars(env, j_source, source);
    (*env)->ReleaseStringUTFChars(env, j_descriptor, descriptor);
    return (jlong)(intptr_t)spike;
}

/* Shared pump+completion check after settle/event/bus deliveries.
 * 0 = running, 1 = complete pass, 2 = complete fail, -1 = error. */
static jint m4_status(dsh_spike_t *spike) {
    if (dsh_spike_pump(spike) != 0) {
        snprintf(g_m4_err, M4_ERR_MAX, "%s", dsh_spike_error(spike));
        return -1;
    }
    if (!dsh_spike_complete(spike)) return 0;
    return dsh_spike_pass(spike) ? 1 : 2;
}

__attribute__((visibility("default")))
jint Java_com_dshmobile_spike_SpikeRuntime_nativeM4Settle(
        JNIEnv *env, jobject thiz, jlong handle, jint call_id, jint ok,
        jstring j_payload) {
    (void)thiz;
    dsh_spike_t *spike = (dsh_spike_t *)(intptr_t)handle;
    const char *payload = (*env)->GetStringUTFChars(env, j_payload, NULL);
    if (!payload) return -1;
    jint status = -1;
    if (dsh_spike_gateway_settle(spike, call_id, ok, payload) != 0) {
        snprintf(g_m4_err, M4_ERR_MAX, "%s", dsh_spike_error(spike));
    } else {
        status = m4_status(spike);
    }
    (*env)->ReleaseStringUTFChars(env, j_payload, payload);
    return status;
}

__attribute__((visibility("default")))
jint Java_com_dshmobile_spike_SpikeRuntime_nativeM4Event(
        JNIEnv *env, jobject thiz, jlong handle, jstring j_json) {
    (void)thiz;
    dsh_spike_t *spike = (dsh_spike_t *)(intptr_t)handle;
    const char *json = (*env)->GetStringUTFChars(env, j_json, NULL);
    if (!json) return -1;
    jint status = -1;
    if (dsh_spike_gateway_event(spike, json) != 0) {
        snprintf(g_m4_err, M4_ERR_MAX, "%s", dsh_spike_error(spike));
    } else {
        status = m4_status(spike);
    }
    (*env)->ReleaseStringUTFChars(env, j_json, json);
    return status;
}

__attribute__((visibility("default")))
jint Java_com_dshmobile_spike_SpikeRuntime_nativeM4BusDeliver(
        JNIEnv *env, jobject thiz, jlong handle, jstring j_line) {
    (void)thiz;
    dsh_spike_t *spike = (dsh_spike_t *)(intptr_t)handle;
    const char *line = (*env)->GetStringUTFChars(env, j_line, NULL);
    if (!line) return -1;
    jint status = -1;
    if (dsh_spike_bus_deliver(spike, line) != 0) {
        snprintf(g_m4_err, M4_ERR_MAX, "%s", dsh_spike_error(spike));
    } else {
        status = m4_status(spike);
    }
    (*env)->ReleaseStringUTFChars(env, j_line, line);
    return status;
}

__attribute__((visibility("default")))
jstring Java_com_dshmobile_spike_SpikeRuntime_nativeM4Last(JNIEnv *env,
                                                           jobject thiz) {
    (void)thiz;
    return (*env)->NewStringUTF(env, g_m4_err);
}

/* Frees the runtime and releases the bridge global ref + capture file. */
__attribute__((visibility("default")))
void Java_com_dshmobile_spike_SpikeRuntime_nativeM4End(JNIEnv *env,
                                                       jobject thiz,
                                                       jlong handle) {
    (void)thiz;
    dsh_spike_free((dsh_spike_t *)(intptr_t)handle);
    if (g_m4_ctx) {
        if (g_m4_ctx->capture) fclose(g_m4_ctx->capture);
        (*env)->DeleteGlobalRef(env, g_m4_ctx->bridge);
        free(g_m4_ctx);
        g_m4_ctx = NULL;
    }
}
