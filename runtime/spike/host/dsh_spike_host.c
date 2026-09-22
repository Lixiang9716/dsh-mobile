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
 *   - an ESM loader over the spike bundle: "dsh:util-crypto" (legacy spike
 *     specifier), bare npm specifiers (@deepseek-ai/<pkg>, zod) map into the
 *     vendored upstream closure, node: builtins map to the spike shims
 *     (runtime/spike/upstream/shims/), everything else resolves
 *     bundle-root-relative; unmapped bare specifiers fail loud.
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
/* The pinned upstream runtime version this build maps bare specifiers to
 * (runtime/spike/vendor/ensure-dsh.sh is the single source of the pin). */
static const char *DSH_UPSTREAM_VERSION = "0.1.6-alpha.2";
/* Legacy spike specifier (m1 spike boot): kept working on the alpha.2 pin. */
static const char *DSH_PKG_CRYPTO = "dsh:util-crypto";
static const char *DSH_PKG_CRYPTO_PATH = "vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js";

/* node: builtin → spike shim under upstream/shims/. Only builtins the vendored
 * closure actually imports are mapped; anything else fails loud at import time
 * naming the specifier (rule 5) so a missing seam is never silently wrong. */
static const char *dsh_node_shim(const char *name) {
    static const struct { const char *spec; const char *path; } SHIMS[] = {
        { "node:path", "upstream/shims/path.js" },
        { "node:crypto", "upstream/shims/crypto.js" },
        { "node:async_hooks", "upstream/shims/async-hooks.js" },
        { "node:util", "upstream/shims/util.js" },
        { "node:util/types", "upstream/shims/util-types.js" },
        { "node:fs", "upstream/shims/fs.js" },
        { "node:fs/promises", "upstream/shims/fs-promises.js" },
        { "node:timers/promises", "upstream/shims/timers-promises.js" },
        /* node:buffer: imported by @deepseek-ai/dsh-attachment (and by the
         * fs-promises shim the file tools need) — Buffer.from / concat /
         * byteLength / isBuffer over the Uint8Array-backed DshBuffer. */
        { "node:buffer", "upstream/shims/buffer.js" },
        { "node:os", "upstream/shims/os.js" },
        { "node:process", "upstream/shims/process.js" },
        { "node:module", "upstream/shims/node-module.js" },
        { "node:url", "upstream/shims/url.js" },
    };
    for (size_t i = 0; i < sizeof(SHIMS) / sizeof(SHIMS[0]); i++) {
        if (strcmp(name, SHIMS[i].spec) == 0) return SHIMS[i].path;
    }
    return NULL;
}

/* One in-flight gateway call: the promise capability JS owns a reference to
 * until the embedder settles it (or the runtime is torn down). */
typedef struct dsh_pending_call {
    int call_id;
    JSValue resolve;
    JSValue reject;
} dsh_pending_call;

/* A runtime-defined module: source registered under a specifier so
 * `import(specifier)` resolves to it (the M3 install pipeline — the gateway
 * fs scopes are NOT the ESM loader's filesystem, so an installed plugin's
 * bytes reach the loader through this seam instead of a bundle-root path;
 * real hosts will load installed modules from their storage directly). */
typedef struct dsh_def_module {
    char *name;
    char *source;
    size_t source_len;
    struct dsh_def_module *next;
} dsh_def_module;

typedef struct dsh_spike {
    JSRuntime *rt;
    JSContext *ctx;
    dsh_spike_sink sink;
    void (*bus)(void *ud, const char *line);
    void *bus_ud;
    dsh_spike_gateway_fn gateway;
    void *gateway_ud;
    char *descriptor;
    char *launch_env;
    dsh_def_module *defined;
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

/* Launch-env accessor: the stored JSON object verbatim, or "{}". */
static JSValue js_launch_env(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    return JS_NewString(ctx, s->launch_env ? s->launch_env : "{}");
}

static JSValue js_complete(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    (void)argc;
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

/* atob: base64 → latin-1 string (the btoa inverse; used by vendored zod
 * base64-format validation and cosmokit helpers). */
static int dsh_b64_val(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static JSValue js_atob(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "atob needs a string");
    size_t len = 0;
    const char *in = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!in) return JS_EXCEPTION;
    char *out = js_malloc(ctx, len + 1);
    if (!out) { JS_FreeCString(ctx, in); return JS_EXCEPTION; }
    size_t o = 0;
    unsigned acc = 0;
    unsigned bits = 0;
    int pad = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '=') { pad++; continue; }
        int v = dsh_b64_val(c);
        if (v < 0 || pad > 0) {
            js_free(ctx, out);
            JS_FreeCString(ctx, in);
            return JS_ThrowTypeError(ctx, "atob input is not valid base64");
        }
        acc = (acc << 6) | (unsigned)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (char)((acc >> bits) & 0xFF);
        }
    }
    JS_FreeCString(ctx, in);
    /* every trailing '=' group must land on a byte boundary */
    if (bits >= 6 && o > 0) { /* leftover bits that cannot form a byte */
        js_free(ctx, out);
        return JS_ThrowTypeError(ctx, "atob input is not valid base64");
    }
    out[o] = 0;
    JSValue res = JS_NewStringLen(ctx, out, o);
    js_free(ctx, out);
    return res;
}

/* ---- node:module require seam ------------------------------------------- */

/* ESM-loader helpers live below; forward-declared here. */
static char *dsh_join(const char *a, const char *b);
static char *dsh_read_file(const char *path, size_t *out_len);
static int dsh_map_bare(const char *name, char *out, size_t out_len, char *err, size_t err_len);

/* Lexically resolve "." / ".." segments of a relative request against the
 * directory of `rel` (both bundle-root-relative, no trailing slash). Fills
 * `out` and returns 1, or returns 0 when the request escapes the bundle root
 * (caller fails loud). */
static int dsh_require_resolve(const char *rel, const char *request, char *out, size_t out_len) {
    (void)out_len;   /* writes into a fixed-size caller buffer; see the constants below */
    char dir[512];
    char joined[768];
    snprintf(dir, sizeof(dir), "%s", rel);
    char *slash = strrchr(dir, '/');
    if (slash) *slash = 0; else dir[0] = 0;
    if (dir[0] == 0) snprintf(joined, sizeof(joined), "%s", request);
    else snprintf(joined, sizeof(joined), "%s/%s", dir, request);
    /* split on '/', collapsing "." and popping ".." */
    char *segs[64];
    size_t lens[64];
    size_t depth = 0;
    char *tok = joined;
    int escape = 0;
    while (*tok) {
        char *next = strchr(tok, '/');
        size_t len = next ? (size_t)(next - tok) : strlen(tok);
        if (len == 2 && tok[0] == '.' && tok[1] == '.') {
            if (depth == 0) { escape = 1; break; }
            depth--;
        } else if (!(len == 1 && tok[0] == '.')) {
            if (depth >= 64) { escape = 1; break; }
            segs[depth] = tok; lens[depth] = len; depth++;
        }
        if (!next) break;
        tok = next + 1;
    }
    if (escape) return 0;
    size_t o = 0;
    for (size_t i = 0; i < depth; i++) {
        if (o) out[o++] = '/';
        memcpy(out + o, segs[i], lens[i]); o += lens[i];
    }
    out[o] = 0;
    return 1;
}

/* JS global __dshBundleRequire(base, request): the node:module seam's file
 * read. `base` is the importing module's name (a bare specifier — resolved
 * through the same bare map the loader owns, so the specifier→vendor mapping
 * lives in exactly one place — or a bundle-root-relative path); `request` a
 * relative path from its directory. ONLY package-style JSON reads are served
 * (upstream reads ../package.json through createRequire for attribution
 * headers); everything else fails loud. Returns the raw file text. */
static JSValue js_bundle_require(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "__dshBundleRequire needs (base, request)");
    }
    const char *base = JS_ToCString(ctx, argv[0]);
    const char *request = JS_ToCString(ctx, argv[1]);
    if (!base || !request) {
        JS_FreeCString(ctx, base);
        JS_FreeCString(ctx, request);
        return JS_EXCEPTION;
    }
    char rel[512];
    char maperr[256];
    int kind = dsh_map_bare(base, rel, sizeof(rel), maperr, sizeof(maperr));
    if (kind < 0) {
        JS_ThrowReferenceError(ctx, "%s", maperr);
        goto fail;
    }
    if (kind == 0) {
        if (base[0] == '/') snprintf(rel, sizeof(rel), "%s", base + 1);
        else snprintf(rel, sizeof(rel), "%s", base);
    }
    if (strncmp(request, "./", 2) != 0 && strncmp(request, "../", 3) != 0) {
        JS_ThrowTypeError(ctx,
            "require('%s'): only relative package-style reads are served (node:fs is not mounted)", request);
        goto fail;
    }
    char resolved[600];
    if (!dsh_require_resolve(rel, request, resolved, sizeof(resolved))
        || resolved[0] == 0 || strstr(resolved, "..") != NULL) {
        JS_ThrowReferenceError(ctx, "require('%s' from %s) escapes the bundle root", request, base);
        goto fail;
    }
    size_t rlen = strlen(resolved);
    if (rlen < 6 || strcmp(resolved + rlen - 5, ".json") != 0) {
        JS_ThrowTypeError(ctx, "require('%s'): only .json reads are served by the spike host", request);
        goto fail;
    }
    char *abs = dsh_join(s->base, resolved);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        goto fail;
    }
    size_t len = 0;
    char *text = dsh_read_file(abs, &len);
    free(abs);
    if (!text) {
        JS_ThrowReferenceError(ctx, "require('%s') from %s: cannot read '%s'", request, base, resolved);
        goto fail;
    }
    JSValue result = JS_NewStringLen(ctx, text, len);
    free(text);
    JS_FreeCString(ctx, base);
    JS_FreeCString(ctx, request);
    return result;
fail:
    JS_FreeCString(ctx, base);
    JS_FreeCString(ctx, request);
    return JS_EXCEPTION;
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

/* Compile module source under a name (the loader's one compile site).
 * `url` is what import.meta.url pins to: the module NAME for entry scripts,
 * the bundle-relative staged path for mapped modules — the path is what lets
 * a vendored package locate ITS OWN files (agent-presets resolves presets/
 * beside lib/ through new URL('../presets/', import.meta.url); the url shim's
 * path URLs and the bundle-require seam both speak bundle-relative paths). */
static JSModuleDef *dsh_compile_module_url(JSContext *ctx, const char *name,
                                           const char *url,
                                           const char *buf, size_t len) {
    JSValue res = JS_Eval(ctx, buf, len, name,
                          JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(res)) return NULL;
    /* quickjs-ng loader contract: the compiled module value's pointer IS the
     * JSModuleDef*; the importer already holds a reference, so free the value. */
    JSModuleDef *m = (JSModuleDef *)JS_VALUE_GET_PTR(res);
    JSValue meta = JS_GetImportMeta(ctx, m);
    if (!JS_IsException(meta)) {
        JS_SetPropertyStr(ctx, meta, "url", JS_NewString(ctx, url));
        JS_FreeValue(ctx, meta);
    }
    JS_FreeValue(ctx, res);
    return m;
}

static JSModuleDef *dsh_load_module(JSContext *ctx, const char *abs_path,
                                    const char *name, const char *url) {
    size_t len = 0;
    char *buf = dsh_read_file(abs_path, &len);
    if (!buf) {
        JS_ThrowReferenceError(ctx, "cannot load module '%s'", name);
        return NULL;
    }
    JSModuleDef *m = dsh_compile_module_url(ctx, name, url, buf, len);
    free(buf);
    return m;
}

/* js global __dshModuleDefine(name, source): register a module SOURCE under
 * a specifier (M3 install pipeline — see the dsh_def_module note). A second
 * define for the same name replaces the source (install transactions may
 * replay); already-instantiated modules stay cached per QuickJS semantics. */
static JSValue js_module_define(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "__dshModuleDefine needs (name, source)");
    }
    size_t source_len = 0;
    const char *name = JS_ToCString(ctx, argv[0]);
    const char *source = JS_ToCStringLen(ctx, &source_len, argv[1]);
    if (!name || !source) {
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, source);
        return JS_EXCEPTION;
    }
    dsh_def_module *m = s->defined;
    while (m && strcmp(m->name, name) != 0) m = m->next;
    if (m) {
        free(m->source);
        m->source = strdup(source);
        m->source_len = source_len;
    } else {
        m = malloc(sizeof(*m));
        if (!m) goto oom;
        m->name = strdup(name);
        m->source = strdup(source);
        m->source_len = source_len;
        if (!m->name || !m->source) {
            free(m->name); free(m->source); free(m);
            goto oom;
        }
        m->next = s->defined;
        s->defined = m;
    }
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, source);
    return JS_NewBool(ctx, 1);
oom:
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, source);
    return JS_ThrowOutOfMemory(ctx);
}

/* Map one bare module specifier to a bundle-root-relative file path.
 * Returns NULL when the specifier is not bare (caller falls back to path
 * resolution) and fills `err` when it is bare but unmapped (fail loud).
 *
 * Layers, in the system's dependency direction (D6/D9: upstream packages run
 * verbatim; platform differences live in the shim layer, never in vendored
 * copies):
 *   - "@deepseek-ai/dsh-llm[/sub]" — the VENDORED dsh-llm package (the W-LLM
 *     leg): bare falls through the generic dsh- map; subpaths follow the
 *     package's real exports map (lib/types JS re-exports), anything else
 *     fails loud naming the specifier.
 *   - "@deepseek-ai/dsh-session-persistence" — errors-only shim (agent-loop
 *     imports SessionPersistenceNotFoundError at module load).
 *   - node:<builtin> — the node shims (table above).
 *   - "@deepseek-ai/dsh-<pkg>[/sub]" — vendored upstream runtime packages
 *     (VERBATIM tarballs; sub "invariant" → lib/invariant.js, other lib-level
 *     subpaths resolve under lib/; the /types subpaths are type-only upstream
 *     and fail loud with a dedicated message).
 *   - "@deepseek-ai/{cordis,cosmokit,schemastery}", "zod" — pinned npm deps
 *     of the closure.
 */
static int dsh_map_bare(const char *name, char *out, size_t out_len, char *err, size_t err_len) {
    if (strncmp(name, "node:", 5) == 0) {
        const char *path = dsh_node_shim(name);
        if (!path) {
            snprintf(err, err_len, "no spike shim for node builtin '%s' (see runtime/spike/upstream/README.md)", name);
            return -1;
        }
        snprintf(out, out_len, "%s", path);
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/dsh-llm") == 0) {
        snprintf(out, out_len, "vendor/dsh/llm@%s/lib/index.js", DSH_UPSTREAM_VERSION);
        return 1;
    }
    if (strncmp(name, "@deepseek-ai/dsh-llm/", 21) == 0) {
        /* The vendored package's runtime exports map (package.json "exports"):
         * subpath → path under lib/. The /types subpath is a RUNTIME module
         * here (unlike the other dsh-* packages where it is type-only). */
        static const struct { const char *sub; const char *lib; } LLM_SUBS[] = {
            { "invariant", "invariant.js" },
            { "message", "types/message.js" },
            { "assistant-stream", "types/assistant-stream.js" },
            { "types", "types/types.js" },
            { "typert", "typert.host.js" },
            { "remote", "typert.remote-client.js" },
        };
        const char *sub = name + 21;
        for (size_t i = 0; i < sizeof(LLM_SUBS) / sizeof(LLM_SUBS[0]); i++) {
            if (strcmp(sub, LLM_SUBS[i].sub) == 0) {
                snprintf(out, out_len, "vendor/dsh/llm@%s/lib/%s",
                         DSH_UPSTREAM_VERSION, LLM_SUBS[i].lib);
                return 1;
            }
        }
        snprintf(err, err_len,
                 "'%s' is not a runtime subpath of the vendored dsh-llm exports map", name);
        return -1;
    }
    if (strcmp(name, "@deepseek-ai/dsh-session-persistence") == 0) {
        snprintf(out, out_len, "upstream/shims/dsh-session-persistence.js");
        return 1;
    }
    /* @deepseek-ai/dsh-client-modules is an NPM-published package (the web
     * boot composer), not a dsh-desktop runtime tarball — mapped to the
     * vendor/npm tree (W-INTEG web-boot leg). The runtime exports map follows
     * the package's own "exports" face: bare, ./client, ./invariant. */
    if (strncmp(name, "@deepseek-ai/dsh-client-modules", 31) == 0) {
        const char *sub = name + 31;
        const char *lib = "index.js"; /* bare specifier */
        if (sub[0] == 0) {
            lib = "index.js";
        } else if (strcmp(sub, "/client") == 0) {
            lib = "client.js";
        } else if (strcmp(sub, "/invariant") == 0) {
            lib = "invariant.js";
        } else {
            snprintf(err, err_len,
                     "'%s' is not a runtime subpath of the vendored dsh-client-modules exports map", name);
            return -1;
        }
        snprintf(out, out_len,
                 "vendor/npm/@deepseek-ai/dsh-client-modules@%s/lib/%s",
                 DSH_UPSTREAM_VERSION, lib);
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/dsh-atomic-write") == 0) {
        snprintf(out, out_len, "vendor/dsh/atomic-write@0.0.1-rc.1/lib/index.js");
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/dsh-home-paths") == 0) {
        snprintf(out, out_len, "vendor/dsh/home-paths@0.0.1-rc.3/lib/index.js");
        return 1;
    }
    /* NOTE: these two sit BEFORE the generic dsh- rule below — that rule pins
     * DSH_UPSTREAM_VERSION, which would build paths for versions that do not
     * exist (both packages version on their own 0.0.1-rc stream). */
    if (strncmp(name, "@deepseek-ai/dsh-", 17) == 0) {
        const char *rest = name + 17;
        const char *slash = strchr(rest, '/');
        size_t pkg_len = slash ? (size_t)(slash - rest) : strlen(rest);
        if (slash == NULL) {
            snprintf(out, out_len, "vendor/dsh/%.*s@%s/lib/index.js",
                     (int)pkg_len, rest, DSH_UPSTREAM_VERSION);
            return 1;
        }
        const char *sub = slash + 1;
        if (strncmp(sub, "types", 5) == 0 && (sub[5] == 0 || sub[5] == '/')) {
            snprintf(err, err_len,
                     "'%s' is a type-only subpath upstream; not mapped at runtime", name);
            return -1;
        }
        snprintf(out, out_len, "vendor/dsh/%.*s@%s/lib/%s", (int)pkg_len, rest,
                 DSH_UPSTREAM_VERSION, sub);
        return 1;
    }
    /* The agent-presets closure (the Agent 预设 panel's data source) — same
     * rule as dsh-client-modules: npm-published packages outside the
     * dsh-desktop runtime version stream, mapped to their vendor/npm trees.
     * atomic-write and home-paths ARE dsh-* packages, but their versions ride
     * their own stream (0.0.1-rc.x), so the generic dsh- map's shared version
     * constant cannot build their paths. */
    if (strcmp(name, "@deepseek-ai/cordis-plugin-loader") == 0) {
        snprintf(out, out_len,
                 "vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js");
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/cordis-plugin-include") == 0) {
        snprintf(out, out_len,
                 "vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js");
        return 1;
    }
    if (strcmp(name, "js-yaml") == 0) {
        snprintf(out, out_len, "vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs");
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/cordis") == 0) {
        snprintf(out, out_len, "vendor/npm/cordis@4.0.2/lib/index.js");
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/cosmokit") == 0) {
        snprintf(out, out_len, "vendor/npm/cosmokit@1.8.3/lib/index.js");
        return 1;
    }
    if (strcmp(name, "@deepseek-ai/schemastery") == 0) {
        snprintf(out, out_len, "vendor/npm/schemastery@3.18.2/lib/index.mjs");
        return 1;
    }
    if (strcmp(name, "zod") == 0) {
        snprintf(out, out_len, "vendor/npm/zod@4.4.3/index.js");
        return 1;
    }
    if (strncmp(name, "zod/", 4) == 0) {
        snprintf(out, out_len, "vendor/npm/zod@4.4.3/%s", name + 4);
        return 1;
    }
    return 0; /* not a bare specifier the loader owns */
}

static JSModuleDef *dsh_module_loader(JSContext *ctx, const char *name, void *opaque) {
    dsh_spike_t *s = (dsh_spike_t *)opaque;
    /* Runtime-defined modules first (install pipeline + shim overrides), then
     * the bare-specifier map, then the bundle root on disk. */
    for (dsh_def_module *m = s->defined; m; m = m->next) {
        if (strcmp(m->name, name) == 0) {
            return dsh_compile_module_url(ctx, name, name, m->source, m->source_len);
        }
    }
    const char *rel = NULL;
    char mapped[512];
    char maperr[256];
    if (strncmp(name, DSH_PKG_CRYPTO, strlen(DSH_PKG_CRYPTO)) == 0) {
        rel = DSH_PKG_CRYPTO_PATH;
    } else if (strncmp(name, "dsh:", 4) == 0) {
        JS_ThrowReferenceError(ctx, "unknown dsh: specifier '%s'", name);
        return NULL;
    } else {
        int kind = dsh_map_bare(name, mapped, sizeof(mapped), maperr, sizeof(maperr));
        if (kind < 0) {
            JS_ThrowReferenceError(ctx, "%s", maperr);
            return NULL;
        }
        if (kind == 1) {
            rel = mapped;
        } else if (name[0] == '/') {
            rel = name + 1;
        } else if (name[0] == '.') {
            JS_ThrowReferenceError(ctx, "relative import '%s' escaped its module root", name);
            return NULL;
        } else if (strchr(name, '.') != NULL || strchr(name, '/') != NULL) {
            /* Legacy spike behavior: bundle-root-relative module paths
             * ('logger.js', 'gateway.js', 'upstream/boot.js', scenarios). */
            rel = name;
        } else {
            JS_ThrowReferenceError(ctx,
                "unmapped module specifier '%s': not vendored and not shimmed (see runtime/spike/upstream/README.md)",
                name);
            return NULL;
        }
    }
    char *abs = dsh_join(s->base, rel);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    JSModuleDef *m = dsh_load_module(ctx, abs, name, rel);
    free(abs);
    return m;
}

/* Lexically resolve "." / ".." segments of `name` against importer directory
 * `dir` (both in SPECIFIER space, no trailing slash). Returns a js_strdup'ed
 * canonical specifier, or NULL when the path escapes the root. */
static char *dsh_resolve_relative(JSContext *ctx, const char *dir, const char *name) {
    const char *segs[64];
    size_t lens[64];
    size_t depth = 0;
    /* seed with the importer dir's segments (immutably measured) */
    const char *p = dir;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t len = slash ? (size_t)(slash - p) : strlen(p);
        if (depth >= 64) return NULL;
        segs[depth] = p; lens[depth] = len; depth++;
        if (!slash) break;
        p = slash + 1;
    }
    /* resolve the relative segments of `name` */
    char *tok = (char *)name;
    for (;;) {
        char *slash = strchr(tok, '/');
        size_t len = slash ? (size_t)(slash - tok) : strlen(tok);
        if (len == 1 && tok[0] == '.') {
            /* skip */
        } else if (len == 2 && tok[0] == '.' && tok[1] == '.') {
            if (depth == 0) return NULL;
            depth--;
        } else {
            if (depth >= 64) return NULL;
            segs[depth] = tok; lens[depth] = len; depth++;
        }
        if (!slash) break;
        tok = slash + 1;
    }
    size_t n = 1;
    for (size_t i = 0; i < depth; i++) n += lens[i] + 1;
    char *out = js_malloc(ctx, n);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < depth; i++) {
        if (o) out[o++] = '/';
        memcpy(out + o, segs[i], lens[i]); o += lens[i];
    }
    out[o] = 0;
    return out;
}

static char *dsh_normalize(JSContext *ctx, const char *base_name, const char *name,
                           void *opaque) {
    (void)opaque;
    /* Bare specifiers and bundle-absolute names pass through; relative names
     * resolve against the importer's directory IN SPECIFIER SPACE (the loader
     * maps canonical specifiers to vendored files, so "@deepseek-ai/dsh-x/"
     * relative imports re-enter the bare map instead of hitting the disk). */
    if (name[0] == '.' && base_name) {
        /* A base without '/' is either a bundle-root FILE (directory = the
         * bundle root, empty prefix) or a MAPPED BARE SPECIFIER (directory =
         * the specifier itself, so 'zod' + './v4/x.js' re-enters the bare
         * map as 'zod/v4/x.js'). */
        const char *dir_end = strrchr(base_name, '/');
        size_t dir_len;
        char dir[512];
        if (dir_end != NULL) {
            dir_len = (size_t)(dir_end - base_name);
        } else {
            char mapped[512];
            char maperr[256];
            int kind = dsh_map_bare(base_name, mapped, sizeof(mapped), maperr, sizeof(maperr));
            dir_len = kind == 1 ? strlen(base_name) : 0;
        }
        if (dir_len >= sizeof(dir)) return NULL;
        if (dir_len > 0) memcpy(dir, base_name, dir_len);
        dir[dir_len] = 0;
        char *resolved = dsh_resolve_relative(ctx, dir, name);
        if (resolved) return resolved;
        /* fall through: unresolvable names fail loudly in the loader */
        return js_strdup(ctx, name);
    }
    return js_strdup(ctx, name);
}

/* ---- lifecycle ---------------------------------------------------------- */

static void dsh_bind_globals(dsh_spike_t *s) {
    JSContext *ctx = s->ctx;
    JSValue global = JS_GetGlobalObject(ctx);
#ifdef DSH_RELEASE
    /* Release build: the platforms' Release configurations compile THIS host
     * with -DDSH_RELEASE, so the JS layer's release branch is live and
     * createLogger() drops debug/info at the source. The flag is INJECTED
     * here at context-bind time rather than baked into a staged bundle —
     * every embedded logger.js stays byte-identical to the canonical
     * checkout, and there is no second source to drift. Debug builds are
     * untouched (the global is simply absent, which is what the logger
     * already treats as "not release"). */
    JS_SetPropertyStr(ctx, global, "__DSH_RELEASE__", JS_TRUE);
#endif
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
    JS_SetPropertyStr(ctx, global, "__dshBundleRequire",
                      JS_NewCFunction(ctx, js_bundle_require, "__dshBundleRequire", 2));
    JS_SetPropertyStr(ctx, global, "__dshLaunchEnv",
                      JS_NewCFunction(ctx, js_launch_env, "__dshLaunchEnv", 0));
    JS_SetPropertyStr(ctx, global, "__dshModuleDefine",
                      JS_NewCFunction(ctx, js_module_define, "__dshModuleDefine", 2));
    JS_SetPropertyStr(ctx, global, "__dshComplete",
                      JS_NewCFunction(ctx, js_complete, "__dshComplete", 2));
    JSValue btoa_fn = JS_NewCFunction(ctx, js_btoa, "btoa", 1);
    JS_SetPropertyStr(ctx, global, "btoa", btoa_fn);
    JSValue atob_fn = JS_NewCFunction(ctx, js_atob, "atob", 1);
    JS_SetPropertyStr(ctx, global, "atob", atob_fn);
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
    /* Module evaluation returns the module's evaluation PROMISE: an exception
     * inside the module graph is captured as that promise's REJECTION, not as
     * a thrown exception. Swallowing it leaves the scenario body unevaluated
     * while eval reports success (rule 5: fail loud). Settle the synchronous
     * evaluation, then surface a rejection naming its reason. */
    int drained = dsh_drain_jobs(s);
    JSPromiseStateEnum state = JS_PromiseState(s->ctx, res);
    if (drained != 0 || state == JS_PROMISE_REJECTED) {
        if (state == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(s->ctx, res);
            JS_Throw(s->ctx, reason);
            dsh_record_exception(s);
        }
        JS_FreeValue(s->ctx, res);
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

void dsh_spike_set_launch_env(dsh_spike_t *s, const char *env_json) {
    if (!s) return;
    free(s->launch_env);
    s->launch_env = env_json ? strdup(env_json) : NULL;
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
    while (s->defined) {
        dsh_def_module *m = s->defined;
        s->defined = m->next;
        free(m->name);
        free(m->source);
        free(m);
    }
    free(s->pending);
    free(s->descriptor);
    free(s->launch_env);
    free(s);
}
