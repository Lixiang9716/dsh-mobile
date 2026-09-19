/*
 * dsh_spike_jni.c — JNI bridge for the Android M1 spike.
 *
 * Runs the whole scenario lifecycle (dsh_spike_new -> eval -> pump ->
 * complete) on the CALLING thread; Kotlin keeps that caller a single
 * dedicated HandlerThread for the life of the process, so the JS runtime is
 * touched by exactly one serial thread (ARCHITECTURE.md §6 thread rules).
 *
 * Each canonical E2E line the host sink receives goes out UNMODIFIED to both:
 *   - logcat under tag "dsh.spike" (the CI-captured stream), and
 *   - <contextDir>/spike-capture.log (verbatim second capture, pulled via adb).
 */
#include <jni.h>
#include <android/log.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dsh_spike_host.h"

#define DSH_LOG_TAG "dsh.spike"
#define DSH_RESULT_TAG "dsh.spike.result"
#define DSH_ENTRY "scenario/m1-spike-boot.js"
#define DSH_ENGINE_LABEL "quickjs-ng 0.17.0"

static void dsh_sink_log(void *ud, const char *line) {
    __android_log_print(ANDROID_LOG_INFO, DSH_LOG_TAG, "%s", line);
    FILE *capture = (FILE *)ud;
    if (capture) {
        fputs(line, capture);
        fputc('\n', capture);
        fflush(capture);
    }
}

static char *dsh_join_path(const char *dir, const char *rel) {
    size_t n = strlen(dir) + strlen(rel) + 2;
    char *out = malloc(n);
    if (out) {
        snprintf(out, n, "%s/%s", dir, rel);
    }
    return out;
}

/* Reads a whole file into a NUL-terminated heap buffer, or NULL. */
static char *dsh_read_all(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) {
        fclose(f);
        return NULL;
    }
    char *buf = malloc((size_t)n + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;
    return buf;
}

/* Exported JNI symbol. JNIEXPORT/JNICALL are deliberately NOT spelled out:
 * bionic defines them as visibility("default") + nothing, and the tree-sitter
 * syntax gate cannot parse the macro-prefixed declarator. The attribute keeps
 * the export explicit even if -fvisibility=hidden lands later. */
__attribute__((visibility("default")))
jstring Java_com_dshmobile_spike_SpikeRuntime_nativeRunSpike(
        JNIEnv *env, jobject thiz, jstring j_context_dir) {
    (void)thiz;
    const char *context = (*env)->GetStringUTFChars(env, j_context_dir, NULL);
    if (!context) {
        return NULL; /* OOM pending */
    }

    char *bundle_root = dsh_join_path(context, "spike");
    char *entry_path = bundle_root ? dsh_join_path(bundle_root, DSH_ENTRY) : NULL;
    char *capture_path = dsh_join_path(context, "spike-capture.log");
    char *source = entry_path ? dsh_read_all(entry_path) : NULL;
    FILE *capture = capture_path ? fopen(capture_path, "w") : NULL;

    const char *err = "";
    int passed = 0;
    if (!bundle_root || !source) {
        err = "bundle materialization failed — expected filesDir/spike/scenario/m1-spike-boot.js";
    } else {
        dsh_spike_sink sink = {dsh_sink_log, capture};
        dsh_spike_t *spike = dsh_spike_new(bundle_root, &sink);
        if (!spike) {
            err = "dsh_spike_new failed";
        } else {
            if (dsh_spike_eval(spike, DSH_ENTRY, source) != 0) {
                err = dsh_spike_error(spike);
            } else if (dsh_spike_pump(spike) != 0) {
                err = dsh_spike_error(spike);
            } else {
                err = dsh_spike_error(spike); /* "" on the happy path */
                passed = dsh_spike_complete(spike) && dsh_spike_pass(spike);
            }
            dsh_spike_free(spike);
        }
    }

    char result[768];
    snprintf(result, sizeof(result), "%s | %s%s%s",
             passed ? "PASS" : "FAIL", DSH_ENGINE_LABEL,
             (err && err[0]) ? " | error: " : "",
             (err && err[0]) ? err : "");
    __android_log_print(ANDROID_LOG_INFO, DSH_RESULT_TAG, "%s", result);

    free(source);
    free(entry_path);
    free(bundle_root);
    free(capture_path);
    if (capture) {
        fclose(capture);
    }
    (*env)->ReleaseStringUTFChars(env, j_context_dir, context);
    return (*env)->NewStringUTF(env, result);
}
