/*
 * dsh_spike_host.c — the M1 spike host shim, shared by every platform.
 *
 * Responsibilities (all in ONE thread, driven by the embedder):
 *   - unified-log sink: JS calls globalThis.__DSH_LOG_SINK__(jsonLine) and
 *     the host emits the canonical "dsh.spike.log: {...}" E2E line;
 *   - Web-API seams the vendored upstream package needs: crypto (getRandom-
 *     Values via the platform RNG) and btoa;
 *   - the gateway bridge per contract/ v1.0.0: negotiate "gateway@1",
 *     async primitive calls returned as promises the host settles on a
 *     LATER pump tick (proving the dispatch-onto-runtime-queue pattern),
 *     and the declared-unavailable conformance path (keychainGet);
 *   - an ESM loader over the spike bundle: "dsh:util-crypto" maps to the
 *     vendored package; everything else resolves bundle-root-relative.
 */
#include "dsh_spike_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs.h"

#define DSH_LOG_PREFIX "dsh.spike.log: "
#define DSH_ERR_MAX 512
#define DSH_PUMP_GUARD 100000

static const char *DSH_GATEWAY_VERSION = "gateway@1";
static const char *DSH_PKG_CRYPTO = "dsh:util-crypto";
static const char *DSH_PKG_CRYPTO_PATH = "vendor/dsh/util-crypto@0.1.6-alpha.1/lib/index.js";

typedef struct dsh_spike {
    JSRuntime *rt;
    JSContext *ctx;
    dsh_spike_sink sink;
    char base[512];
    char err[DSH_ERR_MAX];
    int completed;
    int passed;
    /* one in-flight gateway call at a time is all the spike scenario needs */
    int has_pending;
    char pending_name[64];
    JSValue pending_resolve;
    JSValue pending_reject;
} dsh_spike_t;

static void dsh_seterr(dsh_spike_t *s, const char *fmt, const char *arg) {
    snprintf(s->err, sizeof(s->err), fmt, arg);
}

static void dsh_emit(dsh_spike_t *s, const char *json_line) {
    if (!s->sink.on_log) return;
    size_t n = strlen(DSH_LOG_PREFIX) + strlen(json_line) + 2;
    char *line = malloc(n);
    if (!line) return;
    snprintf(line, n, "%s%s", DSH_LOG_PREFIX, json_line);
    s->sink.on_log(s->sink.ud, line);
    free(line);
}

/* ---- platform RNG ------------------------------------------------------- */

static void dsh_random_bytes(unsigned char *buf, size_t n) {
#if defined(__APPLE__) || defined(__ANDROID__) || defined(__OpenBSD__) || \
    defined(__NetBSD__) || defined(__FreeBSD__)
    arc4random_buf(buf, n);
#elif defined(__linux__)
    while (n > 0) {
        if (getentropy(buf, n > 256 ? 256 : n) == 0) {
            size_t k = n > 256 ? 256 : n;
            buf += k; n -= k;
        } else {
            break;
        }
    }
    if (n > 0) { /* fall through to the fallback below */ }
#else
    /* No platform RNG declared: deterministic LCG fallback. Spike-only —
     * real hosts replace this via their platform shim before M2. */
    static unsigned long long state = 0;
    if (!state) state = (unsigned long long)time(NULL) | 1;
    for (size_t i = 0; i < n; i++) {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        buf[i] = (unsigned char)(state >> 33);
    }
#endif
}

/* ---- native bindings ---------------------------------------------------- */

static JSValue js_log_sink(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 1) return JS_UNDEFINED;
    size_t len = 0;
    const char *json = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!json) return JS_EXCEPTION;
    size_t n = strlen(DSH_LOG_PREFIX) + len + 2;
    char *line = malloc(n);
    if (line) {
        snprintf(line, n, "%s%s", DSH_LOG_PREFIX, json);
        s->sink.on_log(s->sink.ud, line);
        free(line);
    }
    JS_FreeCString(ctx, json);
    return JS_UNDEFINED;
}

static JSValue js_engine_info(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "name", JS_NewString(ctx, "quickjs-ng"));
    JS_SetPropertyStr(ctx, info, "version", JS_NewString(ctx, "0.17.0"));
    return info;
}

static JSValue js_gateway_negotiate(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 1) return JS_FALSE;
    const char *requested = JS_ToCString(ctx, argv[0]);
    if (!requested) return JS_EXCEPTION;
    int ok = strcmp(requested, DSH_GATEWAY_VERSION) == 0;
    JS_FreeCString(ctx, requested);
    if (!ok) dsh_seterr(s, "gateway negotiation rejected: %s", requested);
    return JS_NewBool(ctx, ok);
}

static JSValue js_gateway_call(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 1) return JS_ThrowTypeError(ctx, "gateway call needs a name");
    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    if (s->has_pending) {
        JS_FreeCString(ctx, name);
        return JS_ThrowInternalError(ctx, "gateway bridge is single-call in the spike");
    }
    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, name);
        return JS_EXCEPTION;
    }
    snprintf(s->pending_name, sizeof(s->pending_name), "%s", name);
    s->pending_resolve = funcs[0];
    s->pending_reject = funcs[1];
    s->has_pending = 1;
    JS_FreeCString(ctx, name);
    return promise;
}

static JSValue js_complete(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    int pass = JS_ToBool(ctx, argv[0]); /* -1 on exception; anything falsy = fail */
    s->completed = 1;
    s->passed = pass > 0;
    return JS_UNDEFINED;
}

static JSValue js_get_random_values(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "getRandomValues needs an array");
    size_t size = 0;
    uint8_t *buf = JS_GetUint8Array(ctx, &size, argv[0]);
    if (!buf) return JS_EXCEPTION;
    dsh_random_bytes(buf, size);
    return JS_DupValue(ctx, argv[0]);
}

static const char B64_TABLE[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static JSValue js_btoa(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "btoa needs a string");
    size_t len = 0;
    const char *in = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!in) return JS_EXCEPTION;
    /* The spike only feeds btoa ASCII byte strings; UTF-8 re-encoding of
     * code points >127 is out of scope until a real Web-API shim lands. */
    size_t out_len = ((len + 2) / 3) * 4;
    char *out = js_malloc(ctx, out_len + 1);
    if (!out) { JS_FreeCString(ctx, in); return JS_EXCEPTION; }
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned b0 = (unsigned char)in[i];
        unsigned b1 = i + 1 < len ? (unsigned char)in[i + 1] : 0;
        unsigned b2 = i + 2 < len ? (unsigned char)in[i + 2] : 0;
        out[o++] = B64_TABLE[b0 >> 2];
        out[o++] = B64_TABLE[((b0 & 3) << 4) | (b1 >> 4)];
        out[o++] = i + 1 < len ? B64_TABLE[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out[o++] = i + 2 < len ? B64_TABLE[b2 & 63] : '=';
    }
    out[o] = 0;
    JS_FreeCString(ctx, in);
    JSValue res = JS_NewString(ctx, out);
    js_free(ctx, out);
    return res;
}

/* ---- gateway canned responses (settled on a LATER pump tick) ------------ */

static void dsh_settle_pending(dsh_spike_t *s) {
    JSValue payload = JS_NewObject(s->ctx);
    int reject = 0;
    if (strcmp(s->pending_name, "fsRead") == 0) {
        JS_SetPropertyStr(s->ctx, payload, "bytes", JS_NewInt32(s->ctx, 17));
        JS_SetPropertyStr(s->ctx, payload, "text",
                          JS_NewString(s->ctx, "hello from host"));
    } else if (strcmp(s->pending_name, "keychainGet") == 0) {
        reject = 1;
        JS_SetPropertyStr(s->ctx, payload, "code",
                          JS_NewString(s->ctx, "unavailable"));
        JS_SetPropertyStr(s->ctx, payload, "message",
                          JS_NewString(s->ctx, "keychain is not available on this platform"));
    } else {
        reject = 1;
        JS_SetPropertyStr(s->ctx, payload, "code", JS_NewString(s->ctx, "unknown"));
        JS_SetPropertyStr(s->ctx, payload, "message",
                          JS_NewString(s->ctx, "no canned response for this primitive"));
    }
    JSValue fn = reject ? s->pending_reject : s->pending_resolve;
    JS_Call(s->ctx, fn, JS_UNDEFINED, 1, &payload);
    JS_FreeValue(s->ctx, payload);
    JS_FreeValue(s->ctx, s->pending_resolve);
    JS_FreeValue(s->ctx, s->pending_reject);
    s->pending_resolve = JS_UNDEFINED;
    s->pending_reject = JS_UNDEFINED;
    s->has_pending = 0;
}

static void dsh_record_exception(dsh_spike_t *s) {
    JSValue exc = JS_GetException(s->ctx);
    const char *msg = JS_ToCString(s->ctx, exc);
    dsh_seterr(s, "%s", msg ? msg : "JS exception");
    if (msg) JS_FreeCString(s->ctx, msg);
    if (!JS_IsNull(exc) && !JS_IsUndefined(exc)) {
        JSValue stacked = JS_GetPropertyStr(s->ctx, exc, "stack");
        if (!JS_IsUndefined(stacked)) {
            const char *st = JS_ToCString(s->ctx, stacked);
            if (st) {
                strncat(s->err, " | stack: ", sizeof(s->err) - strlen(s->err) - 1);
                strncat(s->err, st, sizeof(s->err) - strlen(s->err) - 1);
                JS_FreeCString(s->ctx, st);
            }
        }
        JS_FreeValue(s->ctx, stacked);
    }
    JS_FreeValue(s->ctx, exc);
}

/* ---- ESM loader --------------------------------------------------------- */

static char *dsh_join(const char *a, const char *b) {
    size_t n = strlen(a) + strlen(b) + 2;
    char *out = malloc(n);
    if (out) snprintf(out, n, "%s/%s", a, b);
    return out;
}

static char *dsh_read_file(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = 0;
    if (out_len) *out_len = got;
    return buf;
}

static JSModuleDef *dsh_load_module(JSContext *ctx, const char *abs_path, const char *name) {
    size_t len = 0;
    char *buf = dsh_read_file(abs_path, &len);
    if (!buf) {
        JS_ThrowReferenceError(ctx, "cannot load module '%s'", name);
        return NULL;
    }
    JSValue res = JS_Eval(ctx, buf, len, name,
                          JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(buf);
    if (JS_IsException(res)) return NULL;
    /* quickjs-ng loader contract: the compiled module value's pointer IS the
     * JSModuleDef*; the importer already holds a reference, so free the value. */
    JSModuleDef *m = (JSModuleDef *)JS_VALUE_GET_PTR(res);
    JS_FreeValue(ctx, res);
    return m;
}

static JSModuleDef *dsh_module_loader(JSContext *ctx, const char *name, void *opaque) {
    dsh_spike_t *s = (dsh_spike_t *)opaque;
    const char *rel = NULL;
    if (strncmp(name, DSH_PKG_CRYPTO, strlen(DSH_PKG_CRYPTO)) == 0) {
        rel = DSH_PKG_CRYPTO_PATH;
    } else if (name[0] == '/') {
        rel = name + 1;
    } else {
        rel = name;
    }
    char *abs = dsh_join(s->base, rel);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    JSModuleDef *m = dsh_load_module(ctx, abs, name);
    free(abs);
    return m;
}

static char *dsh_normalize(JSContext *ctx, const char *base_name, const char *name,
                           void *opaque) {
    (void)opaque;
    /* "dsh:*" passes through; relative names resolve against the importer's
     * directory; everything else is bundle-root-relative. */
    if (strncmp(name, "dsh:", 4) == 0 || name[0] == '/') {
        return js_strdup(ctx, name);
    }
    char merged[768];
    if (name[0] == '.' && base_name && strchr(base_name, '/')) {
        char dir[512];
        snprintf(dir, sizeof(dir), "%s", base_name);
        char *slash = strrchr(dir, '/');
        if (slash) *slash = 0;
        snprintf(merged, sizeof(merged), "%s/%s", dir, name);
    } else {
        snprintf(merged, sizeof(merged), "%s", name);
    }
    return js_strdup(ctx, merged);
}

/* ---- lifecycle ---------------------------------------------------------- */

static void dsh_bind_globals(dsh_spike_t *s) {
    JSContext *ctx = s->ctx;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__DSH_LOG_SINK__",
                      JS_NewCFunction(ctx, js_log_sink, "__DSH_LOG_SINK__", 1));
    JS_SetPropertyStr(ctx, global, "__dshEngineInfo",
                      JS_NewCFunction(ctx, js_engine_info, "__dshEngineInfo", 0));
    JS_SetPropertyStr(ctx, global, "__dshGatewayNegotiate",
                      JS_NewCFunction(ctx, js_gateway_negotiate, "__dshGatewayNegotiate", 1));
    JS_SetPropertyStr(ctx, global, "__dshGatewayCall",
                      JS_NewCFunction(ctx, js_gateway_call, "__dshGatewayCall", 2));
    JS_SetPropertyStr(ctx, global, "__dshComplete",
                      JS_NewCFunction(ctx, js_complete, "__dshComplete", 2));
    JSValue btoa_fn = JS_NewCFunction(ctx, js_btoa, "btoa", 1);
    JS_SetPropertyStr(ctx, global, "btoa", btoa_fn);
    JSValue crypto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, crypto, "getRandomValues",
                      JS_NewCFunction(ctx, js_get_random_values, "getRandomValues", 1));
    JS_SetPropertyStr(ctx, global, "crypto", crypto);
    JS_FreeValue(ctx, global);
}

dsh_spike_t *dsh_spike_new(const char *bundle_root, const dsh_spike_sink *sink) {
    if (!bundle_root || !sink || !sink->on_log) return NULL;
    dsh_spike_t *s = calloc(1, sizeof(dsh_spike_t));
    if (!s) return NULL;
    s->sink = *sink;
    snprintf(s->base, sizeof(s->base), "%s", bundle_root);
    s->pending_resolve = JS_UNDEFINED;
    s->pending_reject = JS_UNDEFINED;
    s->rt = JS_NewRuntime();
    if (!s->rt) { free(s); return NULL; }
    JS_SetRuntimeOpaque(s->rt, s);
    JS_SetModuleLoaderFunc(s->rt, dsh_normalize, dsh_module_loader, s);
    s->ctx = JS_NewContext(s->rt);
    if (!s->ctx) { JS_FreeRuntime(s->rt); free(s); return NULL; }
    JS_SetContextOpaque(s->ctx, s);
    dsh_bind_globals(s);
    return s;
}

int dsh_spike_eval(dsh_spike_t *s, const char *module_name, const char *source) {
    if (!s || !module_name || !source) return -1;
    s->err[0] = 0;
    size_t len = strlen(source);
    JSValue res = JS_Eval(s->ctx, source, len, module_name, JS_EVAL_TYPE_MODULE);
    if (JS_IsException(res)) {
        dsh_record_exception(s);
        return -1;
    }
    JS_FreeValue(s->ctx, res);
    return 0;
}

int dsh_spike_pump(dsh_spike_t *s) {
    if (!s) return -1;
    int guard = 0;
    for (;;) {
        JSContext *jctx = NULL;
        int r = JS_ExecutePendingJob(s->rt, &jctx);
        if (r < 0) {
            dsh_record_exception(s);
            return -1;
        }
        if (r == 0) {
            if (s->has_pending) {
                dsh_settle_pending(s);
                if (JS_HasException(s->ctx)) {
                    dsh_record_exception(s);
                    return -1;
                }
                continue; /* settling queued new microtasks */
            }
            return 0; /* quiescent */
        }
        if (++guard > DSH_PUMP_GUARD) {
            dsh_seterr(s, "%s", "pump guard exceeded — runaway microtask loop");
            return -1;
        }
    }
}

int dsh_spike_complete(const dsh_spike_t *s) { return s ? s->completed : 0; }

int dsh_spike_pass(const dsh_spike_t *s) { return s ? s->passed : 0; }

const char *dsh_spike_error(const dsh_spike_t *s) { return s ? s->err : ""; }

void dsh_spike_free(dsh_spike_t *s) {
    if (!s) return;
    if (s->ctx) {
        JS_FreeValue(s->ctx, s->pending_resolve);
        JS_FreeValue(s->ctx, s->pending_reject);
        JS_FreeContext(s->ctx);
    }
    if (s->rt) JS_FreeRuntime(s->rt);
    free(s);
}
