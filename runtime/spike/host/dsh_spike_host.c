/*
 * dsh_spike_host.c — the M2 spike host shim, shared by every platform.
 *
 * Responsibilities (all in ONE thread, driven by the embedder):
 *   - unified-log sink: JS calls globalThis.__DSH_LOG_SINK__(jsonLine) and
 *     the host emits the canonical "dsh.spike.log: {...}" E2E line;
 *   - Web-API seams the vendored upstream package needs: crypto (getRandom-
 *     Values via the platform RNG) and btoa;
 *   - the REAL gateway bridge per contract/ v1.0.0: __dshGatewayCall hands
 *     each call a monotonic call_id and dispatches it to the embedder
 *     (multiple calls may be in flight); the embedder settles through
 *     dsh_spike_gateway_settle and streams events through
 *     dsh_spike_gateway_event — both RUNTIME-THREAD-ONLY (M1's canned
 *     responses are gone: the host no longer invents gateway results);
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

/* One in-flight gateway call: the promise capability JS owns a reference to
 * until the embedder settles it (or the runtime is torn down). */
typedef struct dsh_pending_call {
    int call_id;
    JSValue resolve;
    JSValue reject;
} dsh_pending_call;

typedef struct dsh_spike {
    JSRuntime *rt;
    JSContext *ctx;
    dsh_spike_sink sink;
    void (*bus)(void *ud, const char *line);
    void *bus_ud;
    dsh_spike_gateway_fn gateway;
    void *gateway_ud;
    char *descriptor;
    int next_call_id;
    dsh_pending_call *pending;
    int pending_count;
    int pending_cap;
    char base[512];
    char err[DSH_ERR_MAX];
    int completed;
    int passed;
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

/* JS → host bus post: one JSON line, handed to the embedder's bus sink. */
static JSValue js_bus_post(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 1 || !s->bus) return JS_UNDEFINED;
    const char *json = JS_ToCString(ctx, argv[0]);
    if (!json) return JS_EXCEPTION;
    s->bus(s->bus_ud, json);
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

/* ---- gateway bridge ----------------------------------------------------- */

static int dsh_pending_add(dsh_spike_t *s, int call_id, JSValue resolve,
                           JSValue reject) {
    if (s->pending_count == s->pending_cap) {
        int cap = s->pending_cap > 0 ? s->pending_cap * 2 : 8;
        dsh_pending_call *grown =
            realloc(s->pending, (size_t)cap * sizeof(dsh_pending_call));
        if (!grown) return -1;
        s->pending = grown;
        s->pending_cap = cap;
    }
    s->pending[s->pending_count++] =
        (dsh_pending_call){ call_id, resolve, reject };
    return 0;
}

/* Remove + return the entry for call_id, or 0 when absent (unknown or
 * already-settled ids fail loud at the settle call site). */
static int dsh_pending_take(dsh_spike_t *s, int call_id,
                            dsh_pending_call *out) {
    for (int i = 0; i < s->pending_count; i++) {
        if (s->pending[i].call_id == call_id) {
            *out = s->pending[i];
            s->pending[i] = s->pending[s->pending_count - 1];
            s->pending_count--;
            return 1;
        }
    }
    return 0;
}

/* JS → host dispatch: assign a call_id, park the promise capability, and
 * hand (call_id, name, args_json) to the embedder synchronously — it hops
 * the work off the runtime thread from there. */
static JSValue js_gateway_call(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "gateway call needs (name, argsJson)");
    }
    if (!s->gateway) {
        return JS_ThrowInternalError(ctx, "no gateway dispatch registered");
    }
    const char *name = JS_ToCString(ctx, argv[0]);
    const char *args = JS_ToCString(ctx, argv[1]);
    if (!name || !args) {
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, args);
        return JS_EXCEPTION;
    }
    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, args);
        return JS_EXCEPTION;
    }
    int call_id = ++s->next_call_id;
    if (dsh_pending_add(s, call_id, funcs[0], funcs[1]) != 0) {
        JS_FreeValue(ctx, funcs[0]);
        JS_FreeValue(ctx, funcs[1]);
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, args);
        return JS_ThrowOutOfMemory(ctx);
    }
    s->gateway(s->gateway_ud, call_id, name, args);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, args);
    return promise;
}

/* JS → host abort: no promise of its own — the embedder matches the
 * in-flight call (by the callId inside args_json) and cancels it. */
static JSValue js_gateway_abort(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (!s->gateway) {
        return JS_ThrowInternalError(ctx, "no gateway dispatch registered");
    }
    int32_t target = 0;
    if (argc < 1 || JS_ToInt32(ctx, &target, argv[0]) != 0) {
        return JS_ThrowTypeError(ctx, "gateway abort needs a call id");
    }
    char args[32];
    snprintf(args, sizeof(args), "{\"callId\":%d}", (int)target);
    s->gateway(s->gateway_ud, 0, "httpFetch.abort", args);
    return JS_UNDEFINED;
}

/* Descriptor accessor: the stored JSON verbatim, or "null" when never set. */
static JSValue js_gateway_descriptor(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    return JS_NewString(ctx, s->descriptor ? s->descriptor : "null");
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
    /* JS_ToCStringLen hands back UTF-8, but btoa's contract is latin-1:
     * upstream bytesToBase64 feeds char codes 0..255 (String.fromCharCode of
     * raw bytes), so decode the UTF-8 back to those codes — 1-byte sequences
     * cover 0x00..0x7F, 2-byte sequences 0x80..0xFF; anything wider is a
     * caller contract violation and fails loud. */
    unsigned char *bin = js_malloc(ctx, len + 1);
    if (!bin) { JS_FreeCString(ctx, in); return JS_EXCEPTION; }
    size_t n = 0;
    for (size_t i = 0; i < len;) {
        unsigned char c = (unsigned char)in[i];
        if (c < 0x80) {
            bin[n++] = c;
            i += 1;
        } else if ((c & 0xE0) == 0xC0 && i + 1 < len &&
                   ((unsigned char)in[i + 1] & 0xC0) == 0x80) {
            bin[n++] = (unsigned char)(((c & 0x1F) << 6) | (in[i + 1] & 0x3F));
            i += 2;
        } else {
            js_free(ctx, bin);
            JS_FreeCString(ctx, in);
            return JS_ThrowTypeError(ctx, "btoa input must be latin-1 (bytes 0..255)");
        }
    }
    JS_FreeCString(ctx, in);
    size_t out_len = ((n + 2) / 3) * 4;
    char *out = js_malloc(ctx, out_len + 1);
    if (!out) { js_free(ctx, bin); return JS_EXCEPTION; }
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned rem = (unsigned)(n - i);
        unsigned b0 = bin[i];
        unsigned b1 = i + 1 < n ? bin[i + 1] : 0;
        unsigned b2 = i + 2 < n ? bin[i + 2] : 0;
        out[o++] = B64_TABLE[b0 >> 2];
        out[o++] = B64_TABLE[((b0 & 3) << 4) | (b1 >> 4)];
        out[o++] = rem > 1 ? B64_TABLE[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out[o++] = rem > 2 ? B64_TABLE[b2 & 63] : '=';
    }
    out[o] = 0;
    js_free(ctx, bin);
    JSValue res = JS_NewString(ctx, out);
    js_free(ctx, out);
    return res;
}

/* ---- exception bookkeeping ---------------------------------------------- */

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

/* Drain the microtasks a delivery spun up (shared by bus_deliver, gateway
 * settle and gateway event). 0 quiescent, -1 exception. */
static int dsh_drain_jobs(dsh_spike_t *s) {
    int guard = 0;
    for (;;) {
        JSContext *jctx = NULL;
        int r = JS_ExecutePendingJob(s->rt, &jctx);
        if (r < 0 || JS_HasException(s->ctx)) {
            dsh_record_exception(s);
            return -1;
        }
        if (r == 0) return 0;
        if (++guard > DSH_PUMP_GUARD) {
            dsh_seterr(s, "%s", "drain guard exceeded — runaway microtask loop");
            return -1;
        }
    }
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
    JS_SetPropertyStr(ctx, global, "__dshBusPost",
                      JS_NewCFunction(ctx, js_bus_post, "__dshBusPost", 1));
    JS_SetPropertyStr(ctx, global, "__dshEngineInfo",
                      JS_NewCFunction(ctx, js_engine_info, "__dshEngineInfo", 0));
    JS_SetPropertyStr(ctx, global, "__dshGatewayNegotiate",
                      JS_NewCFunction(ctx, js_gateway_negotiate, "__dshGatewayNegotiate", 1));
    JS_SetPropertyStr(ctx, global, "__dshGatewayCall",
                      JS_NewCFunction(ctx, js_gateway_call, "__dshGatewayCall", 2));
    JS_SetPropertyStr(ctx, global, "__dshGatewayAbort",
                      JS_NewCFunction(ctx, js_gateway_abort, "__dshGatewayAbort", 1));
    JS_SetPropertyStr(ctx, global, "__dshGatewayDescriptor",
                      JS_NewCFunction(ctx, js_gateway_descriptor, "__dshGatewayDescriptor", 0));
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
        if (r == 0) return 0; /* quiescent — settle/event resume the runtime */
        if (++guard > DSH_PUMP_GUARD) {
            dsh_seterr(s, "%s", "pump guard exceeded — runaway microtask loop");
            return -1;
        }
    }
}

int dsh_spike_complete(const dsh_spike_t *s) { return s ? s->completed : 0; }

void dsh_spike_set_gateway_dispatch(dsh_spike_t *s, dsh_spike_gateway_fn on_call,
                                    void *ud) {
    if (!s) return;
    s->gateway = on_call;
    s->gateway_ud = ud;
}

void dsh_spike_set_descriptor(dsh_spike_t *s, const char *descriptor_json) {
    if (!s) return;
    free(s->descriptor);
    s->descriptor = descriptor_json ? strdup(descriptor_json) : NULL;
}

int dsh_spike_gateway_settle(dsh_spike_t *s, int call_id, int ok,
                             const char *payload_json) {
    if (!s || !payload_json) return -1;
    dsh_pending_call pc;
    if (!dsh_pending_take(s, call_id, &pc)) {
        snprintf(s->err, sizeof(s->err), "gateway settle: no in-flight call %d",
                 call_id);
        return -1; /* unknown or already-settled id — fail loud */
    }
    size_t len = strlen(payload_json);
    JSValue payload = JS_ParseJSON(s->ctx, payload_json, len, "<gateway>");
    if (JS_IsException(payload)) {
        dsh_record_exception(s);
        return -1;
    }
    JSValue fn = ok ? pc.resolve : pc.reject;
    JSValue res = JS_Call(s->ctx, fn, JS_UNDEFINED, 1, &payload);
    JS_FreeValue(s->ctx, payload);
    JS_FreeValue(s->ctx, pc.resolve);
    JS_FreeValue(s->ctx, pc.reject);
    if (JS_IsException(res)) {
        JS_FreeValue(s->ctx, res);
        dsh_record_exception(s);
        return -1;
    }
    JS_FreeValue(s->ctx, res);
    return dsh_drain_jobs(s);
}

int dsh_spike_gateway_event(dsh_spike_t *s, const char *event_json) {
    if (!s || !event_json) return -1;
    JSValue global = JS_GetGlobalObject(s->ctx);
    JSValue handler = JS_GetPropertyStr(s->ctx, global, "__dshGatewayOnEvent");
    JS_FreeValue(s->ctx, global);
    if (JS_IsUndefined(handler)) {
        JS_FreeValue(s->ctx, handler);
        return 0; /* scenario not subscribed yet: drop, mirroring bus_deliver */
    }
    JSValue arg = JS_NewString(s->ctx, event_json);
    if (JS_IsException(arg)) {
        JS_FreeValue(s->ctx, handler);
        dsh_record_exception(s);
        return -1;
    }
    JSValue res = JS_Call(s->ctx, handler, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(s->ctx, arg);
    JS_FreeValue(s->ctx, handler);
    if (JS_IsException(res)) {
        JS_FreeValue(s->ctx, res);
        dsh_record_exception(s);
        return -1;
    }
    JS_FreeValue(s->ctx, res);
    return dsh_drain_jobs(s);
}

void dsh_spike_set_bus_sink(dsh_spike_t *s,
                            void (*on_bus)(void *ud, const char *line),
                            void *ud) {
    if (!s) return;
    s->bus = on_bus;
    s->bus_ud = ud;
}

int dsh_spike_bus_deliver(dsh_spike_t *s, const char *line) {
    if (!s || !line) return -1;
    JSValue global = JS_GetGlobalObject(s->ctx);
    JSValue handler = JS_GetPropertyStr(s->ctx, global, "__dshBusOnMessage");
    JS_FreeValue(s->ctx, global);
    if (JS_IsUndefined(handler)) {
        JS_FreeValue(s->ctx, handler);
        return 0; /* scenario not subscribed yet: nothing to deliver into */
    }
    JSValue arg = JS_NewString(s->ctx, line);
    if (JS_IsException(arg)) {
        JS_FreeValue(s->ctx, handler);
        dsh_record_exception(s);
        return -1;
    }
    JSValue res = JS_Call(s->ctx, handler, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(s->ctx, arg);
    JS_FreeValue(s->ctx, handler);
    if (JS_IsException(res)) {
        JS_FreeValue(s->ctx, res);
        dsh_record_exception(s);
        return -1;
    }
    JS_FreeValue(s->ctx, res);
    return dsh_drain_jobs(s);
}

int dsh_spike_pass(const dsh_spike_t *s) { return s ? s->passed : 0; }

const char *dsh_spike_error(const dsh_spike_t *s) { return s ? s->err : ""; }

void dsh_spike_free(dsh_spike_t *s) {
    if (!s) return;
    if (s->ctx) {
        for (int i = 0; i < s->pending_count; i++) {
            JS_FreeValue(s->ctx, s->pending[i].resolve);
            JS_FreeValue(s->ctx, s->pending[i].reject);
        }
        JS_FreeContext(s->ctx);
    }
    if (s->rt) JS_FreeRuntime(s->rt);
    free(s->pending);
    free(s->descriptor);
    free(s);
}
