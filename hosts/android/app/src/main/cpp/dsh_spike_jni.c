/*
 * dsh_spike_jni.c — JNI bridge for the Android M4 spike host.
 *
 * Runs each scenario lifecycle (dsh_spike_new -> eval -> {pump, drain} ->
 * complete) on the CALLING thread; Kotlin keeps that caller a single
 * dedicated HandlerThread for the life of the process, so the JS runtime is
 * touched by exactly one serial thread (ARCHITECTURE.md §6 thread rules).
 * One launch drives BOTH scenarios: the boot.verification regression and the
 * gateway.bridge-smoke gateway-bridge scenario (backend in dsh_spike_smoke.c).
 *
 * Each canonical E2E line the host sink receives goes out UNMODIFIED to both:
 *   - logcat under tag "dsh.spike" (the CI-captured stream), and
 *   - <contextDir>/<per-scenario capture file> (verbatim second capture,
 *     pulled via adb run-as — truncation-proof cross-check).
 */
#include <jni.h>
#include <android/log.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "dsh_spike_host.h"
#include "dsh_spike_smoke.h"

#define DSH_LOG_TAG "dsh.spike"
#define DSH_RESULT_TAG "dsh.spike.result"
#define DSH_ENGINE_LABEL "quickjs-ng 0.17.0"
#define DSH_ERR_MAX 512

typedef struct dsh_scenario {
    const char *name;    /* canonical scenario id (checker manifest key) */
    const char *entry;   /* bundle-root-relative module path */
    const char *capture; /* capture file name inside the context dir */
} dsh_scenario;

static const dsh_scenario DSH_SCENARIOS[] = {
        {"boot.verification", "scenario/boot-verification.js",
         "spike-capture-boot-verification.log"},
        {"gateway.bridge-smoke", "scenario/gateway-bridge-smoke.js",
         "spike-capture-gateway-bridge-smoke.log"},
        {"session.mock-llm", "scenario/session-mock-llm.js",
         "spike-capture-session-mock-llm.log"},
};

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

/* Appends one per-scenario verdict line to the result tag and the response
 * buffer ("boot.verification PASS | quickjs-ng 0.17.0 | error: ..."). */
static void dsh_report(const dsh_scenario *sc, int passed, const char *err,
                       char *out, size_t out_sz) {
    char line[DSH_ERR_MAX + 128];
    snprintf(line, sizeof(line), "%s %s | %s%s%s", sc->name,
             passed ? "PASS" : "FAIL", DSH_ENGINE_LABEL,
             err[0] ? " | error: " : "", err[0] ? err : "");
    __android_log_print(ANDROID_LOG_INFO, DSH_RESULT_TAG, "%s", line);
    if (out[0]) {
        strncat(out, "\n", out_sz - strlen(out) - 1);
    }
    strncat(out, line, out_sz - strlen(out) - 1);
}

/* Runs ONE scenario end to end on the calling (runtime) thread. Returns 1
 * pass, 0 fail; err carries the failure description. fs scope "app" backs
 * onto <contextDir>/smoke-fs (the Android analogue of the CLI's tmpdir). */
static int dsh_run_scenario(const char *context, const dsh_scenario *sc,
                            char *err) {
    err[0] = 0;
    char *bundle_root = dsh_join_path(context, "spike");
    char *entry_path = bundle_root ? dsh_join_path(bundle_root, sc->entry) : NULL;
    char *capture_path = dsh_join_path(context, sc->capture);
    char *fs_root = dsh_join_path(context, "smoke-fs");
    char *source = entry_path ? dsh_read_all(entry_path) : NULL;
    FILE *capture = capture_path ? fopen(capture_path, "w") : NULL;
    int passed = 0;

    if (!bundle_root || !source) {
        snprintf(err, DSH_ERR_MAX,
                 "bundle materialization failed — expected filesDir/spike/%s",
                 sc->entry);
    } else if (!capture) {
        snprintf(err, DSH_ERR_MAX, "cannot open capture file %s", sc->capture);
    } else if (!fs_root) {
        snprintf(err, DSH_ERR_MAX, "out of memory");
    } else {
        dsh_spike_sink sink = {dsh_sink_log, capture};
        passed = dsh_smoke_run(bundle_root, sc->entry, source, fs_root, &sink,
                               err, DSH_ERR_MAX);
    }
    free(source);
    free(fs_root);
    free(entry_path);
    free(bundle_root);
    free(capture_path);
    if (capture) {
        fclose(capture);
    }
    return passed;
}

/* The gateway scope "app" backs onto a dedicated app-private directory
 * (created here, fail loud — a missing fs root is an embedder bug). */
static int dsh_prepare_fs_root(const char *context, char *err) {
    char *fs_root = dsh_join_path(context, "smoke-fs");
    if (!fs_root) {
        snprintf(err, DSH_ERR_MAX, "out of memory");
        return 0;
    }
    if (mkdir(fs_root, 0700) != 0 && errno != EEXIST) {
        snprintf(err, DSH_ERR_MAX, "cannot create smoke-fs dir: %s",
                 strerror(errno));
        free(fs_root);
        return 0;
    }
    free(fs_root);
    return 1;
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

    char *summary = malloc(DSH_ERR_MAX * 3);
    char err[DSH_ERR_MAX];
    summary[0] = 0;
    int all_pass = dsh_prepare_fs_root(context, err);
    if (!all_pass) {
        __android_log_print(ANDROID_LOG_ERROR, DSH_RESULT_TAG,
                            "fs root preparation failed: %s", err);
    }
    for (size_t i = 0; all_pass && i < sizeof(DSH_SCENARIOS) / sizeof(DSH_SCENARIOS[0]); i++) {
        const dsh_scenario *sc = &DSH_SCENARIOS[i];
        int passed = dsh_run_scenario(context, sc, err);
        all_pass = all_pass && passed;
        dsh_report(sc, passed, err, summary, DSH_ERR_MAX * 3);
    }
    snprintf(err, sizeof(err), "ALL %s", all_pass ? "PASS" : "FAIL");
    __android_log_print(ANDROID_LOG_INFO, DSH_RESULT_TAG, "%s", err);

    jstring result = (*env)->NewStringUTF(env, summary);
    free(summary);
    (*env)->ReleaseStringUTFChars(env, j_context_dir, context);
    return result;
}
