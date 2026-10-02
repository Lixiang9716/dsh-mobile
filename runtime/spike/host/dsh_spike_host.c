/*
 * dsh_spike_host.c — the M2 spike host shim, shared by every platform.
 *
 * Responsibilities (all in ONE thread, driven by the embedder):
 *   - unified-log sink: JS calls globalThis.__DSH_LOG_SINK__(jsonLine) and
 *     the host emits the canonical "dsh.spike.log: {...}" E2E line;
 *   - Web-API seams the vendored upstream package needs: crypto (getRandom-
 *     Values via the platform RNG) and btoa;
 *   - the zstd seam over the vendored C library (vendor/ensure-zstd.sh pin):
 *     __zstdCompressB64 / __zstdDecompressB64 carry the node:zlib shim's
 *     payload face (base64 in, base64 out, "zstd: " errors);
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
#include <unistd.h> /* access() — the vendored-package probe's existence check */

#include "dsh_socket.h" /* the loopback socket seam's pump table (v1.8.0) */

/* The forkpty seam (D-b, 2026-09-29; contract/proposals/2026-09-29-
 * forkpty-face.md): <util.h> is the Darwin/iOS spelling of forkpty(3),
 * <pty.h> the Linux/bionic/musl one — same face, same semantics. A host
 * toolchain that carries neither compiles the seam with
 * DSH_HAVE_FORKPTY undefined, and the spawn intrinsic answers the honest
 * runtime error instead (never a fake). */
#if defined(__APPLE__)
#include <util.h>
#include <termios.h>
#include <sys/ioctl.h>
#define DSH_HAVE_FORKPTY 1
#elif defined(__linux__) || defined(__ANDROID__) || defined(__OHOS__)
#include <pty.h>
#include <termios.h>
#include <sys/ioctl.h>
#define DSH_HAVE_FORKPTY 1
#endif

#include "quickjs.h"
/* Vendored zstd (single-threaded build: no ZSTD_MULTITHREAD — D2's one
 * serial runtime thread). The include paths (-I<zstd> -I<zstd>/common) are
 * part of THIS file's compile interface: every build system that compiles
 * dsh_spike_host.c must pass them (host/build.sh does; the platform builds
 * name the same vendor pin). */
#include "zstd.h"

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
        { "node:perf_hooks", "upstream/shims/node-perf-hooks.js" },
        /* node:zlib: the session-persistence spine's face over the compiled-in
         * zstd (host intrinsics __zstdCompressB64/__zstdDecompressB64). */
        { "node:zlib", "upstream/shims/node-zlib.js" },
        { "node:worker_threads", "upstream/shims/node-worker-threads.js" },
        { "node:stream", "upstream/shims/node-stream.js" },
        /* node:events: the EventEmitter face the ssh/subprocess/session/sdk
         * source families link against (upstream-suite growth round 2). */
        { "node:events", "upstream/shims/events.js" },
        /* node:sqlite: DatabaseSync over the ALREADY-LINKED sqlite3 (the iSH
         * userland depends on it) — session-search's SQLite index is a real
         * desktop capability the suite exercises on real files (W5-R). */
        { "node:sqlite", "upstream/shims/node-sqlite.js" },
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

/* ---- subprocess seam (W5-R, 2026-09-28) ---------------------------------- *
 * The desktop/Android parity leg of the upstream suite spawns REAL child
 * processes (lsp-stdio's fixture servers, bash executors, mkfifo probes):
 * the vendored `dsh-subprocess-local` normalize-spawn layer is node's own
 * `node:child_process` face. The JS runtime stays single-threaded (D2 is
 * untouched — children never execute JS here); the HOST owns the OS
 * processes and hands bytes to JS as base64 chunks the shim pumps over the
 * ordinary timer seam. Portable POSIX only (fork/execvp/poll/waitpid): it
 * compiles on the mobile hosts but only the spike JS ever calls it. */
#define DSH_PROC_MAX_SLOTS 64
/* Extra stdio fds (node's stdio array may run past fd 2 — the ptc control
 * channel rides fd 7; IPC-style protocols claim 3+). Each piped extra gets
 * a tracked parent read end. (W6-U, 2026-09-28) */
#define DSH_PROC_EXTRA 5
typedef struct dsh_proc {
    int used;
    int pid;
    int stdin_w;      /* parent's write end of the child's stdin; -1 closed */
    int stdout_r;     /* parent's read end; -1 once EOF-closed */
    int stderr_r;
    int extra_r[DSH_PROC_EXTRA];   /* parent read ends for fds 3..7; -1 closed */
    int extra_eof[DSH_PROC_EXTRA];
    unsigned char *xpending[DSH_PROC_EXTRA]; /* per-extra write backpressure */
    size_t xpending_n[DSH_PROC_EXTRA], xpending_cap[DSH_PROC_EXTRA];
    int out_eof, err_eof;
    int reaped;
    int exit_code;    /* valid when reaped (WEXITSTATUS form) */
    int exit_sig;     /* terminating signal number, 0 when exited normally */
    int detached;     /* setsid'd group leader — never SIGKILLed at teardown */
    unsigned char *pending;  /* stdin bytes accepted-but-unwritten (backpressure) */
    size_t pending_n, pending_cap;
    int flush_err;    /* EPIPE once the child died with pending stdin bytes */
} dsh_proc;

/* ---- forkpty seam (D-b, 2026-09-29) -------------------------------------- *
 * The terminal path of the vendored `dsh-subprocess-local` spawns REAL
 * children on REAL pseudo-terminals (the node-pty face): echo, job control,
 * a foreground process group, TERM, and a SIGWINCH-carrying window size are
 * semantics no pipe can carry, and the pipe-backbone shim was rejected by
 * the owner (decision matrix D-b) for fabricating exactly those facts. One
 * slot per live PTY; the master fd is host-owned and NON-BLOCKING; the
 * node-pty shim (upstream/shims/node-pty.js) drives spawn/poll/write/
 * resize/kill through the intrinsics below with the same 4ms pump the
 * child-process shim runs. No threads: every intrinsic runs on the
 * embedder's single runtime thread (D2), and the C seam never calls JS.
 * Data/exit surface through the JS pump as the pty.event sequence the
 * proposal freezes — events, never a poll-a-state API (D8). */
#define DSH_PTY_MAX_SLOTS 32
typedef struct dsh_pty {
    int used;
    int pid;
    int master;              /* parent's end of the pty; -1 once closed */
    int eof;                 /* master drained to EOF (EIO after slave close) */
    int reaped;
    int exit_code;           /* WEXITSTATUS form; exit_sig carries the signal */
    int exit_sig;            /* terminating signal number, 0 when exited normally */
    unsigned char *pending;  /* master-write backpressure (accepted-but-unwritten) */
    size_t pending_n, pending_cap;
    int flush_err;           /* nonzero errno once the master is gone with pending bytes */
} dsh_pty;

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
    dsh_proc procs[DSH_PROC_MAX_SLOTS];
    dsh_pty ptys[DSH_PTY_MAX_SLOTS];
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

/* js_perf_probe(mode) — the perf legs' measurement hook over the engine's
 * own accounting (JS_ComputeMemoryUsage; 'gc' runs JS_RunGC first, so a
 * scenario can assert a heap watermark falls back after collection).
 * TEST INFRASTRUCTURE ONLY — it never enters a gateway descriptor, the
 * contract/ freeze, or any capability table (the perf-baseline review's
 * explicit check): scenarios call it directly as a host global, exactly
 * like __dshComplete/__dshLaunchEnv. Unknown modes fail loud (rule 5). */
static JSValue js_perf_probe(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "__dshPerfProbe needs a mode ('heap' or 'gc')");
    const char *mode = JS_ToCString(ctx, argv[0]);
    if (!mode) return JS_EXCEPTION;
    int run_gc = strcmp(mode, "gc") == 0;
    if (!run_gc && strcmp(mode, "heap") != 0) {
        JS_FreeCString(ctx, mode);
        return JS_ThrowTypeError(ctx, "__dshPerfProbe: unknown mode (want 'heap' or 'gc')");
    }
    JS_FreeCString(ctx, mode);
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (run_gc) JS_RunGC(rt);
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(rt, &mu);
    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "mode", JS_NewString(ctx, run_gc ? "gc" : "heap"));
    JS_SetPropertyStr(ctx, info, "memoryUsedSize", JS_NewInt64(ctx, mu.memory_used_size));
    JS_SetPropertyStr(ctx, info, "mallocCount", JS_NewInt64(ctx, mu.malloc_count));
    JS_SetPropertyStr(ctx, info, "objCount", JS_NewInt64(ctx, mu.obj_count));
    JS_SetPropertyStr(ctx, info, "strCount", JS_NewInt64(ctx, mu.str_count));
    JS_SetPropertyStr(ctx, info, "shapeCount", JS_NewInt64(ctx, mu.shape_count));
    JS_SetPropertyStr(ctx, info, "jsFuncCount", JS_NewInt64(ctx, mu.js_func_count));
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
    dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
    int pass = JS_ToBool(ctx, argv[0]); /* -1 on exception; anything falsy = fail */
    s->completed = 1;
    s->passed = pass > 0;
    /* A failing scenario hands its reason (message + short stack) as the
     * second argument. Keep it in s->err so embedders reading
     * dsh_spike_error() at completion — the m4 status-2 branch, the harmony
     * napi !pass legs, the iOS drive's onComplete message — report WHY the
     * scenario failed instead of an empty string. */
    if (pass <= 0 && argc >= 2 && JS_IsString(argv[1])) {
        size_t len = 0;
        const char *reason = JS_ToCStringLen(ctx, &len, argv[1]);
        if (reason) {
            dsh_seterr(s, "%s", reason);
            JS_FreeCString(ctx, reason);
        }
    }
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
    /* atob's contract is a LATIN-1 string: charCodeAt(i) == decoded byte i.
     * JS_NewStringLen interprets its input as UTF-8, so feeding the raw
     * bytes mangled every byte >= 0x80 (measured 2026-09-23: the zlib
     * shim's b64ToBytes read a zstd frame's 0xB5 magic byte back as 0xFD —
     * ASCII-only callers could never see it). Re-encode the bytes as UTF-8
     * (each byte 0x80..0xFF becomes one 2-byte sequence) so the decoded JS
     * string carries the byte values as code points. */
    size_t utf8_cap = o * 2;
    char *utf8 = js_malloc(ctx, utf8_cap ? utf8_cap : 1);
    if (!utf8) {
        js_free(ctx, out);
        return JS_EXCEPTION;
    }
    size_t u = 0;
    for (size_t i = 0; i < o; i++) {
        unsigned char b = (unsigned char)out[i];
        if (b < 0x80) {
            utf8[u++] = (char)b;
        } else {
            utf8[u++] = (char)(0xC0 | (b >> 6));
            utf8[u++] = (char)(0x80 | (b & 0x3F));
        }
    }
    js_free(ctx, out);
    JSValue res = JS_NewStringLen(ctx, utf8, u);
    js_free(ctx, utf8);
    return res;
}

/* ---- zstd intrinsics (the node:zlib shim's engine) ---------------------- */

/* Raw-byte base64 codec for the zstd intrinsics. main_cli.c carries its own
 * static b64_encode/b64_decode twins, but they are file-local: platform
 * embedders compile dsh_spike_host.c WITHOUT main_cli.c, so these small
 * versions stay here (sharing B64_TABLE / dsh_b64_val with btoa/atob —
 * one alphabet, two entry styles: JS-string latin-1 vs raw bytes). */
static char *dsh_b64_encode_bytes(JSContext *ctx, const unsigned char *src, size_t n) {
    size_t out_len = ((n + 2) / 3) * 4;
    char *out = js_malloc(ctx, out_len + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned rem = (unsigned)(n - i);
        unsigned b0 = src[i];
        unsigned b1 = i + 1 < n ? src[i + 1] : 0;
        unsigned b2 = i + 2 < n ? src[i + 2] : 0;
        out[o++] = B64_TABLE[b0 >> 2];
        out[o++] = B64_TABLE[((b0 & 3) << 4) | (b1 >> 4)];
        out[o++] = rem > 1 ? B64_TABLE[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out[o++] = rem > 2 ? B64_TABLE[b2 & 63] : '=';
    }
    out[o] = 0;
    return out;
}

/* base64 → fresh byte buffer; NULL (nothing thrown) on malformed input. */
static unsigned char *dsh_b64_decode_bytes(JSContext *ctx, const char *src, size_t len,
                                           size_t *out_n) {
    unsigned char *out = js_malloc(ctx, len / 4 * 3 + 3);
    if (!out) return NULL;
    size_t o = 0;
    unsigned acc = 0;
    unsigned bits = 0;
    int pad = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '=') { pad++; continue; }
        int v = dsh_b64_val(c);
        if (v < 0 || pad > 0) { js_free(ctx, out); return NULL; }
        acc = (acc << 6) | (unsigned)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (unsigned char)((acc >> bits) & 0xFF);
        }
    }
    if (bits >= 6) { js_free(ctx, out); return NULL; } /* dangling bits */
    *out_n = o;
    return out;
}

/* The intrinsics' error convention: a JS Error whose message starts
 * "zstd: " + the zstd error name (Agent B's shim codes against the prefix). */
static JSValue dsh_zstd_error(JSContext *ctx, size_t code) {
    char msg[192];
    snprintf(msg, sizeof(msg), "zstd: %s", ZSTD_getErrorName(code));
    JSValue err = JS_NewError(ctx);
    if (JS_IsException(err)) return JS_EXCEPTION;
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, msg));
    return JS_Throw(ctx, err);
}

/* Shared prologue: argv[0] as base64 → fresh bytes, failing loud on bad
 * input. Returns NULL with the TypeError already thrown. */
static unsigned char *dsh_zstd_arg_bytes(JSContext *ctx, JSValueConst arg,
                                         const char *fn, size_t *out_n) {
    size_t len = 0;
    const char *in = JS_ToCStringLen(ctx, &len, arg);
    if (!in) return NULL;
    unsigned char *bytes = dsh_b64_decode_bytes(ctx, in, len, out_n);
    JS_FreeCString(ctx, in);
    if (!bytes) (void)JS_ThrowTypeError(ctx, "%s input is not valid base64", fn);
    return bytes;
}

/* __zstdCompressB64(b64String, level?) -> b64String. level defaults to 3
 * (the `level || 3` of the intrinsic contract; 0/absent → 3). */
static JSValue js_zstd_compress_b64(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "__zstdCompressB64 needs a base64 string");
    size_t src_len = 0;
    unsigned char *src = dsh_zstd_arg_bytes(ctx, argv[0], "__zstdCompressB64", &src_len);
    if (!src) return JS_EXCEPTION;
    int level = 3;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        int32_t lv = 0;
        if (JS_ToInt32(ctx, &lv, argv[1]) < 0) { js_free(ctx, src); return JS_EXCEPTION; }
        if (lv != 0) level = lv; /* 0 → keep the default 3 */
    }
    size_t bound = ZSTD_compressBound(src_len);
    unsigned char *dst = js_malloc(ctx, bound ? bound : 1);
    if (!dst) { js_free(ctx, src); return JS_EXCEPTION; }
    size_t r = ZSTD_compress(dst, bound, src, src_len, level);
    js_free(ctx, src);
    if (ZSTD_isError(r)) { js_free(ctx, dst); return dsh_zstd_error(ctx, r); }
    char *b64 = dsh_b64_encode_bytes(ctx, dst, r);
    js_free(ctx, dst);
    if (!b64) return JS_EXCEPTION;
    JSValue res = JS_NewString(ctx, b64);
    js_free(ctx, b64);
    return res;
}

/* Grow-loop limits for __zstdDecompressB64's unknown/exceeded-size path:
 * start at 256 KB, double, never exceed 256 MB. */
#define DSH_ZSTD_DST_START 262144
#define DSH_ZSTD_DST_MAX 268435456

/* __zstdDecompressB64(b64String, maxOutputBytes?) -> b64String. Frame
 * content size known AND within maxOutputBytes (0/omitted = unlimited) →
 * exact allocation; everything else (unknown size — streaming frames — or
 * a hint above the caller's cap) → the grow loop above. */
static JSValue js_zstd_decompress_b64(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "__zstdDecompressB64 needs a base64 string");
    size_t src_len = 0;
    unsigned char *src = dsh_zstd_arg_bytes(ctx, argv[0], "__zstdDecompressB64", &src_len);
    if (!src) return JS_EXCEPTION;
    int64_t max_out = 0;
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        if (JS_ToInt64(ctx, &max_out, argv[1]) < 0) { js_free(ctx, src); return JS_EXCEPTION; }
        if (max_out < 0) max_out = 0;
    }
    unsigned long long hint = ZSTD_getFrameContentSize(src, src_len);
    int exact = hint != ZSTD_CONTENTSIZE_UNKNOWN && hint != ZSTD_CONTENTSIZE_ERROR &&
                (max_out == 0 || (unsigned long long)max_out >= hint);
    size_t cap = exact ? (size_t)(hint ? hint : 1) : DSH_ZSTD_DST_START;
    for (;;) {
        unsigned char *dst = js_malloc(ctx, cap);
        if (!dst) { js_free(ctx, src); return JS_EXCEPTION; }
        size_t r = ZSTD_decompress(dst, cap, src, src_len);
        if (!ZSTD_isError(r)) {
            js_free(ctx, src);
            char *b64 = dsh_b64_encode_bytes(ctx, dst, r);
            js_free(ctx, dst);
            if (!b64) return JS_EXCEPTION;
            JSValue res = JS_NewString(ctx, b64);
            js_free(ctx, b64);
            return res;
        }
        js_free(ctx, dst);
        /* dstSizeTooSmall: only exact-hint misses and unknown-size frames
         * land here — double (capped) and retry; anything else is final. */
        if (ZSTD_getErrorCode(r) == ZSTD_error_dstSize_tooSmall && cap < DSH_ZSTD_DST_MAX) {
            size_t next = cap * 2;
            if (next > DSH_ZSTD_DST_MAX) next = DSH_ZSTD_DST_MAX;
            cap = next;
            continue;
        }
        js_free(ctx, src);
        return dsh_zstd_error(ctx, r);
    }
}

/* ---- node:module require seam ------------------------------------------- */

/* ESM-loader helpers live below; forward-declared here. */
static char *dsh_join(const char *a, const char *b);
static char *dsh_read_file(const char *path, size_t *out_len);
static int dsh_map_bare(const char *name, char *out, size_t out_len, char *err, size_t err_len);
/* dsh_map_bare's vendored-dsh marker kind (the probe below owns resolution). */
#define DSH_MAP_VENDORED_PROBE 2
static const char *dsh_vendored_rel(dsh_spike_t *s, const char *pkg, const char *sub,
                                    char *out, size_t out_len);
static char *dsh_resolve_relative(JSContext *ctx, const char *dir, const char *name);
static JSValue js_import_meta_resolve(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv, int magic,
                                      JSValueConst *func_data);

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

/* Shim-exposure manifest (DIAGNOSTIC, default OFF): when the process env
 * names DSH_MODULE_MANIFEST, every resolved load under upstream/shims/
 * appends one path line to that file — the raw evidence the shim exposure
 * survey aggregates (tools/shim-exposure.mjs). Called from BOTH load
 * channels the shims ride: the ESM loader (dsh_module_loader, the 86
 * top-level shim modules) and the CJS bundle-read seam (js_bundle_require,
 * the shims/sharp package internals the userland CJS loader evaluates).
 * Append failures are swallowed on purpose: a diagnostic must never fail a
 * load, and an unset or empty DSH_MODULE_MANIFEST costs one getenv. */
static void dsh_manifest_shim(const char *rel) {
    if (strncmp(rel, "upstream/shims/", 15) != 0) return;
    const char *path = getenv("DSH_MODULE_MANIFEST");
    if (!path || *path == 0) return;
    FILE *f = fopen(path, "a");
    if (!f) return;
    fprintf(f, "%s\n", rel);
    fclose(f);
}

/* JS global __dshBundleRequire(base, request): the node:module seam's file
 * read. `base` is the importing module's name (a bare specifier — resolved
 * through the same bare map the loader owns, so the specifier→vendor mapping
 * lives in exactly one place — or a bundle-root-relative path); `request` a
 * relative path from its directory. ONLY package-style reads are served:
 * .json (attribution headers) and .js/.cjs/.mjs TEXT (the shim layer's
 * userland CJS loader evaluates CJS packages staged under vendor/ — the host
 * returns raw bytes and owns no module semantics); everything else fails
 * loud. Returns the raw file text. */
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
    if (kind == DSH_MAP_VENDORED_PROBE) {
        /* "pkg|sub" marker — resolve through the same vendored probe the
         * loader owns (one resolution site, no second map to drift). */
        char pkg[256];
        snprintf(pkg, sizeof(pkg), "%s", rel);
        char *bar = strchr(pkg, '|');
        if (bar == NULL) {
            JS_ThrowReferenceError(ctx, "loader bug: vendored marker '%s' lacks '|'", rel);
            goto fail;
        }
        *bar = 0;
        if (dsh_vendored_rel(s, pkg, bar + 1, rel, sizeof(rel)) == NULL) {
            JS_ThrowReferenceError(ctx,
                "cannot load module '%s' (no vendored dsh package serves it)", base);
            goto fail;
        }
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
    int is_json = rlen >= 6 && strcmp(resolved + rlen - 5, ".json") == 0;
    int is_js = rlen >= 4 && (strcmp(resolved + rlen - 3, ".js") == 0
                              || strcmp(resolved + rlen - 4, ".mjs") == 0
                              || strcmp(resolved + rlen - 4, ".cjs") == 0);
    if (!is_json && !is_js) {
        JS_ThrowTypeError(ctx, "require('%s'): only .json/.js/.cjs/.mjs reads are served by the spike host", request);
        goto fail;
    }
    char *abs = dsh_join(s->base, resolved);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        goto fail;
    }
    dsh_manifest_shim(resolved);
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
 * path URLs and the bundle-require seam both speak bundle-relative paths).
 *
 * import.meta.dirname rides the same specifier space: the url up to its last
 * '/' (empty for a slash-less module name — dirname of a bundle-root file IS
 * the root). import.meta.resolve resolves a request the way the LOADER would
 * from this module (relative requests lexically in specifier space; bare
 * requests through the same bare map / vendored probe), so its answer
 * re-imports — the upstream suite's loader/launch faces call it at runtime
 * and need the real resolution, not a stub. */
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
        const char *slash = strrchr(url, '/');
        size_t dir_len = slash ? (size_t)(slash - url) : 0;
        JS_SetPropertyStr(ctx, meta, "dirname", JS_NewStringLen(ctx, url, dir_len));
        /* The resolve closure carries the module's directory as its data
         * value (JS_NewCFunctionData dup's it); one C function serves every
         * module — no per-module state beyond that string. */
        JSValue data[1] = { JS_NewStringLen(ctx, url, dir_len) };
        JSValue resolve_fn = JS_NewCFunctionData(ctx, js_import_meta_resolve, 1, 0, 1, data);
        JS_FreeValue(ctx, data[0]);
        JS_SetPropertyStr(ctx, meta, "resolve", resolve_fn);
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

/* Two vendored-directory families share vendor/dsh/: the spine closure
 * stages packages under STRIPPED names (the @deepseek-ai/dsh-session
 * tarball lands as session@<ver>/), while the test closure's npm tarballs
 * keep their literal names (@deepseek-ai/dsh-ptc-runtime lands as
 * dsh-ptc-runtime@<ver>/). Neither is derivable from the specifier alone —
 * the loader PROBES both families and every exports-map file shape the
 * dsh packages use (lib/<sub>.js, lib/types/<sub>.js), failing loud naming
 * the specifier when nothing opens (rule 5). Returns the first existing
 * bundle-relative path, or NULL when no candidate opens. */
static const char *dsh_vendored_rel(dsh_spike_t *s, const char *pkg, const char *sub,
                                    char *out, size_t out_len) {
    static const char *FAMILIES[] = { "", "dsh-" };
    /* Some imports carry their own .js suffix ('…/types.js'); the exports
     * maps they mirror key the STEM ('…/types' → lib/types/types.js), so a
     * trailing .js is stripped for the suffixed-shape probes. */
    char stem[256];
    size_t sub_len = strlen(sub);
    int had_js = sub_len > 3 && strcmp(sub + sub_len - 3, ".js") == 0;
    snprintf(stem, sizeof(stem), "%.*s", had_js ? (int)(sub_len - 3) : (int)sub_len, sub);
    for (size_t f = 0; f < sizeof(FAMILIES) / sizeof(FAMILIES[0]); f++) {
        char probe[512];
        if (sub[0] == 0) {
            /* Bare package specifier: the entry point. Second base: the
             * npm-published test/support packages the suite vendored under
             * vendor/npm/@deepseek-ai/ (agent-loop-testkit and kin). */
            snprintf(probe, sizeof(probe), "vendor/dsh/%s%s@%s/lib/index.js",
                     FAMILIES[f], pkg, DSH_UPSTREAM_VERSION);
            char *abs = dsh_join(s->base, probe);
            if (!abs) return NULL;
            int hit = access(abs, R_OK) == 0;
            free(abs);
            if (!hit) {
                snprintf(probe, sizeof(probe),
                         "vendor/npm/@deepseek-ai/dsh-%s@%s/lib/index.js",
                         pkg, DSH_UPSTREAM_VERSION);
                abs = dsh_join(s->base, probe);
                if (!abs) return NULL;
                hit = access(abs, R_OK) == 0;
                free(abs);
            }
            if (hit) {
                snprintf(out, out_len, "%s", probe);
                return out;
            }
            continue;
        }
        static const char *SHAPES[] = { "lib/%s", "lib/%s.js", "lib/types/%s.js" };
        char rel_file[384];
        for (size_t sh = 0; sh < sizeof(SHAPES) / sizeof(SHAPES[0]); sh++) {
            for (int pass = 0; pass < 2; pass++) {
                const char *name = pass == 0 ? sub : stem;
                if (pass == 1 && (!had_js || strcmp(name, sub) == 0)) continue;
                snprintf(rel_file, sizeof(rel_file), SHAPES[sh], name);
                char probe[512];
                snprintf(probe, sizeof(probe), "vendor/dsh/%s%s@%s/%s",
                         FAMILIES[f], pkg, DSH_UPSTREAM_VERSION, rel_file);
                char *abs = dsh_join(s->base, probe);
                if (!abs) return NULL;
                int hit = access(abs, R_OK) == 0;
                free(abs);
                if (!hit) {
                    snprintf(probe, sizeof(probe),
                             "vendor/npm/@deepseek-ai/dsh-%s@%s/%s",
                             pkg, DSH_UPSTREAM_VERSION, rel_file);
                    abs = dsh_join(s->base, probe);
                    if (!abs) return NULL;
                    hit = access(abs, R_OK) == 0;
                    free(abs);
                }
                if (hit) {
                    snprintf(out, out_len, "%s", probe);
                    return out;
                }
            }
        }
    }
    return NULL;
}

/* Load a vendored dsh package module (the loader half of the probe above:
 * compile the first existing candidate under the ORIGINAL specifier name). */
static JSModuleDef *dsh_load_vendored_dsh(JSContext *ctx, dsh_spike_t *s,
                                          const char *name,
                                          const char *pkg, const char *sub) {
    char rel[512];
    if (dsh_vendored_rel(s, pkg, sub, rel, sizeof(rel)) == NULL) {
        JS_ThrowReferenceError(ctx,
            "cannot load module '%s' (no vendored dsh package serves it)", name);
        return NULL;
    }
    char *abs = dsh_join(s->base, rel);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    size_t len = 0;
    char *buf = dsh_read_file(abs, &len);
    free(abs);
    if (!buf) {
        JS_ThrowReferenceError(ctx, "cannot load module '%s'", name);
        return NULL;
    }
    JSModuleDef *m = dsh_compile_module_url(ctx, name, rel, buf, len);
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
 * Returns 0 when the specifier is not bare (caller falls back to path
 * resolution), 1 when mapped (out holds the bundle-relative path),
 * DSH_MAP_VENDORED_PROBE (2) when the specifier names a vendored dsh
 * package (out holds the "pkg|sub" marker — the loader probes the two
 * staging families, see dsh_load_vendored_dsh), and fills `err` with -1
 * when it is bare but unmapped (fail loud).
 *
 * Layers, in the system's dependency direction (D6/D9: upstream packages run
 * verbatim; platform differences live in the shim layer, never in vendored
 * copies):
 *   - "@deepseek-ai/dsh-llm[/sub]" — the VENDORED dsh-llm package (the W-LLM
 *     leg): subpath aliases the exports map spells specially resolve here;
 *     everything else falls through to the vendored-package probe.
 *   - "@deepseek-ai/dsh-session-persistence" — errors-only shim (agent-loop
 *     imports SessionPersistenceNotFoundError at module load).
 *   - node:<builtin> — the node shims (table above).
 *   - "@deepseek-ai/dsh-<pkg>[/sub]" — vendored upstream runtime packages
 *     (VERBATIM tarballs; the probe serves both staging families and the
 *     exports-map subpath shapes, failing loud naming the specifier).
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
    if (strncmp(name, "@noble/hashes/", 14) == 0) {
        /* STATIC bare map, not the npm-bridges registry: shims/crypto.js
         * imports these names, and crypto.js itself loads through the
         * node:crypto row during the STATIC LINK phase — before any module
         * body has run to register the runtime bridge table, so a registry
         * row can never serve this import (the parity port leg's "cannot
         * load module '@noble/hashes/sha2.js'"). Link-time rows read the
         * pinned vendor tree straight off disk; a subpath outside the pin
         * fails loud at read. */
        snprintf(out, out_len, "vendor/npm/@noble/hashes@2.3.0/%s", name + 14);
        return 1;
    }
    if (strncmp(name, "@deepseek-ai/dsh-llm/", 21) == 0) {
        /* The vendored package's runtime exports map (package.json "exports"):
         * subpath → path under lib/. The /types subpath is a RUNTIME module
         * here (unlike the other dsh-* packages where it is type-only).
         * Subpaths the map spells specially (typert → typert.host.js) stay
         * literal; every other subpath falls through to the generic vendored
         * probe (it serves the lib/ and lib/types/ shapes). */
        static const struct { const char *sub; const char *lib; } LLM_SUBS[] = {
            { "invariant", "invariant.js" },
            { "message", "types/message.js" },
            { "assistant-stream", "types/assistant-stream.js" },
            { "brand", "types/brand.js" },
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
        /* Unlisted dsh-llm subpath: fall through to the generic vendored
         * probe (the llm tarball lives in the stripped family; the probe's
         * lib/ + lib/types/ shapes cover the exports map's remaining rows). */
    }
    /* dsh-session-persistence: served by the vendored-package probe — the
     * submodule-built real package is staged (koffi-free) since the
     * 2026-09-23 closure harvest; the old errors-only shim would shadow it
     * and starve the persistence family of its error classes. */
    if (strcmp(name, "@deepseek-ai/node-addon-system/flock") == 0) {
        snprintf(out, out_len, "upstream/shims/node-addon-system-flock.js");
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
    if (strncmp(name, "@deepseek-ai/dsh-", 17) == 0) {
        /* VENDORED dsh package (both staging families + the exports-map
         * subpath shapes) — decompose to "pkg|sub" and let the loader probe
         * (dsh_load_vendored_dsh above owns why). */
        const char *rest = name + 17;
        const char *slash = strchr(rest, '/');
        size_t pkg_len = slash ? (size_t)(slash - rest) : strlen(rest);
        snprintf(out, out_len, "%.*s|%s", (int)pkg_len, rest,
                 slash ? slash + 1 : "");
        return DSH_MAP_VENDORED_PROBE;
    }
    /* The agent-presets closure (the Agent 预设 panel's data source) — same
     * rule as dsh-client-modules: npm-published packages outside the
     * dsh-desktop runtime version stream, mapped to their vendor/npm trees.
     * atomic-write and home-paths are dsh-* packages on the shared
     * 0.1.6-alpha.2 stream since the 2026-09-22 re-pin (upstream promoted
     * them out of their 0.0.1-rc stream), so the generic dsh- rule maps
     * them. */
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
    if (strcmp(name, "fast-check") == 0) {
        /* The property-testing lib the upstream suite's *__properties specs
         * import — the monorepo's own lockfile pin (4.8.0), pre-bundled
         * (fast-check + pure-rand in one self-contained ESM file: quickjs
         * resolves the chunk's package-name import, esbuild's nodePaths
         * fed it pure-rand). */
        snprintf(out, out_len, "vendor/npm/fast-check@4.8.0/lib/fast-check.bundle.mjs");
        return 1;
    }
    if (strncmp(name, "fast-check/", 12) == 0) {
        snprintf(out, out_len, "vendor/npm/fast-check@4.8.0/lib/%s", name + 12);
        return 1;
    }
    if (strncmp(name, "pure-rand/", 10) == 0) {
        /* fast-check's rng — same lockfile pin (8.4.0), CJS-free ESM face. */
        snprintf(out, out_len, "vendor/npm/pure-rand@8.4.0/lib/%s.js", name + 10);
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
    /* A trailing '?query' is a cache-buster (node ESM semantics: each
     * distinct specifier string is its own module instance). The defined
     * table keys modules by the QUERY-LESS name (fs shims register written
     * / seeded sources there), so the lookup compares the query-stripped
     * prefix — but the module still COMPILES under the full query-bearing
     * name, so every distinct query re-evaluates the current source exactly
     * like node re-reading the file (the typert generator's loadSchema
     * writes a fresh schema.mjs per call and busts with '?test=<ts>-<n>';
     * an exact-name match would serve the first source forever). */
    const char *query = strchr(name, '?');
    size_t base_len = query ? (size_t)(query - name) : strlen(name);
    for (dsh_def_module *m = s->defined; m; m = m->next) {
        if (query != NULL) {
            if (strlen(m->name) == base_len && strncmp(m->name, name, base_len) == 0) {
                return dsh_compile_module_url(ctx, name, name, m->source, m->source_len);
            }
        } else if (strcmp(m->name, name) == 0) {
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
        if (kind == DSH_MAP_VENDORED_PROBE) {
            /* "pkg|sub" marker: the two-family probe owns resolution (and
             * fails loud itself when nothing serves the specifier). */
            char pkg[256];
            snprintf(pkg, sizeof(pkg), "%s", mapped);
            char *bar = strchr(pkg, '|');
            if (bar == NULL) {
                JS_ThrowReferenceError(ctx, "loader bug: vendored marker '%s' lacks '|'", mapped);
                return NULL;
            }
            *bar = 0;
            return dsh_load_vendored_dsh(ctx, s, name, pkg, bar + 1);
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
    /* Disk fallback: the query is not part of any file name — strip it so
     * 'file://…/schema.mjs?test=1' opens '…/schema.mjs' (a cache-buster
     * against a path outside the defined table still reads the real file). */
    char stripped[1024];
    if (query != NULL && rel != NULL) {
        size_t rel_prefix = strcspn(rel, "?");
        if (rel_prefix < sizeof(stripped)) {
            memcpy(stripped, rel, rel_prefix);
            stripped[rel_prefix] = 0;
            rel = stripped;
        }
    }
    char *abs = dsh_join(s->base, rel);
    if (!abs) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    dsh_manifest_shim(rel);
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

/* import.meta.resolve(specifier) — the same resolution the module loader
 * would perform for an import issued FROM this module (its directory rides
 * in func_data[0], set at compile time). Relative requests resolve lexically
 * in specifier space (dsh_resolve_relative); bundle-absolute names pass
 * through; bare names go through dsh_map_bare / the vendored probe, so the
 * returned bundle-relative path RE-IMPORTS to the same module the loader
 * would serve. Unresolvable names fail loud naming the specifier (rule 5). */
static JSValue js_import_meta_resolve(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv, int magic,
                                      JSValueConst *func_data) {
    (void)this_val; (void)magic;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "import.meta.resolve needs a specifier");
    }
    const char *spec = JS_ToCString(ctx, argv[0]);
    if (!spec) return JS_EXCEPTION;
    JSValue ret = JS_UNDEFINED;
    if (spec[0] == '.') {
        const char *dir = JS_ToCString(ctx, func_data[0]);
        if (!dir) { JS_FreeCString(ctx, spec); return JS_EXCEPTION; }
        char *resolved = dsh_resolve_relative(ctx, dir, spec);
        JS_FreeCString(ctx, dir);
        if (!resolved) {
            JS_ThrowReferenceError(ctx, "relative import '%s' escaped its module root", spec);
            JS_FreeCString(ctx, spec);
            return JS_EXCEPTION;
        }
        ret = JS_NewString(ctx, resolved);
        js_free(ctx, resolved);
    } else if (spec[0] == '/') {
        /* bundle-absolute name: the loader serves it from the bundle root */
        ret = JS_NewString(ctx, spec);
    } else {
        dsh_spike_t *s = (dsh_spike_t *)JS_GetContextOpaque(ctx);
        char mapped[512];
        char maperr[256];
        int kind = dsh_map_bare(spec, mapped, sizeof(mapped), maperr, sizeof(maperr));
        if (kind < 0) {
            JS_ThrowReferenceError(ctx, "%s", maperr);
            JS_FreeCString(ctx, spec);
            return JS_EXCEPTION;
        }
        if (kind == DSH_MAP_VENDORED_PROBE) {
            char pkg[256];
            snprintf(pkg, sizeof(pkg), "%s", mapped);
            char *bar = strchr(pkg, '|');
            if (bar == NULL) {
                JS_ThrowReferenceError(ctx, "loader bug: vendored marker '%s' lacks '|'", mapped);
                JS_FreeCString(ctx, spec);
                return JS_EXCEPTION;
            }
            *bar = 0;
            char rel[512];
            if (dsh_vendored_rel(s, pkg, bar + 1, rel, sizeof(rel)) == NULL) {
                JS_ThrowReferenceError(ctx,
                    "cannot resolve '%s' (no vendored dsh package serves it)", spec);
                JS_FreeCString(ctx, spec);
                return JS_EXCEPTION;
            }
            ret = JS_NewString(ctx, rel);
        } else if (kind == 1) {
            ret = JS_NewString(ctx, mapped);
        } else if (strchr(spec, '.') != NULL || strchr(spec, '/') != NULL) {
            /* legacy bundle-root-relative module path */
            ret = JS_NewString(ctx, spec);
        } else {
            JS_ThrowReferenceError(ctx,
                "unmapped module specifier '%s': not vendored and not shimmed (see runtime/spike/upstream/README.md)",
                spec);
            JS_FreeCString(ctx, spec);
            return JS_EXCEPTION;
        }
    }
    JS_FreeCString(ctx, spec);
    return ret;
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
            dir_len = kind >= 1 ? strlen(base_name) : 0;
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

/* ---- subprocess seam implementation -------------------------------------- */

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <poll.h>
#include <dirent.h> /* the __dshProcRmReal mirror's directory walk */
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/socket.h> /* socketpair — the duplex extra-stdio channels */
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

/* node's errno→code spelling for the faces the specs probe (spawn failures
 * surface as {code:"ENOENT"}-shaped errors; anything unmapped rides the
 * errno number). */
static const char *dsh_errno_name(int e) {
    switch (e) {
    case ENOENT: return "ENOENT";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOEXEC: return "ENOEXEC";
    case ENOMEM: return "ENOMEM";
    case ENOTDIR: return "ENOTDIR";
    case ENXIO: return "ENXIO";
    case ETXTBSY: return "ETXTBSY";
    case EPIPE: return "EPIPE";
    case ESRCH: return "ESRCH";
    case ECHILD: return "ECHILD";
    case EINVAL: return "EINVAL";
    case EBADF: return "EBADF";
    default: return NULL;
    }
}

static const struct { const char *name; int num; } DSH_SIGNALS[] = {
    { "SIGHUP", 1 }, { "SIGINT", 2 }, { "SIGQUIT", 3 }, { "SIGABRT", 6 },
    { "SIGKILL", 9 }, { "SIGUSR1", 10 }, { "SIGUSR2", 12 }, { "SIGPIPE", 13 },
    { "SIGTERM", 15 }, { "SIGALRM", 14 }, { "SIGCHLD", 17 }, { "SIGCONT", 18 },
    { "SIGSTOP", 19 }, { "SIGTSTP", 20 }, { "SIGTTIN", 21 }, { "SIGTTOU", 22 },
};
/* "SIGTERM"/number → signal number; -1 unknown. Signal 0 (existence probe)
 * is spelled by the caller directly. */
static int dsh_signal_num(JSContext *ctx, JSValueConst v) {
    int32_t n = 0;
    if (JS_IsString(v)) {
        const char *name = JS_ToCString(ctx, v);
        if (!name) return -1;
        for (size_t i = 0; i < sizeof(DSH_SIGNALS) / sizeof(DSH_SIGNALS[0]); i++) {
            if (strcmp(DSH_SIGNALS[i].name, name) == 0) { JS_FreeCString(ctx, name); return DSH_SIGNALS[i].num; }
            if (name[0] != 'S' && strtol(name, NULL, 10) == DSH_SIGNALS[i].num) { JS_FreeCString(ctx, name); return DSH_SIGNALS[i].num; }
        }
        JS_FreeCString(ctx, name);
        return -1;
    }
    if (JS_ToInt32(ctx, &n, v) < 0) return -1;
    return (int)n;
}
static const char *dsh_signal_name(int num) {
    for (size_t i = 0; i < sizeof(DSH_SIGNALS) / sizeof(DSH_SIGNALS[0]); i++) {
        if (DSH_SIGNALS[i].num == num) return DSH_SIGNALS[i].name;
    }
    return NULL;
}

static dsh_proc *dsh_proc_slot(dsh_spike_t *s, int pid) {
    for (int i = 0; i < DSH_PROC_MAX_SLOTS; i++) {
        if (s->procs[i].used && s->procs[i].pid == pid) return &s->procs[i];
    }
    return NULL;
}

/* Public keep-alive probe (main_cli.c): a run must not go quiescent while a
 * spawned child is still awaited. Any used slot counts — reaped-but-open
 * pipes still carry data the JS pump drains. */
int dsh_spike_procs_alive(dsh_spike_t *s) {
    if (!s) return 0;
    int n = 0;
    for (int i = 0; i < DSH_PROC_MAX_SLOTS; i++) n += s->procs[i].used ? 1 : 0;
    return n;
}

/* exec with a caller-built environment on every POSIX this host compiles for
 * (execvpe is glibc-only): "/"-bearing files exec directly, bare names walk
 * the CHILD-PROCESS PATH (the envp the caller passes, node's contract — not
 * the parent's environ). */
static int dsh_execvpe(const char *file, char *const argv[], char *const envp[]) {
    if (strchr(file, '/')) return execve(file, argv, envp);
    const char *path = NULL;
    for (int i = 0; envp && envp[i]; i++) {
        if (strncmp(envp[i], "PATH=", 5) == 0) { path = envp[i] + 5; break; }
    }
    if (!path) path = getenv("PATH");
    if (!path) path = "/usr/bin:/bin";
    char cand[4096];
    const char *at = path;
    while (1) {
        const char *colon = strchr(at, ':');
        size_t dlen = colon ? (size_t)(colon - at) : strlen(at);
        if (dlen == 0) { dlen = 1; at = "."; colon = NULL; } /* empty PATH entry = cwd */
        if (dlen + strlen(file) + 2 < sizeof(cand)) {
            snprintf(cand, sizeof(cand), "%.*s/%s", (int)dlen, at, file);
            execve(cand, argv, envp);
            if (errno != ENOENT && errno != ENOTDIR) return -1;
        }
        if (!colon) break;
        at = colon + 1;
    }
    errno = ENOENT;
    return -1;
}

/* argv/envp builder over a JS array/object of strings. Pre-fork (the child
 * only execs — no allocator calls between fork and exec). Returns a NULL-
 * terminated char*[] owned by *out (js_malloc'd segment + strings). */
static int dsh_build_str_array(JSContext *ctx, JSValueConst arr, const char *first,
                               char ***out, char **err) {
    char **vec = NULL;
    uint32_t n = 0, extra = first ? 2 : 1;
    if (!JS_IsUndefined(arr) && !JS_IsNull(arr)) {
        JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
        uint32_t len = 0;
        int ok = !JS_IsException(lenv) && JS_ToUint32(ctx, &len, lenv) >= 0;
        JS_FreeValue(ctx, lenv);
        if (!ok) { *err = "args is not an array"; return 0; }
        n = len;
    }
    vec = js_malloc(ctx, (n + extra) * sizeof(char *));
    if (!vec) { *err = "oom"; return 0; }
    uint32_t at = 0;
    if (first) vec[at++] = js_strdup(ctx, first);
    for (uint32_t i = 0; i < n; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, arr, i);
        const char *sv = JS_ToCString(ctx, v);
        JS_FreeValue(ctx, v);
        if (!sv) { *err = "args entry is not a string"; vec[at] = NULL; *out = vec; return 0; }
        vec[at++] = js_strdup(ctx, sv);
        JS_FreeCString(ctx, sv);
    }
    vec[at] = NULL;
    *out = vec;
    return 1;
}

/* JS env OBJECT → NULL-terminated "K=V" envp. */
static int dsh_build_envp(JSContext *ctx, JSValueConst envobj, char ***out, char **err) {
    char **vec = js_malloc(ctx, 256 * sizeof(char *));
    if (!vec) { *err = "oom"; return 0; }
    uint32_t n = 0, cap = 255;
    if (!JS_IsUndefined(envobj) && !JS_IsNull(envobj)) {
        JSPropertyEnum *tab = NULL;
        uint32_t len = 0;
        if (JS_GetOwnPropertyNames(ctx, &tab, &len, envobj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
            js_free(ctx, vec); *err = "env is not an object"; return 0;
        }
        for (uint32_t i = 0; i < len; i++) {
            if (n + 2 >= cap) break; /* 255 entries cap: the suite's env maps are tiny */
            const char *k = JS_AtomToCString(ctx, tab[i].atom);
            JSValue v = JS_GetProperty(ctx, envobj, tab[i].atom);
            const char *sv = JS_IsUndefined(v) ? NULL : JS_ToCString(ctx, v);
            JS_FreeValue(ctx, v);
            if (k && sv) {
                size_t kl = strlen(k), vl = strlen(sv);
                char *entry = js_malloc(ctx, kl + vl + 2);
                if (entry) {
                    memcpy(entry, k, kl); entry[kl] = '=';
                    memcpy(entry + kl + 1, sv, vl + 1);
                    vec[n++] = entry;
                }
            }
            if (k) JS_FreeCString(ctx, k);
            if (sv) JS_FreeCString(ctx, sv);
            JS_FreeAtom(ctx, tab[i].atom);
        }
        js_free(ctx, tab);
    }
    vec[n] = NULL;
    *out = vec;
    return 1;
}

static void dsh_free_vec(JSContext *ctx, char **vec) {
    if (!vec) return;
    for (int i = 0; vec[i]; i++) js_free(ctx, vec[i]);
    js_free(ctx, vec);
}

/* stdio disposition per fd: 0 = pipe, 1 = /dev/null, 2 = inherit (pass the
 * spike's own std fd through). */
static int dsh_stdio_mode(const char *s) {
    if (!s) return 0;
    if (strcmp(s, "ignore") == 0) return 1;
    if (strcmp(s, "inherit") == 0) return 2;
    return 0; /* "pipe" and "overlapped" (a Windows-only spelling we pipe) */
}

static void dsh_close_all(int fds[], int n) {
    for (int i = 0; i < n; i++) if (fds[i] >= 0) close(fds[i]);
}

/* The bundle root as a REAL absolute path (realpath of the CLI's base —
 * "." on the desktop drive). The loader's import.meta.url face is
 * BUNDLE-RELATIVE ("file:///upstream-tests/x.spec.mjs"), so spec-computed
 * child argv (fileURLToPath joins) arrive as rootless absolute paths that
 * exist only under the bundle root. Cached once. */
static const char *dsh_bundle_root_real(dsh_spike_t *s) {
    static char real_root[4096];
    if (real_root[0] == 0) {
        if (realpath(s->base && s->base[0] ? s->base : ".", real_root) == NULL) {
            real_root[0] = 0;
        }
    }
    return real_root;
}

/* Remap child argv entries (never argv[0], the program): an absolute path
 * that does not exist AS SPELLED but does exist under the real bundle root
 * is re-rooted there — node-faithful argv for a runtime whose URL face is
 * bundle-relative (W5-R, 2026-09-28). Relative args and existing absolutes
 * pass through untouched. */
static void dsh_proc_remap_argv(dsh_spike_t *s, JSRuntime *rt, char **argv) {
    const char *root = dsh_bundle_root_real(s);
    if (root[0] == 0) return;
    for (int i = 1; argv[i]; i++) {
        const char *arg = argv[i];
        if (arg[0] != '/') continue;
        if (access(arg, R_OK) == 0) continue;
        size_t rl = strlen(root);
        if (rl + strlen(arg) + 2 >= 4096) continue;
        char candidate[4096];
        snprintf(candidate, sizeof(candidate), "%s%s", root, arg);
        if (access(candidate, R_OK) == 0) {
            /* the entry is an owned js_strdup block: grow it on the runtime heap */
            char *moved = (char *)js_realloc_rt(rt, argv[i], strlen(candidate) + 1);
            if (moved) { memcpy(moved, candidate, strlen(candidate) + 1); argv[i] = moved; }
        }
    }
}

/* Shared fork+exec body for spawn/spawnSync. On success returns the pid and
 * leaves the parent ends in pin/pout/perr (-1 for non-pipe dispositions).
 * extras[] receives the BIDIRECTIONAL parent ends for piped fds 3..7
 * (socketpairs, libuv's own shape for node's extra stdio entries — the
 * parent reads and writes the same descriptor); non-piped extras are -1.
 * On exec failure returns -1 with *exec_errno set (pipes already closed). */
static pid_t dsh_proc_fork_exec(JSContext *ctx, const char *command, char **argv,
                                const char *cwd, char **envp,
                                const int modes[3 + DSH_PROC_EXTRA], int detached,
                                int *pin, int *pout, int *perr,
                                int extras[DSH_PROC_EXTRA], int *exec_errno) {
    int in[2] = { -1, -1 }, out[2] = { -1, -1 }, err[2] = { -1, -1 }, status[2] = { -1, -1 };
    int x[DSH_PROC_EXTRA][2];
    for (int i = 0; i < DSH_PROC_EXTRA; i++) { x[i][0] = x[i][1] = -1; extras[i] = -1; }
    *pin = *pout = *perr = -1;
    if (modes[0] == 0 && pipe(in) < 0) return -1;
    if (modes[1] == 0 && pipe(out) < 0) { dsh_close_all((int[]){in[0], in[1], out[0], out[1], err[0], err[1], status[0], status[1]}, 8); return -1; }
    if (modes[2] == 0 && pipe(err) < 0) { dsh_close_all((int[]){in[0], in[1], out[0], out[1], err[0], err[1], status[0], status[1]}, 8); return -1; }
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        /* mode 0 = pipe (and 'overlapped' — Windows spelling we pipe):
         * a socketpair so the parent's stream is duplex, like node's
         * extra-stdio channels; ignore/inherit extras stay -1. */
        if (modes[3 + i] == 0 && socketpair(AF_UNIX, SOCK_STREAM, 0, x[i]) < 0) {
            for (int j = 0; j < i; j++) { dsh_close_all((int[]){x[j][0], x[j][1]}, 2); }
            dsh_close_all((int[]){in[0], in[1], out[0], out[1], err[0], err[1], status[0], status[1]}, 8);
            return -1;
        }
    }
    if (pipe(status) < 0) {
        for (int i = 0; i < DSH_PROC_EXTRA; i++) dsh_close_all((int[]){x[i][0], x[i][1]}, 2);
        dsh_close_all((int[]){in[0], in[1], out[0], out[1], err[0], err[1], status[0], status[1]}, 8);
        return -1;
    }
    fcntl(status[1], F_SETFD, FD_CLOEXEC); /* the exec-success probe */
    pid_t pid = fork();
    if (pid < 0) {
        for (int i = 0; i < DSH_PROC_EXTRA; i++) dsh_close_all((int[]){x[i][0], x[i][1]}, 2);
        dsh_close_all((int[]){in[0], in[1], out[0], out[1], err[0], err[1], status[0], status[1]}, 8);
        return -1;
    }
    if (pid == 0) {
        /* child: wire stdio, then exec (errno rides the status pipe) */
        if (detached) setsid();
        if (cwd && chdir(cwd) != 0) {
            /* node's contract: a spawn with a missing workdir FAILS with
             * ENOENT (no child runs). The W5-R child-side mkdir -p that
             * stood here materialized every missing workdir and broke that
             * contract (bash-sandbox's invalid-workdir tests measured it
             * 2026-09-27: `true` ran, exit 0, instead of ENOENT). VFS dirs
             * reach this disk through the parent-side mirrors instead
             * (wsMkdir/wsWriteFile -> __dshProcMkdirReal/WriteFileReal). */
            int e = errno;
            (void)!write(status[1], &e, sizeof(e));
            _exit(126);
        }
        int devnull = -1;
        int target[3] = { 0, 1, 2 };
        int *parent[3] = { &in[0], &out[1], &err[1] };
        for (int fd = 0; fd < 3; fd++) {
            if (modes[fd] == 0) {
                dup2(*parent[fd], target[fd]);
            } else if (modes[fd] == 1) {
                if (devnull < 0) devnull = open("/dev/null", O_RDWR);
                dup2(devnull >= 0 ? devnull : target[fd], target[fd]);
            } /* inherit: leave the spike's fd in place */
        }
        for (int i = 0; i < DSH_PROC_EXTRA; i++) {
            if (modes[3 + i] == 0) dup2(x[i][1], 3 + i); /* child's end of the pair */
        }
        int close_fds[7 + 2 * DSH_PROC_EXTRA];
        int n = 0;
        close_fds[n++] = in[0]; close_fds[n++] = in[1];
        close_fds[n++] = out[0]; close_fds[n++] = out[1];
        close_fds[n++] = err[0]; close_fds[n++] = err[1];
        close_fds[n++] = status[0];
        for (int i = 0; i < DSH_PROC_EXTRA; i++) {
            for (int e = 0; e < 2; e++) {
                /* W8: an fd inside the extras window [3, 3+DSH_PROC_EXTRA)
                 * is, after the dup2 loop, either a live channel end (dup2
                 * was a no-op: raw == target) or a replaced parent copy —
                 * the pre-exec close must NEVER touch the window, or a raw
                 * source whose number collides with a target kills that
                 * channel (reproduced standalone: x[2][0] == 7 killed slot
                 * 4's just-dup'd end and the control channel arrived dead). */
                if (x[i][e] < 3 + DSH_PROC_EXTRA) continue;
                close_fds[n++] = x[i][e];
            }
        }
        dsh_close_all(close_fds, n);
        if (devnull > 2) close(devnull);
        dsh_execvpe(command, argv, envp);
        int e = errno;
        (void)!write(status[1], &e, sizeof(e));
        _exit(127);
    }
    /* parent */
    close(status[1]);
    if (modes[0] == 0) close(in[0]);
    if (modes[1] == 0) close(out[1]);
    if (modes[2] == 0) close(err[1]);
    int e = 0;
    ssize_t got = read(status[0], &e, sizeof(e));
    close(status[0]);
    if (got == (ssize_t)sizeof(e)) {
        /* exec (or chdir) failed: node-shaped failure, no child to track */
        dsh_close_all((int[]){in[1], out[0], err[0]}, 3);
        for (int i = 0; i < DSH_PROC_EXTRA; i++) dsh_close_all((int[]){x[i][0], x[i][1]}, 2);
        int st = 0;
        waitpid(pid, &st, 0);
        *exec_errno = e;
        return -1;
    }
    if (modes[0] == 0) { *pin = in[1]; fcntl(in[1], F_SETFL, fcntl(in[1], F_GETFL) | O_NONBLOCK); } /* non-blocking stdin: a paused reader must not deadlock the runtime (the 2MB didOpen abort test) */
    if (modes[1] == 0) { *pout = out[0]; fcntl(out[0], F_SETFL, fcntl(out[0], F_GETFL) | O_NONBLOCK); }
    if (modes[2] == 0) { *perr = err[0]; fcntl(err[0], F_SETFL, fcntl(err[0], F_GETFL) | O_NONBLOCK); }
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        if (modes[3 + i] == 0) {
            close(x[i][1]); /* the child holds its duplicated end now */
            extras[i] = x[i][0];
            fcntl(x[i][0], F_SETFL, fcntl(x[i][0], F_GETFL) | O_NONBLOCK);
        }
    }
    return pid;
}

/* Read one stream to a grow buffer until EAGAIN or EOF; returns 1 on EOF,
 * 0 on would-block, -1 on hard error (treated as EOF). */
static int dsh_drain_fd(JSRuntime *rt, int fd, unsigned char **buf, size_t *n, size_t *cap) {
    for (;;) {
        if (*n == *cap) {
            size_t next = *cap ? *cap * 2 : 8192;
            unsigned char *grown = js_realloc_rt(rt, *buf, next); /* raw heap: no context needed */
            if (!grown) return 1;
            *buf = grown; *cap = next;
        }
        ssize_t r = read(fd, *buf + *n, *cap - *n);
        if (r > 0) { *n += (size_t)r; continue; }
        if (r == 0) return 1;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        if (errno == EINTR) continue;
        return 1;
    }
}

/* The JS-side per-child pump contract: one poll = one non-blocking read pass
 * + a WNOHANG reap. Response fields: out/err (b64 or null), outEof/errEof,
 * exited, exitCode (null until reaped-exit), signal (null or number). */
static JSValue js_proc_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0;
    if (argc < 1 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshProcPoll needs a pid");
    dsh_proc *p = dsh_proc_slot(s, (int)pid);
    if (!p) {
        /* Slot released (settled + drained before the last JS pump tick):
         * report a settled child instead of throwing through a timer. */
        JSValue settled = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, settled, "out", JS_NULL);
        JS_SetPropertyStr(ctx, settled, "err", JS_NULL);
        JS_SetPropertyStr(ctx, settled, "outEof", JS_TRUE);
        JS_SetPropertyStr(ctx, settled, "errEof", JS_TRUE);
        JS_SetPropertyStr(ctx, settled, "exited", JS_TRUE);
        JS_SetPropertyStr(ctx, settled, "exitCode", JS_NewInt32(ctx, 0));
        JS_SetPropertyStr(ctx, settled, "signal", JS_NULL);
        return settled;
    }
    JSRuntime *rt = s->rt;
    /* Flush the stdin backpressure buffer first: whatever the child's pipe
     * accepts this tick drains toward the reader; EPIPE (reader gone)
     * surfaces as flushError so the JS shim fails the pending writes. */
    int flush_err = 0;
    while (p->pending_n > 0 && p->stdin_w >= 0) {
        ssize_t w = write(p->stdin_w, p->pending, p->pending_n);
        if (w > 0) {
            memmove(p->pending, p->pending + w, p->pending_n - (size_t)w);
            p->pending_n -= (size_t)w;
            continue;
        }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break; /* still backpressured */
        flush_err = errno ? errno : EPIPE;
        break;
    }
    if (p->pending_n == 0 && p->flush_err == 0) p->flush_err = flush_err;
    /* Same flush pass for the extra channels' write buffers (W6-U). */
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        while (p->xpending_n[i] > 0 && p->extra_r[i] >= 0) {
            ssize_t w = write(p->extra_r[i], p->xpending[i], p->xpending_n[i]);
            if (w > 0) {
                memmove(p->xpending[i], p->xpending[i] + w, p->xpending_n[i] - (size_t)w);
                p->xpending_n[i] -= (size_t)w;
                continue;
            }
            if (w < 0 && errno == EINTR) continue;
            break; /* EAGAIN or gone — retried next tick */
        }
    }
    unsigned char *outb = NULL, *errb = NULL;
    size_t on = 0, ocap = 0, en = 0, ecap = 0;
    int out_eof = 0, err_eof = 0;
    if (p->stdout_r >= 0) {
        out_eof = dsh_drain_fd(rt, p->stdout_r, &outb, &on, &ocap);
        if (out_eof) { close(p->stdout_r); p->stdout_r = -1; p->out_eof = 1; }
    } else out_eof = p->out_eof;
    if (p->stderr_r >= 0) {
        err_eof = dsh_drain_fd(rt, p->stderr_r, &errb, &en, &ecap);
        if (err_eof) { close(p->stderr_r); p->stderr_r = -1; p->err_eof = 1; }
    } else err_eof = p->err_eof;
    if (out_eof && p->stdout_r >= 0) { close(p->stdout_r); p->stdout_r = -1; p->out_eof = 1; }
    if (err_eof && p->stderr_r >= 0) { close(p->stderr_r); p->stderr_r = -1; p->err_eof = 1; }
    /* Drain the extra duplex channels the same way (W6-U): bytes surface as
     * extraOut[i], EOF as extraEof[i]. */
    unsigned char *xbuf[DSH_PROC_EXTRA] = { 0 };
    size_t xn[DSH_PROC_EXTRA] = { 0 }, xcap[DSH_PROC_EXTRA] = { 0 };
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        if (p->extra_r[i] >= 0) {
            int xe = dsh_drain_fd(rt, p->extra_r[i], &xbuf[i], &xn[i], &xcap[i]);
            if (xe) { close(p->extra_r[i]); p->extra_r[i] = -1; p->extra_eof[i] = 1; }
        }
    }

    int exited = 0, exit_code = 0, exit_sig = 0;
    if (!p->reaped) {
        int st = 0;
        pid_t r = waitpid((pid_t)p->pid, &st, WNOHANG);
        if (r == (pid_t)p->pid) {
            p->reaped = 1;
            if (WIFEXITED(st)) { p->exit_code = WEXITSTATUS(st); p->exit_sig = 0; }
            else if (WIFSIGNALED(st)) { p->exit_code = -1; p->exit_sig = WTERMSIG(st); }
        } else if (r < 0 && errno == ECHILD) {
            p->reaped = 1; p->exit_code = 0; p->exit_sig = 0;
        }
    }
    exited = p->reaped;
    exit_code = p->exit_code;
    exit_sig = p->exit_sig;

    JSValue res = JS_NewObject(ctx);
    JSValue outv, errv;
    if (on > 0) { char *b64 = dsh_b64_encode_bytes(ctx, outb, on); outv = b64 ? JS_NewString(ctx, b64) : JS_NULL; js_free(ctx, b64); }
    else outv = JS_NULL;
    if (en > 0) { char *b64 = dsh_b64_encode_bytes(ctx, errb, en); errv = b64 ? JS_NewString(ctx, b64) : JS_NULL; js_free(ctx, b64); }
    else errv = JS_NULL;
    js_free_rt(rt, outb); js_free_rt(rt, errb);
    JS_SetPropertyStr(ctx, res, "out", outv);
    JS_SetPropertyStr(ctx, res, "err", errv);
    JS_SetPropertyStr(ctx, res, "outEof", JS_NewBool(ctx, p->out_eof));
    JS_SetPropertyStr(ctx, res, "errEof", JS_NewBool(ctx, p->err_eof));
    JS_SetPropertyStr(ctx, res, "exited", JS_NewBool(ctx, exited));
    JS_SetPropertyStr(ctx, res, "exitCode", exited && exit_sig == 0 ? JS_NewInt32(ctx, exit_code) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "signal", exited && exit_sig != 0 ? JS_NewInt32(ctx, exit_sig) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "pendingStdin", JS_NewInt32(ctx, (int32_t)p->pending_n));
    JS_SetPropertyStr(ctx, res, "flushError", p->flush_err != 0 ? JS_NewInt32(ctx, p->flush_err) : JS_NULL);
    /* Extra-channel reads ride parallel arrays (b64-or-null per slot 0..4 →
     * child fds 3..7) plus pending-byte counts so the JS write callbacks
     * resolve on drain, exactly like the stdin face. */
    JSValue xout = JS_NewArray(ctx);
    JSValue xeof = JS_NewArray(ctx);
    JSValue xpend = JS_NewArray(ctx);
    char idx[8];
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        snprintf(idx, sizeof(idx), "%d", i);
        if (xn[i] > 0) {
            char *xb64 = dsh_b64_encode_bytes(ctx, xbuf[i], xn[i]);
            JS_SetPropertyStr(ctx, xout, idx, xb64 ? JS_NewString(ctx, xb64) : JS_NULL);
            js_free(ctx, xb64);
        } else {
            JS_SetPropertyStr(ctx, xout, idx, JS_NULL);
        }
        JS_SetPropertyStr(ctx, xeof, idx, JS_NewBool(ctx, p->extra_eof[i]));
        JS_SetPropertyStr(ctx, xpend, idx, JS_NewInt32(ctx, (int32_t)p->xpending_n[i]));
        if (xbuf[i]) js_free_rt(rt, xbuf[i]);
    }
    JS_SetPropertyStr(ctx, res, "extraOut", xout);
    JS_SetPropertyStr(ctx, res, "extraEof", xeof);
    JS_SetPropertyStr(ctx, res, "extraPending", xpend);
    /* Fully settled and drained: release the slot (pid no longer needed). */
    int extras_done = 1;
    for (int i = 0; i < DSH_PROC_EXTRA; i++) {
        if (p->extra_r[i] >= 0 || p->xpending_n[i] > 0) extras_done = 0;
    }
    if (exited && p->stdin_w < 0 && p->stdout_r < 0 && p->stderr_r < 0 && p->pending_n == 0 && extras_done) {
        js_free_rt(rt, p->pending);
        p->pending = NULL; p->pending_n = 0; p->pending_cap = 0;
        for (int i = 0; i < DSH_PROC_EXTRA; i++) {
            if (p->xpending[i]) { js_free_rt(rt, p->xpending[i]); p->xpending[i] = NULL; }
            p->xpending_n[i] = 0; p->xpending_cap[i] = 0;
        }
        p->used = 0;
    }
    return res;
}

/* __dshProcReadReal(path) → base64 | null: one REAL file read for the
 * parent side of the seam (children write marker files the runtime's VFS
 * cannot see). Size-capped (16 MB) — markers are tiny. */
static JSValue js_proc_read_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcReadReal needs a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    FILE *f = fopen(path, "rb");
    JS_FreeCString(ctx, path);
    if (!f) return JS_NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0 || n > 16 * 1024 * 1024) { fclose(f); return JS_NULL; }
    unsigned char *bytes = js_malloc(ctx, (size_t)(n > 0 ? n : 1));
    if (!bytes) { fclose(f); return JS_EXCEPTION; }
    size_t got = fread(bytes, 1, (size_t)n, f);
    fclose(f);
    char *b64 = dsh_b64_encode_bytes(ctx, bytes, got);
    js_free(ctx, bytes);
    if (!b64) return JS_EXCEPTION;
    JSValue res = JS_NewString(ctx, b64);
    js_free(ctx, b64);
    return res;
}

/* __dshProcMkdirReal(path) → bool: recursive real-disk mkdir. The
 * workspace VFS mirrors the (real) profile container in memory only;
 * directories the parent creates so a CHILD can write into them must
 * materialize on the disk the child reads. The JS callers keep VFS
 * behavior and add this write-through (W5-R, 2026-09-28). */
static JSValue js_proc_mkdir_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcMkdirReal needs a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    char stage[4096];
    snprintf(stage, sizeof(stage), "%s", path);
    for (char *at = stage + 1; *at; at++) {
        if (*at == '/') {
            *at = 0;
            (void)!mkdir(stage, 0755);
            *at = '/';
        }
    }
    int r = mkdir(stage, 0755);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r == 0 || errno == EEXIST);
}

/* __dshProcWriteFileReal(path, b64) → {written} | {error:{code,errno}}:
 * a REAL file write for the parent side of the seam (W6-U, 2026-09-28).
 * The workspace VFS is in-memory; a SPAWNED child reads the real disk, so
 * files the parent writes under the real-mirrored profile container must
 * materialize there — this is the write-through twin of __dshProcMkdirReal
 * (parents are mkdir -p'd first, same idempotent rule). 8 MB cap: suite
 * payloads are tiny; a runaway mirror should fail loudly, not eat memory. */
static JSValue js_proc_write_file_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "__dshProcWriteFileReal needs (path, base64)");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    char stage[4096];
    snprintf(stage, sizeof(stage), "%s", path);
    for (char *at = stage + 1; *at; at++) {
        if (*at == '/') { *at = 0; (void)!mkdir(stage, 0755); *at = '/'; }
    }
    FILE *f = fopen(stage, "wb");
    if (!f) {
        int e = errno;
        const char *name = dsh_errno_name(e);
        JSValue r = JS_NewObject(ctx), eo = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, eo, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, eo, "errno", JS_NewInt32(ctx, e));
        JS_SetPropertyStr(ctx, r, "error", eo);
        JS_FreeCString(ctx, path);
        return r;
    }
    size_t bn = 0;
    const char *b64 = JS_ToCStringLen(ctx, &bn, argv[1]);
    size_t bytes_n = 0;
    unsigned char *bytes = b64 ? dsh_b64_decode_bytes(ctx, b64, bn, &bytes_n) : NULL;
    if (b64) JS_FreeCString(ctx, b64);
    if (!bytes) { fclose(f); JS_FreeCString(ctx, path); return JS_ThrowTypeError(ctx, "__dshProcWriteFileReal input is not valid base64"); }
    size_t wrote = bytes_n > 0 ? fwrite(bytes, 1, bytes_n, f) : 0;
    int ferr = ferror(f);
    fclose(f);
    js_free(ctx, bytes);
    JS_FreeCString(ctx, path);
    JSValue r = JS_NewObject(ctx);
    if (ferr || wrote != bytes_n) {
        JSValue eo = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, eo, "code", JS_NewString(ctx, "EIO"));
        JS_SetPropertyStr(ctx, eo, "errno", JS_NewInt32(ctx, EIO));
        JS_SetPropertyStr(ctx, r, "error", eo);
    } else {
        JS_SetPropertyStr(ctx, r, "written", JS_NewInt32(ctx, (int32_t)wrote));
    }
    return r;
}

/* __dshProcRmReal(path, recursive) → bool: a REAL unlink for the mirror
 * (W6-U): when the runtime's VFS rm removes a file the children could read,
 * the real copy must go too or a subsequent child sees a zombie file. Files
 * unlink directly; directories walk their children depth-first (rm -rf for
 * the recursive flag, rmdir-only otherwise — mirroring node's rm faces). */
static int dsh_rm_real_recursive(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return errno == ENOENT ? 1 : 0;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (!d) return 0;
        struct dirent *ent;
        int ok = 1;
        while ((ent = readdir(d)) != NULL) {
            if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
            char child[4096];
            if (snprintf(child, sizeof(child), "%s/%s", path, ent->d_name) >= (int)sizeof(child)) { ok = 0; break; }
            if (!dsh_rm_real_recursive(child)) { ok = 0; break; }
        }
        closedir(d);
        if (ok && rmdir(path) != 0 && errno != ENOENT) ok = 0;
        return ok;
    }
    return unlink(path) == 0 || errno == ENOENT;
}
static JSValue js_proc_rm_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcRmReal needs a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    int recursive = argc >= 2 && JS_ToBool(ctx, argv[1]) > 0;
    int ok = dsh_rm_real_recursive(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}

/* __dshProcChmodReal(path, mode) → bool over chmod(2): the real-mode mirror
 * of the W6-U write/rm mirrors — a hook script the runtime chmods +x in the
 * VFS must land executable on the disk the seam's children read, or bash
 * refuses it ("Permission denied", measured 2026-09-27 on the hooks
 * bridge spec). Best-effort mirrors stay boolean: the VFS is the world of
 * record; this only feeds the seam's children. */
static JSValue js_proc_chmod_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcChmodReal needs (path, mode)");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    int32_t mode = 0;
    JS_ToInt32(ctx, &mode, argv[1]);
    int r = chmod(path, (mode_t)mode);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r == 0);
}

/* __dshProcStatReal(path) → {mode,size,mtimeMs,isFile,isDirectory} | null:
 * a REAL stat(2) probe. The runtime's fs faces are (partly) virtual; the
 * subprocess seam's consumers (the vendored pre-spawn executability check)
 * stat REAL binaries (the node running the fixture servers). VFS-first
 * precedence lives in the JS callers — this is the fallback only. */
static JSValue js_proc_stat_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcStatReal needs a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    struct stat st;
    int ok = stat(path, &st);
    JS_FreeCString(ctx, path);
    if (ok != 0) return JS_NULL;
    JSValue res = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, res, "mode", JS_NewInt32(ctx, (int32_t)(st.st_mode & 0xffff)));
    JS_SetPropertyStr(ctx, res, "size", JS_NewInt64(ctx, (int64_t)st.st_size));
    /* BSD/Darwin names the timespec st_mtimespec; POSIX 2008 (glibc, musl —
     * the harmony/android toolchains, both with _GNU_SOURCE) names it st_mtim. */
#if defined(__APPLE__)
    int64_t mtime_ms = (int64_t)(st.st_mtimespec.tv_sec * 1000 + st.st_mtimespec.tv_nsec / 1000000);
#else
    int64_t mtime_ms = (int64_t)(st.st_mtim.tv_sec * 1000 + st.st_mtim.tv_nsec / 1000000);
#endif
    JS_SetPropertyStr(ctx, res, "mtimeMs", JS_NewInt64(ctx, mtime_ms));
    JS_SetPropertyStr(ctx, res, "isFile", JS_NewBool(ctx, S_ISREG(st.st_mode)));
    JS_SetPropertyStr(ctx, res, "isDirectory", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
    return res;
}

/* __dshProcAccessReal(path, mode) → bool over access(2) (X_OK=1, R_OK=4). */
static JSValue js_proc_access_real(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcAccessReal needs (path, mode)");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    int32_t mode = 0;
    JS_ToInt32(ctx, &mode, argv[1]);
    int r = access(path, (int)mode);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r == 0);
}

/* __dshProcWrite(pid, b64) → {written} | {error:{code,errno}}. */
static JSValue js_proc_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0;
    if (argc < 2 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshProcWrite needs (pid, base64)");
    dsh_proc *p = dsh_proc_slot(s, (int)pid);
    if (!p || p->stdin_w < 0) {
        JSValue r = JS_NewObject(ctx);
        JSValue e = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, "EPIPE"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, EPIPE));
        JS_SetPropertyStr(ctx, r, "error", e);
        return r;
    }
    size_t n = 0;
    const char *b64 = JS_ToCStringLen(ctx, &n, argv[1]);
    if (!b64) return JS_EXCEPTION;
    size_t bytes_n = 0;
    unsigned char *bytes = dsh_b64_decode_bytes(ctx, b64, n, &bytes_n);
    JS_FreeCString(ctx, b64);
    if (!bytes) return JS_ThrowTypeError(ctx, "__dshProcWrite input is not valid base64");
    size_t written = 0;
    int werr = 0;
    while (written < bytes_n) {
        ssize_t w = write(p->stdin_w, bytes + written, bytes_n - written);
        if (w > 0) { written += (size_t)w; continue; }
        if (w < 0 && errno == EINTR) continue;
        werr = errno;
        break;
    }
    js_free(ctx, bytes);
    JSValue r = JS_NewObject(ctx);
    if (werr) {
        close(p->stdin_w); p->stdin_w = -1;
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(werr);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, werr));
        JS_SetPropertyStr(ctx, r, "error", e);
    } else {
        JS_SetPropertyStr(ctx, r, "written", JS_NewInt32(ctx, (int32_t)written));
    }
    return r;
}

/* __dshProcEndStdin(pid): close the child's stdin (EOF marker). */
static JSValue js_proc_end_stdin(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0;
    if (argc < 1 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshProcEndStdin needs a pid");
    dsh_proc *p = dsh_proc_slot(s, (int)pid);
    if (p && p->stdin_w >= 0) { close(p->stdin_w); p->stdin_w = -1; }
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ok", JS_TRUE);
    return r;
}

/* __dshProcWriteFd(pid, slot, b64) → {written, buffered} | {error} — the
 * extra-channel write face (W6-U): slot 0..4 maps to child fd 3..7. The
 * socketpair is non-blocking; refused bytes buffer C-side (flushed by the
 * poll tick) and `buffered` tells the JS shim to hold its write callback,
 * the exact contract the stdin face honors. */
static JSValue js_proc_write_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0, slot = 0;
    if (argc < 3 || JS_ToInt32(ctx, &pid, argv[0]) < 0 || JS_ToInt32(ctx, &slot, argv[1]) < 0)
        return JS_ThrowTypeError(ctx, "__dshProcWriteFd needs (pid, slot, base64)");
    if (slot < 0 || slot >= DSH_PROC_EXTRA) return JS_ThrowTypeError(ctx, "__dshProcWriteFd: slot out of range");
    dsh_proc *p = dsh_proc_slot(s, (int)pid);
    if (!p || p->extra_r[slot] < 0) {
        JSValue r = JS_NewObject(ctx), e = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, "EPIPE"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, EPIPE));
        JS_SetPropertyStr(ctx, r, "error", e);
        return r;
    }
    size_t n = 0;
    const char *b64 = JS_ToCStringLen(ctx, &n, argv[2]);
    if (!b64) return JS_EXCEPTION;
    size_t bytes_n = 0;
    unsigned char *bytes = dsh_b64_decode_bytes(ctx, b64, n, &bytes_n);
    JS_FreeCString(ctx, b64);
    if (!bytes) return JS_ThrowTypeError(ctx, "__dshProcWriteFd input is not valid base64");
    size_t written = 0;
    int werr = 0;
    while (written < bytes_n) {
        ssize_t w = write(p->extra_r[slot], bytes + written, bytes_n - written);
        if (w > 0) { written += (size_t)w; continue; }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break; /* buffered below */
        werr = errno;
        break;
    }
    /* The refused tail rides the slot's backpressure buffer. */
    size_t rest = bytes_n - written;
    if (!werr && rest > 0) {
        unsigned char *grown = js_realloc_rt(s->rt, p->xpending[slot], p->xpending_n[slot] + rest);
        if (grown) {
            memcpy(grown + p->xpending_n[slot], bytes + written, rest);
            p->xpending[slot] = grown;
            p->xpending_n[slot] += rest;
            if (p->xpending_cap[slot] < p->xpending_n[slot]) p->xpending_cap[slot] = p->xpending_n[slot];
        } else werr = ENOMEM;
    }
    js_free(ctx, bytes);
    JSValue r = JS_NewObject(ctx);
    if (werr) {
        close(p->extra_r[slot]); p->extra_r[slot] = -1;
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(werr);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, werr));
        JS_SetPropertyStr(ctx, r, "error", e);
    } else {
        JS_SetPropertyStr(ctx, r, "written", JS_NewInt32(ctx, (int32_t)written));
        JS_SetPropertyStr(ctx, r, "buffered", JS_NewInt32(ctx, (int32_t)(p->xpending_n[slot])));
    }
    return r;
}

/* __dshProcEndFd(pid, slot): half-close the extra channel — the child reads
 * EOF on its fd while our read side stays live (shutdown, not close). */
static JSValue js_proc_end_fd(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0, slot = 0;
    if (argc < 2 || JS_ToInt32(ctx, &pid, argv[0]) < 0 || JS_ToInt32(ctx, &slot, argv[1]) < 0)
        return JS_ThrowTypeError(ctx, "__dshProcEndFd needs (pid, slot)");
    if (slot < 0 || slot >= DSH_PROC_EXTRA) return JS_ThrowTypeError(ctx, "__dshProcEndFd: slot out of range");
    dsh_proc *p = dsh_proc_slot(s, (int)pid);
    if (p && p->extra_r[slot] >= 0) shutdown(p->extra_r[slot], SHUT_WR);
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ok", JS_TRUE);
    return r;
}

/* __dshProcKill(pid, signalNameOrNumber) → {ok} | throws (ESRCH contract of
 * process.kill). Signal 0 probes existence without signalling. */
static JSValue js_proc_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t pid = 0, sig = SIGTERM;
    if (argc < 1 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshProcKill needs (pid, signal)");
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        sig = dsh_signal_num(ctx, argv[1]);
        if (sig < 0) return JS_ThrowTypeError(ctx, "__dshProcKill: unknown signal");
    }
    if (kill((pid_t)pid, sig) != 0) {
        int e = errno;
        const char *name = dsh_errno_name(e);
        return JS_ThrowTypeError(ctx, "kill %d failed: %s", pid, name ? name : "EIO");
    }
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ok", JS_TRUE);
    return r;
}

/* ---- forkpty seam intrinsics (see the section comment above) ------------- */

static dsh_pty *dsh_pty_slot(dsh_spike_t *s, int pid) {
    for (int i = 0; i < DSH_PTY_MAX_SLOTS; i++) {
        if (s->ptys[i].used && s->ptys[i].pid == pid) return &s->ptys[i];
    }
    return NULL;
}

/* __dshPtySpawn({file,args,cwd,env,cols,rows}) → {pid} | {error:{code,errno}}.
 * forkpty(3): the child is a session leader with the slave as its
 * controlling terminal and stdio on it — the honest terminal the vendored
 * terminal path requires. A missing workdir FAILS with ENOENT (no child
 * runs), the same contract the subprocess seam enforces. */
static JSValue js_pty_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "__dshPtySpawn needs an options object");
#ifndef DSH_HAVE_FORKPTY
    (void)s;
    return JS_ThrowTypeError(ctx, "__dshPtySpawn: no forkpty on this host (the pty seam is unavailable here)");
#else
    const char *file = NULL; char **cargv = NULL, **envp = NULL;
    const char *cwd = NULL; char *err = NULL;
    int32_t cols = 80, rows = 24;
    JSValue fv = JS_GetPropertyStr(ctx, argv[0], "file");
    const char *f = JS_IsException(fv) ? NULL : JS_ToCString(ctx, fv);
    JS_FreeValue(ctx, fv);
    if (!f) return JS_ThrowTypeError(ctx, "__dshPtySpawn: file missing");
    file = js_strdup(ctx, f);
    JS_FreeCString(ctx, f);
    JSValue av = JS_GetPropertyStr(ctx, argv[0], "args");
    if (!dsh_build_str_array(ctx, av, file, &cargv, &err)) {
        JS_FreeValue(ctx, av);
        js_free(ctx, (void *)file);
        return JS_ThrowTypeError(ctx, "__dshPtySpawn: %s", err ? err : "bad args");
    }
    JS_FreeValue(ctx, av);
    JSValue cwdv = JS_GetPropertyStr(ctx, argv[0], "cwd");
    if (!JS_IsUndefined(cwdv) && !JS_IsNull(cwdv)) {
        const char *cd = JS_ToCString(ctx, cwdv);
        if (cd) { cwd = js_strdup(ctx, cd); JS_FreeCString(ctx, cd); }
    }
    JS_FreeValue(ctx, cwdv);
    JSValue envv = JS_GetPropertyStr(ctx, argv[0], "env");
    if (JS_IsObject(envv) && !dsh_build_envp(ctx, envv, &envp, &err)) {
        JS_FreeValue(ctx, envv);
        dsh_free_vec(ctx, cargv);
        js_free(ctx, (void *)file);
        js_free(ctx, (void *)cwd);
        return JS_ThrowTypeError(ctx, "__dshPtySpawn: %s", err ? err : "bad env");
    }
    JS_FreeValue(ctx, envv);
    JSValue cv = JS_GetPropertyStr(ctx, argv[0], "cols");
    if (!JS_IsUndefined(cv)) JS_ToInt32(ctx, &cols, cv);
    JS_FreeValue(ctx, cv);
    JSValue rv = JS_GetPropertyStr(ctx, argv[0], "rows");
    if (!JS_IsUndefined(rv)) JS_ToInt32(ctx, &rows, rv);
    JS_FreeValue(ctx, rv);

    struct winsize ws = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
    int master = -1;
    int status[2] = { -1, -1 };
    if (pipe(status) < 0) {
        dsh_free_vec(ctx, cargv); dsh_free_vec(ctx, envp);
        js_free(ctx, (void *)file); js_free(ctx, (void *)cwd);
        return JS_ThrowTypeError(ctx, "__dshPtySpawn: status pipe failed");
    }
    fcntl(status[1], F_SETFD, FD_CLOEXEC); /* the exec-success probe */
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) {
        int e = errno;
        dsh_close_all((int[]){status[0], status[1]}, 2);
        dsh_free_vec(ctx, cargv); dsh_free_vec(ctx, envp);
        js_free(ctx, (void *)file); js_free(ctx, (void *)cwd);
        return JS_ThrowTypeError(ctx, "__dshPtySpawn: forkpty failed: %s",
                                 dsh_errno_name(e) ? dsh_errno_name(e) : "EIO");
    }
    if (pid == 0) {
        /* child: the slave is already stdio + controlling tty (forkpty);
         * only the workdir and the program remain. */
        if (cwd && chdir(cwd) != 0) {
            int e = errno;
            (void)!write(status[1], &e, sizeof(e));
            _exit(126);
        }
        if (envp) dsh_execvpe(cargv[0], cargv, envp);
        else execvp(cargv[0], cargv); /* no env map: node inherits process.env */
        int e = errno;
        (void)!write(status[1], &e, sizeof(e));
        _exit(126);
    }
    /* parent: read the exec probe — a short read carrying errno means the
     * child never exec'd (node's contract: the spawn FAILS). */
    close(status[1]);
    int exec_errno = 0;
    ssize_t got = read(status[0], &exec_errno, sizeof(exec_errno));
    close(status[0]);
    dsh_free_vec(ctx, cargv); dsh_free_vec(ctx, envp);
    js_free(ctx, (void *)file); js_free(ctx, (void *)cwd);
    if (got == (ssize_t)sizeof(exec_errno) && exec_errno != 0) {
        close(master);
        kill(pid, SIGKILL);
        waitpid(pid, NULL, 0);
        JSValue res = JS_NewObject(ctx);
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(exec_errno);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, exec_errno));
        JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, "spawn failed"));
        JS_SetPropertyStr(ctx, res, "error", e);
        return res;
    }
    dsh_pty *t = NULL;
    for (int i = 0; i < DSH_PTY_MAX_SLOTS; i++) {
        if (!s->ptys[i].used) { t = &s->ptys[i]; break; }
    }
    if (!t) {
        kill(pid, SIGKILL);
        waitpid(pid, NULL, 0);
        close(master);
        return JS_ThrowTypeError(ctx, "__dshPtySpawn: pty table full (%d)", DSH_PTY_MAX_SLOTS);
    }
    fcntl(master, F_SETFL, fcntl(master, F_GETFL, 0) | O_NONBLOCK);
    t->used = 1; t->pid = (int)pid; t->master = master;
    t->eof = 0; t->reaped = 0; t->exit_code = 0; t->exit_sig = 0;
    t->pending = NULL; t->pending_n = 0; t->pending_cap = 0; t->flush_err = 0;
    JSValue res = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, res, "pid", JS_NewInt32(ctx, (int32_t)pid));
    return res;
#endif
}

/* __dshPtyPoll(pid) → {out(b64|null), outEof, exited, exitCode, signal,
 * pendingStdin, flushError} — one non-blocking read pass on the master plus
 * a WNOHANG reap, the same pump contract the child-process poll serves
 * (the JS pump turns it into the pty.event sequence). Reading a master
 * whose slave side is gone raises EIO — dsh_drain_fd already reports that
 * as EOF, which is exactly the terminal's EOF shape. */
static JSValue js_pty_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0;
    if (argc < 1 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshPtyPoll needs a pid");
    dsh_pty *t = dsh_pty_slot(s, (int)pid);
    if (!t) {
        /* Slot released (settled + drained before the last JS pump tick):
         * report a settled terminal instead of throwing through a timer. */
        JSValue settled = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, settled, "out", JS_NULL);
        JS_SetPropertyStr(ctx, settled, "outEof", JS_TRUE);
        JS_SetPropertyStr(ctx, settled, "exited", JS_TRUE);
        JS_SetPropertyStr(ctx, settled, "exitCode", JS_NewInt32(ctx, 0));
        JS_SetPropertyStr(ctx, settled, "signal", JS_NULL);
        JS_SetPropertyStr(ctx, settled, "pendingStdin", JS_NewInt32(ctx, 0));
        JS_SetPropertyStr(ctx, settled, "flushError", JS_NULL);
        return settled;
    }
    JSRuntime *rt = s->rt;
    /* Flush the master-write backpressure buffer first (same discipline as
     * the pipe seam's stdin face): EAGAIN parks the tail for the next tick,
     * a dead master surfaces as flushError so JS fails the pending writes. */
    int flush_err = 0;
    while (t->pending_n > 0 && t->master >= 0) {
        ssize_t w = write(t->master, t->pending, t->pending_n);
        if (w > 0) {
            memmove(t->pending, t->pending + w, t->pending_n - (size_t)w);
            t->pending_n -= (size_t)w;
            continue;
        }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        flush_err = errno ? errno : EIO;
        break;
    }
    if (t->pending_n == 0 && t->flush_err == 0) t->flush_err = flush_err;
    unsigned char *outb = NULL;
    size_t on = 0, ocap = 0;
    int out_eof = 0;
    if (t->master >= 0) {
        out_eof = dsh_drain_fd(rt, t->master, &outb, &on, &ocap);
        if (out_eof) { close(t->master); t->master = -1; t->eof = 1; }
    } else out_eof = t->eof;
    if (!t->reaped) {
        int st = 0;
        pid_t r = waitpid((pid_t)t->pid, &st, WNOHANG);
        if (r == (pid_t)t->pid) {
            t->reaped = 1;
            if (WIFEXITED(st)) { t->exit_code = WEXITSTATUS(st); t->exit_sig = 0; }
            else if (WIFSIGNALED(st)) { t->exit_code = -1; t->exit_sig = WTERMSIG(st); }
        } else if (r < 0 && errno == ECHILD) {
            t->reaped = 1; t->exit_code = 0; t->exit_sig = 0;
        }
    }
    JSValue res = JS_NewObject(ctx);
    JSValue outv;
    if (on > 0) {
        char *b64 = dsh_b64_encode_bytes(ctx, outb, on);
        outv = b64 ? JS_NewString(ctx, b64) : JS_NULL;
        js_free(ctx, b64);
    } else outv = JS_NULL;
    js_free_rt(rt, outb);
    JS_SetPropertyStr(ctx, res, "out", outv);
    JS_SetPropertyStr(ctx, res, "outEof", JS_NewBool(ctx, t->eof));
    JS_SetPropertyStr(ctx, res, "exited", JS_NewBool(ctx, t->reaped));
    JS_SetPropertyStr(ctx, res, "exitCode", t->reaped && t->exit_sig == 0 ? JS_NewInt32(ctx, t->exit_code) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "signal", t->reaped && t->exit_sig != 0 ? JS_NewInt32(ctx, t->exit_sig) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "pendingStdin", JS_NewInt32(ctx, (int32_t)t->pending_n));
    JS_SetPropertyStr(ctx, res, "flushError", t->flush_err != 0 ? JS_NewInt32(ctx, t->flush_err) : JS_NULL);
    /* Fully settled and drained: release the slot (pid no longer needed). */
    if (t->reaped && t->master < 0 && t->pending_n == 0) {
        js_free_rt(rt, t->pending);
        t->pending = NULL; t->pending_n = 0; t->pending_cap = 0;
        t->used = 0;
    }
    return res;
}

/* __dshPtyWrite(pid, b64) → {written, buffered} | {error:{code,errno}} —
 * keystrokes into the master; the refused tail parks in the slot's
 * backpressure buffer and drains on the pump's poll ticks. */
static JSValue js_pty_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0;
    if (argc < 2 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshPtyWrite needs (pid, base64)");
    dsh_pty *t = dsh_pty_slot(s, (int)pid);
    if (!t || t->master < 0) {
        JSValue r = JS_NewObject(ctx);
        JSValue e = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, "EPIPE"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, EPIPE));
        JS_SetPropertyStr(ctx, r, "error", e);
        return r;
    }
    size_t n = 0;
    const char *b64 = JS_ToCStringLen(ctx, &n, argv[1]);
    if (!b64) return JS_EXCEPTION;
    size_t bytes_n = 0;
    unsigned char *bytes = dsh_b64_decode_bytes(ctx, b64, n, &bytes_n);
    JS_FreeCString(ctx, b64);
    if (!bytes) return JS_ThrowTypeError(ctx, "__dshPtyWrite input is not valid base64");
    size_t written = 0;
    int werr = 0;
    while (written < bytes_n) {
        ssize_t w = write(t->master, bytes + written, bytes_n - written);
        if (w > 0) { written += (size_t)w; continue; }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { errno = 0; break; }
        werr = errno;
        break;
    }
    /* the refused tail parks (accepted-but-unwritten), drained at poll */
    size_t buffered = bytes_n - written;
    if (buffered > 0 && !werr) {
        if (t->pending_n + buffered > t->pending_cap) {
            size_t next = t->pending_cap ? t->pending_cap : 8192;
            while (next < t->pending_n + buffered) next *= 2;
            unsigned char *grown = js_realloc_rt(s->rt, t->pending, next);
            if (!grown) { js_free(ctx, bytes); return JS_ThrowTypeError(ctx, "__dshPtyWrite: out of memory"); }
            t->pending = grown; t->pending_cap = next;
        }
        memcpy(t->pending + t->pending_n, bytes + written, buffered);
        t->pending_n += buffered;
    }
    js_free(ctx, bytes);
    JSValue r = JS_NewObject(ctx);
    if (werr) {
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(werr);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, werr));
        JS_SetPropertyStr(ctx, r, "error", e);
    } else {
        JS_SetPropertyStr(ctx, r, "written", JS_NewInt32(ctx, (int32_t)written));
        JS_SetPropertyStr(ctx, r, "buffered", JS_NewInt32(ctx, (int32_t)buffered));
    }
    return r;
}

/* __dshPtyResize(pid, cols, rows) → {ok} | throws — TIOCSWINSZ on the
 * master; the kernel delivers SIGWINCH to the child's foreground group. */
static JSValue js_pty_resize(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    int32_t pid = 0, cols = 0, rows = 0;
    if (argc < 3 || JS_ToInt32(ctx, &pid, argv[0]) < 0
        || JS_ToInt32(ctx, &cols, argv[1]) < 0 || JS_ToInt32(ctx, &rows, argv[2]) < 0) {
        return JS_ThrowTypeError(ctx, "__dshPtyResize needs (pid, cols, rows)");
    }
    dsh_pty *t = dsh_pty_slot(s, (int)pid);
    if (!t || t->master < 0) return JS_ThrowTypeError(ctx, "__dshPtyResize: no such pty");
    struct winsize ws = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
    if (ioctl(t->master, TIOCSWINSZ, &ws) != 0) {
        int e = errno;
        const char *name = dsh_errno_name(e);
        return JS_ThrowTypeError(ctx, "__dshPtyResize failed: %s", name ? name : "EIO");
    }
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ok", JS_TRUE);
    return r;
}

/* __dshPtyKill(pid, signalNameOrNumber) → {ok} | throws (the ESRCH contract
 * of process.kill, mirrored from the subprocess seam's kill face). Signal 0
 * probes existence without signalling. */
static JSValue js_pty_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t pid = 0, sig = SIGHUP; /* the node-pty default the vendored path assumes */
    if (argc < 1 || JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_ThrowTypeError(ctx, "__dshPtyKill needs (pid, signal)");
    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        sig = dsh_signal_num(ctx, argv[1]);
        if (sig < 0) return JS_ThrowTypeError(ctx, "__dshPtyKill: unknown signal");
    }
    if (kill((pid_t)pid, sig) != 0) {
        int e = errno;
        const char *name = dsh_errno_name(e);
        return JS_ThrowTypeError(ctx, "kill %d failed: %s", pid, name ? name : "EIO");
    }
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ok", JS_TRUE);
    return r;
}

/* The socket seam (D-d, 2026-09-30; contract v1.8.0, §4 "the socket seam").
 * Exactly ONE intrinsic lives here — the pump's poll (one non-blocking
 * accept/read pass per server/connection id), the same shape the
 * child-process and pty polls serve and the JS pump turns into the
 * data/close event sequence. EVERYTHING else is the contract's gateway
 * surface: socketListen/socketConnect (the two primitives) and the
 * connection face (socketWrite/socketEnd/socketClose) travel the gateway
 * call bridge, so the grant checks, the audit records and the `unavailable`
 * negotiation all stay where the contract puts them — with the embedder's
 * gateway dispatch. A host that serves none of it simply never sees a call. */
static JSValue js_socket_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "__dshSocketPoll needs an id");
    size_t n = 0;
    const char *id = JS_ToCStringLen(ctx, &n, argv[0]);
    if (!id) return JS_EXCEPTION;
    char err[DSH_ERR_MAX];
    char *json = dsh_socket_poll(id, err, sizeof(err));
    JS_FreeCString(ctx, id);
    if (json == NULL) return JS_ThrowTypeError(ctx, "__dshSocketPoll: %s", err);
    JSValue parsed = JS_ParseJSON(ctx, json, strlen(json), "<socket>");
    free(json);
    if (JS_IsException(parsed)) return JS_EXCEPTION;
    return parsed;
}

/* Shared spawn/spawnSync option parsing: command, args, cwd, env, stdio,
 * detached. modes[] holds DSH_PROC_EXTRA+3 dispositions (0 pipe / 1 ignore /
 * 2 inherit) — node's stdio array may name fds beyond 2 (the ptc control
 * channel rides fd 7). Returns 0 on shape failure with *err set. */
static int dsh_parse_spawn_opts(JSContext *ctx, JSValueConst opts, const char **command,
                                char ***argv, const char **cwd, char ***envp,
                                int modes[3 + DSH_PROC_EXTRA], int *detached, char **err) {
    *cwd = NULL; *detached = 0;
    for (int i = 0; i < 3 + DSH_PROC_EXTRA; i++) modes[i] = 0;
    JSValue cv = JS_GetPropertyStr(ctx, opts, "command");
    const char *c = JS_IsException(cv) ? NULL : JS_ToCString(ctx, cv);
    JS_FreeValue(ctx, cv);
    if (!c) { *err = "command missing"; return 0; }
    *command = js_strdup(ctx, c);
    JS_FreeCString(ctx, c);
    JSValue av = JS_GetPropertyStr(ctx, opts, "args");
    if (!dsh_build_str_array(ctx, av, NULL, argv, err)) { JS_FreeValue(ctx, av); return 0; }
    JS_FreeValue(ctx, av);
    JSValue cwdv = JS_GetPropertyStr(ctx, opts, "cwd");
    if (!JS_IsUndefined(cwdv) && !JS_IsNull(cwdv)) {
        const char *cd = JS_ToCString(ctx, cwdv);
        if (cd) { *cwd = js_strdup(ctx, cd); JS_FreeCString(ctx, cd); }
    }
    JS_FreeValue(ctx, cwdv);
    JSValue envv = JS_GetPropertyStr(ctx, opts, "env");
    if (!dsh_build_envp(ctx, envv, envp, err)) { JS_FreeValue(ctx, envv); return 0; }
    JS_FreeValue(ctx, envv);
    JSValue sv = JS_GetPropertyStr(ctx, opts, "stdio");
    if (JS_IsArray(sv)) {
        uint32_t slen = 3;
        JSValue lenv = JS_GetPropertyStr(ctx, sv, "length");
        if (!JS_IsException(lenv)) { JS_ToUint32(ctx, &slen, lenv); JS_FreeValue(ctx, lenv); }
        if (slen > 3 + DSH_PROC_EXTRA) slen = 3 + DSH_PROC_EXTRA; /* fds 3..7 max */
        for (uint32_t i = 0; i < slen; i++) {
            JSValue e = JS_GetPropertyUint32(ctx, sv, i);
            if (JS_IsString(e)) {
                const char *sm = JS_ToCString(ctx, e);
                modes[i] = dsh_stdio_mode(sm);
                JS_FreeCString(ctx, sm);
            }
            JS_FreeValue(ctx, e);
        }
    } else if (JS_IsString(sv)) {
        const char *sm = JS_ToCString(ctx, sv);
        int m = dsh_stdio_mode(sm);
        modes[0] = modes[1] = modes[2] = m;
        JS_FreeCString(ctx, sm);
    }
    JS_FreeValue(ctx, sv);
    JSValue dv = JS_GetPropertyStr(ctx, opts, "detached");
    if (!JS_IsUndefined(dv)) { int d = JS_ToBool(ctx, dv); *detached = d > 0; }
    JS_FreeValue(ctx, dv);
    return 1;
}

/* __dshProcSpawn({command,args,cwd,env,stdio,detached}) → {pid} |
 * {error:{code,errno}}. */
static JSValue js_proc_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcSpawn needs an options object");
    const char *command = NULL; char **cargv = NULL, **envp = NULL;
    const char *cwd = NULL; int modes[3 + DSH_PROC_EXTRA]; int detached = 0; char *err = NULL;
    if (!dsh_parse_spawn_opts(ctx, argv[0], &command, &cargv, &cwd, &envp, modes, &detached, &err)) {
        return JS_ThrowTypeError(ctx, "__dshProcSpawn: %s", err ? err : "bad options");
    }
    dsh_free_vec(ctx, cargv); /* parse built the unprefixed arg vec; re-build with the command prefix */
    JSValue argv_v = JS_GetPropertyStr(ctx, argv[0], "args");
    char **full_argv = NULL;
    int built = dsh_build_str_array(ctx, argv_v, command, &full_argv, &err);
    JS_FreeValue(ctx, argv_v);
    if (!built) {
        dsh_free_vec(ctx, envp);
        return JS_ThrowTypeError(ctx, "__dshProcSpawn: %s", err ? err : "bad args");
    }
    dsh_proc_remap_argv(s, s->rt, full_argv);
    int pin = -1, pout = -1, perr = -1, exec_errno = 0;
    int extras[DSH_PROC_EXTRA];
    pid_t pid = dsh_proc_fork_exec(ctx, command, full_argv, cwd, envp, modes, detached,
                                   &pin, &pout, &perr, extras, &exec_errno);
    JSValue res = JS_NewObject(ctx);
    if (pid < 0) {
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(exec_errno);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, exec_errno));
        JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, "spawn failed"));
        JS_SetPropertyStr(ctx, res, "error", e);
    } else {
        dsh_proc *p = NULL;
        for (int i = 0; i < DSH_PROC_MAX_SLOTS; i++) {
            if (!s->procs[i].used) { p = &s->procs[i]; break; }
        }
        if (!p) {
            kill(pid, SIGKILL);
            waitpid(pid, NULL, 0);
            dsh_close_all((int[]){pin, pout, perr}, 3);
            for (int i = 0; i < DSH_PROC_EXTRA; i++) if (extras[i] >= 0) close(extras[i]);
            dsh_free_vec(ctx, full_argv); dsh_free_vec(ctx, envp);
            return JS_ThrowTypeError(ctx, "__dshProcSpawn: process table full (%d)", DSH_PROC_MAX_SLOTS);
        }
        p->used = 1; p->pid = (int)pid;
        p->stdin_w = pin; p->stdout_r = pout; p->stderr_r = perr;
        for (int i = 0; i < DSH_PROC_EXTRA; i++) {
            p->extra_r[i] = extras[i];
            p->extra_eof[i] = extras[i] < 0;
        }
        p->out_eof = pout < 0; p->err_eof = perr < 0;
        p->reaped = 0; p->exit_code = 0; p->exit_sig = 0; p->detached = detached;
        JS_SetPropertyStr(ctx, res, "pid", JS_NewInt32(ctx, (int32_t)pid));
    }
    dsh_free_vec(ctx, full_argv);
    dsh_free_vec(ctx, envp);
    return res;
}

/* __dshProcSpawnSync({command,args,cwd,env,stdio,input(b64),timeoutMs}) →
 * node's spawnSync result face: {pid, status, signal, stdout, stderr} plus
 * {error} for a spawn failure (status null then — node's contract). Blocks
 * the runtime exactly like node blocks its event loop. */
static JSValue js_proc_spawn_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    dsh_spike_t *s = JS_GetContextOpaque(ctx);
    if (argc < 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "__dshProcSpawnSync needs an options object");
    const char *command = NULL; char **cargv = NULL, **envp = NULL;
    const char *cwd = NULL; int modes[3 + DSH_PROC_EXTRA]; int detached = 0; char *err = NULL;
    if (!dsh_parse_spawn_opts(ctx, argv[0], &command, &cargv, &cwd, &envp, modes, &detached, &err)) {
        return JS_ThrowTypeError(ctx, "__dshProcSpawnSync: %s", err ? err : "bad options");
    }
    dsh_free_vec(ctx, cargv);
    JSValue argv_v = JS_GetPropertyStr(ctx, argv[0], "args");
    char **full_argv = NULL;
    if (!dsh_build_str_array(ctx, argv_v, command, &full_argv, &err)) {
        JS_FreeValue(ctx, argv_v);
        dsh_free_vec(ctx, envp);
        return JS_ThrowTypeError(ctx, "__dshProcSpawnSync: %s", err ? err : "bad args");
    }
    JS_FreeValue(ctx, argv_v);
    /* input (b64) rides stdin; timeout in ms (0/absent = none) */
    unsigned char *input = NULL; size_t input_n = 0;
    JSValue iv = JS_GetPropertyStr(ctx, argv[0], "input");
    if (JS_IsString(iv)) {
        size_t blen = 0;
        const char *b64 = JS_ToCStringLen(ctx, &blen, iv);
        if (b64) input = dsh_b64_decode_bytes(ctx, b64, blen, &input_n);
        if (b64) JS_FreeCString(ctx, b64);
    }
    JS_FreeValue(ctx, iv);
    int32_t timeout_ms = 0;
    JSValue tv = JS_GetPropertyStr(ctx, argv[0], "timeoutMs");
    if (!JS_IsUndefined(tv)) JS_ToInt32(ctx, &timeout_ms, tv);
    JS_FreeValue(ctx, tv);

    dsh_proc_remap_argv(s, s->rt, full_argv);
    int pin = -1, pout = -1, perr = -1, exec_errno = 0;
    int extras[DSH_PROC_EXTRA];
    pid_t pid = dsh_proc_fork_exec(ctx, command, full_argv, cwd, envp, modes, detached,
                                   &pin, &pout, &perr, extras, &exec_errno);
    /* The sync face has no JS-visible extra channels: close them here. */
    for (int i = 0; i < DSH_PROC_EXTRA; i++) if (extras[i] >= 0) close(extras[i]);
    JSValue res = JS_NewObject(ctx);
    if (pid < 0) {
        JSValue e = JS_NewObject(ctx);
        const char *name = dsh_errno_name(exec_errno);
        JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, name ? name : "EIO"));
        JS_SetPropertyStr(ctx, e, "errno", JS_NewInt32(ctx, exec_errno));
        JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, "spawn failed"));
        JS_SetPropertyStr(ctx, res, "error", e);
        JS_SetPropertyStr(ctx, res, "status", JS_NULL);
        JS_SetPropertyStr(ctx, res, "signal", JS_NULL);
        JS_SetPropertyStr(ctx, res, "stdout", JS_NewString(ctx, ""));
        JS_SetPropertyStr(ctx, res, "stderr", JS_NewString(ctx, ""));
        JS_SetPropertyStr(ctx, res, "pid", JS_NULL);
        dsh_free_vec(ctx, full_argv); dsh_free_vec(ctx, envp);
        return res;
    }
    /* stdin: write input, then EOF */
    if (pin >= 0 && input && input_n > 0) {
        size_t written = 0;
        while (written < input_n) {
            ssize_t w = write(pin, input + written, input_n - written);
            if (w > 0) { written += (size_t)w; continue; }
            if (w < 0 && errno == EINTR) continue;
            break;
        }
    }
    if (pin >= 0) { close(pin); pin = -1; }
    /* drain both capture pipes to EOF (poll-driven so either order works) */
    unsigned char *outb = NULL, *errb = NULL;
    size_t on = 0, ocap = 0, en = 0, ecap = 0;
    int out_open = pout >= 0, err_open = perr >= 0;
    struct pollfd pfds[2];
    struct timespec t0;
    int timed_out = 0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    JSRuntime *rt = ctx ? JS_GetRuntime(ctx) : NULL;
    while (out_open || err_open) {
        int n = 0;
        if (out_open) { pfds[n].fd = pout; pfds[n].events = POLLIN; n++; }
        if (err_open) { pfds[n].fd = perr; pfds[n].events = POLLIN; n++; }
        int r = poll(pfds, (nfds_t)n, 200);
        if (r < 0 && errno != EINTR) break;
        size_t oi = 0, ei = 0;
        for (int i = 0; i < n; i++) {
            if (pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
                if (pfds[i].fd == pout) {
                    if (dsh_drain_fd(rt, pout, &outb, &on, &ocap)) { close(pout); pout = -1; out_open = 0; }
                } else if (pfds[i].fd == perr) {
                    if (dsh_drain_fd(rt, perr, &errb, &en, &ecap)) { close(perr); perr = -1; err_open = 0; }
                }
            }
            if (pfds[i].fd == pout) oi = 1; else ei = 1;
        }
        (void)oi; (void)ei;
        if (timeout_ms > 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            long long elapsed = (long long)(now.tv_sec - t0.tv_sec) * 1000 + (now.tv_nsec - t0.tv_nsec) / 1000000;
            if (elapsed >= timeout_ms) {
                timed_out = 1;
                kill(pid, SIGKILL);
                break;
            }
        }
    }
    if (pout >= 0) close(pout);
    if (perr >= 0) close(perr);
    int st = 0, status = -1, sig = 0;
    pid_t r = waitpid(pid, &st, 0);
    if (r == pid) {
        if (WIFEXITED(st)) { status = WEXITSTATUS(st); sig = 0; }
        else if (WIFSIGNALED(st)) { status = -1; sig = WTERMSIG(st); }
    }
    JSValue outv, errv;
    if (on > 0) { char *b64 = dsh_b64_encode_bytes(ctx, outb, on); outv = b64 ? JS_NewString(ctx, b64) : JS_NewString(ctx, ""); js_free(ctx, b64); }
    else outv = JS_NewString(ctx, "");
    if (en > 0) { char *b64 = dsh_b64_encode_bytes(ctx, errb, en); errv = b64 ? JS_NewString(ctx, b64) : JS_NewString(ctx, ""); js_free(ctx, b64); }
    else errv = JS_NewString(ctx, "");
    js_free_rt(rt, outb); js_free_rt(rt, errb);
    js_free(ctx, input);
    JS_SetPropertyStr(ctx, res, "pid", JS_NewInt32(ctx, (int32_t)pid));
    JS_SetPropertyStr(ctx, res, "status", (status >= 0 && sig == 0) ? JS_NewInt32(ctx, status) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "signal", sig != 0 ? JS_NewInt32(ctx, sig) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "timedOut", JS_NewBool(ctx, timed_out));
    JS_SetPropertyStr(ctx, res, "stdout", outv);
    JS_SetPropertyStr(ctx, res, "stderr", errv);
    dsh_free_vec(ctx, full_argv);
    dsh_free_vec(ctx, envp);
    return res;
}

/* __dshProcFacts(): {nodePath (PATH search, NULL absent), execPath (the
 * running CLI, best effort), path ($PATH)}. The suite leg pins
 * process.execPath to nodePath when present: the upstream contract spawns
 * `process.execPath fixture.ts` expecting node's erasable-TS support. */
static JSValue js_proc_facts(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    dsh_spike_t *s = JS_GetContextOpaque(ctx); /* bundleRoot source */
    static char node_path[4096];
    if (node_path[0] == 0) {
        const char *path = getenv("PATH");
        if (path) {
            const char *at = path;
            while (*at) {
                const char *colon = strchr(at, ':');
                size_t dlen = colon ? (size_t)(colon - at) : strlen(at);
                if (dlen > 0 && dlen + 6 < sizeof(node_path)) {
                    snprintf(node_path, sizeof(node_path), "%.*s/node", (int)dlen, at);
                    if (access(node_path, X_OK) == 0) break;
                    node_path[0] = 0;
                }
                if (!colon) break;
                at = colon + 1;
            }
        }
    }
    char self_path[4096]; self_path[0] = 0;
#ifdef __linux__
    ssize_t n = readlink("/proc/self/exe", self_path, sizeof(self_path) - 1);
    if (n > 0) self_path[n] = 0;
#elif defined(__APPLE__)
    uint32_t sz = sizeof(self_path);
    if (_NSGetExecutablePath(self_path, &sz) != 0) self_path[0] = 0;
#endif
    JSValue res = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, res, "nodePath", node_path[0] ? JS_NewString(ctx, node_path) : JS_NULL);
    JS_SetPropertyStr(ctx, res, "execPath", self_path[0] ? JS_NewString(ctx, self_path) : JS_NULL);
    const char *path = getenv("PATH");
    JS_SetPropertyStr(ctx, res, "path", path ? JS_NewString(ctx, path) : JS_NULL);
    /* bundleRoot (W6-U): the REAL absolute path the loader's bundle-relative
     * specifier space is rooted at. The flat transpiled specs re-derive
     * vendored-tree file paths through it (the __dshFlatPathMap builder in
     * the suite leg) — the same re-rooting dsh_proc_remap_argv does for
     * child argv, exposed where JS needs to compute a REAL path. */
    const char *root = dsh_bundle_root_real(s);
    JS_SetPropertyStr(ctx, res, "bundleRoot", root[0] ? JS_NewString(ctx, root) : JS_NULL);
    return res;
}

/* ---- node:sqlite seam (W5-R, 2026-09-28) --------------------------------- *
 * The session-query/storage families drive node's DatabaseSync over real
 * database files (the profile container is a real directory on the desktop).
 * The sqlite3 engine is ALREADY linked (the iSH userland depends on it), so
 * the seam is a thin registry: JS opens/prepares through intrinsics, rows
 * cross as plain objects. Values bind as null/number/string/blob; reads
 * return null/number/string/Uint8Array — the node:sqlite defaults the
 * vendored schemas rely on.
 *
 * Guard: only hosts that LINK a real sqlite3 (the CLI's iSH userland, iOS's
 * system lib) define DSH_WITH_SQLITE and get this seam; the android/harmony
 * builds compile the whole block out and the JS shim degrades to its
 * absent-seam error — capability-honest, per the contract's additive rule. */
#if defined(DSH_WITH_SQLITE)
#include <sqlite3.h>

#define DSH_SQLITE_MAX_DB 16
#define DSH_SQLITE_MAX_STMT 128
static sqlite3 *dsh_sqlite_dbs[DSH_SQLITE_MAX_DB];
static sqlite3_stmt *dsh_sqlite_stmts[DSH_SQLITE_MAX_STMT];

/* Prepared statements are owned by their JS StatementSync object through a
 * class finalizer — node has no StatementSync.close(), it GC-finalizes, and
 * the vendored session-search engine prepares ad-hoc statements per query
 * (W6-V, 2026-09-28: with nothing releasing them the 128-slot table
 * exhausted mid-suite, "statement table full (128)"). The indirection cell
 * lets a db-wide close (which finalizes every statement of that db) detach
 * live JS objects safely: their finalizer later sees stmt == NULL. */
typedef struct DshSqliteStmtCell {
    sqlite3_stmt *stmt; /* NULL once ownership moved elsewhere */
    int slot;           /* table index while live, -1 when detached */
} DshSqliteStmtCell;
static DshSqliteStmtCell *dsh_sqlite_stmt_cells[DSH_SQLITE_MAX_STMT];
static JSClassID dsh_sqlite_stmt_class_id;

/* Database handles ride the same pattern: node closes a DatabaseSync on GC
 * too, and the corpus's engines rely on it when a test fails before dispose
 * (W6-V, 2026-09-28: 16 fixed slots exhausted mid-suite on unclosed dbs).
 * The GC close finalizes every surviving statement of the db first, so the
 * detached statement cells never see a freed db. */
typedef struct DshSqliteDbCell {
    sqlite3 *db; /* NULL once ownership moved to an explicit close */
    int slot;
    int enforce_mode; /* created here: node's 0600 default applies to sidecars too */
    char *path;       /* strdup'd at open (sidecar mode enforcement) */
} DshSqliteDbCell;
static DshSqliteDbCell *dsh_sqlite_db_cells[DSH_SQLITE_MAX_DB];
static JSClassID dsh_sqlite_db_class_id;

static void dsh_sqlite_stmt_finalizer(JSRuntime *rt, JSValueConst val);

/* node:sqlite is built with SQLITE_DEFAULT_FILE_PERMISSIONS=0600, so the
 * main db AND its -wal/-journal sidecars carry owner-only bits (the vendored
 * schema tests assert the sidecar modes). This sqlite is the system library
 * (0644 compile default, no knob), so the enforcement runs at open — and
 * after every write, because sidecars materialize lazily. Only dbs we
 * created are enforced; reopening a caller-owned medium never rewrites the
 * caller's own chmods (W6-V, 2026-09-28). */
static void dsh_sqlite_enforce_mode(DshSqliteDbCell *cell) {
    if (!cell || !cell->enforce_mode || !cell->path) return;
    static const char *const suffixes[] = { "", "-wal", "-journal", "-shm" };
    for (int i = 0; i < 4; i++) {
        size_t n = strlen(cell->path) + strlen(suffixes[i]) + 1;
        char full[1024];
        if (n > sizeof(full)) continue;
        snprintf(full, n, "%s%s", cell->path, suffixes[i]);
        struct stat st;
        if (stat(full, &st) == 0 && (st.st_mode & 0777) != 0600) {
            (void)chmod(full, 0600);
        }
    }
}

static void dsh_sqlite_db_finalizer(JSRuntime *rt, JSValueConst val) {
    (void)rt;
    DshSqliteDbCell *cell = (DshSqliteDbCell *)JS_GetOpaque(val, dsh_sqlite_db_class_id);
    if (!cell) return;
    if (cell->db) {
        for (int i = 0; i < DSH_SQLITE_MAX_STMT; i++) {
            if (dsh_sqlite_stmts[i] && sqlite3_db_handle(dsh_sqlite_stmts[i]) == cell->db) {
                sqlite3_finalize(dsh_sqlite_stmts[i]);
                DshSqliteStmtCell *stmt_cell = dsh_sqlite_stmt_cells[i];
                if (stmt_cell) {
                    stmt_cell->stmt = NULL;
                    stmt_cell->slot = -1;
                }
                dsh_sqlite_stmts[i] = NULL;
                dsh_sqlite_stmt_cells[i] = NULL;
            }
        }
        if (cell->slot >= 0 && cell->slot < DSH_SQLITE_MAX_DB
            && dsh_sqlite_dbs[cell->slot] == cell->db) {
            dsh_sqlite_dbs[cell->slot] = NULL;
        }
        sqlite3_close_v2(cell->db);
        cell->db = NULL;
    }
    free(cell->path);
    cell->path = NULL;
    cell->slot = -1;
    free(cell);
}

static void dsh_sqlite_register_classes(JSContext *ctx) {
    static int registered = 0;
    if (registered) return;
    JSClassDef stmt_def = { "SQLiteStmtHandle", dsh_sqlite_stmt_finalizer, NULL, NULL, NULL };
    JSClassDef db_def = { "SQLiteDatabaseHandle", dsh_sqlite_db_finalizer, NULL, NULL, NULL };
    /* JS_NewClassID RETURNS the new id (0 on error); JS_NewClass returns 0 ok. */
    JSClassID id = JS_NewClassID(JS_GetRuntime(ctx), &dsh_sqlite_stmt_class_id);
    JSClassID db_id = JS_NewClassID(JS_GetRuntime(ctx), &dsh_sqlite_db_class_id);
    if (id != 0 && db_id != 0
        && JS_NewClass(JS_GetRuntime(ctx), dsh_sqlite_stmt_class_id, &stmt_def) == 0
        && JS_NewClass(JS_GetRuntime(ctx), dsh_sqlite_db_class_id, &db_def) == 0) {
        registered = 1;
    }
}

static void dsh_sqlite_stmt_finalizer(JSRuntime *rt, JSValueConst val) {
    (void)rt;
    DshSqliteStmtCell *cell = (DshSqliteStmtCell *)JS_GetOpaque(val, dsh_sqlite_stmt_class_id);
    if (!cell) return;
    if (cell->stmt) {
        if (cell->slot >= 0 && cell->slot < DSH_SQLITE_MAX_STMT
            && dsh_sqlite_stmts[cell->slot] == cell->stmt) {
            dsh_sqlite_stmts[cell->slot] = NULL;
            dsh_sqlite_stmt_cells[cell->slot] = NULL;
        }
        sqlite3_finalize(cell->stmt);
        cell->stmt = NULL;
    }
    cell->slot = -1;
    free(cell);
}

static sqlite3 *dsh_sqlite_db(JSContext *ctx, JSValueConst v) {
    DshSqliteDbCell *cell = (DshSqliteDbCell *)JS_GetOpaque(v, dsh_sqlite_db_class_id);
    return cell ? cell->db : NULL;
}
static sqlite3_stmt *dsh_sqlite_stmt(JSContext *ctx, JSValueConst v) {
    DshSqliteStmtCell *cell = (DshSqliteStmtCell *)JS_GetOpaque(v, dsh_sqlite_stmt_class_id);
    return cell ? cell->stmt : NULL;
}
static DshSqliteDbCell *dsh_sqlite_db_cell(JSContext *ctx, JSValueConst v) {
    return (DshSqliteDbCell *)JS_GetOpaque(v, dsh_sqlite_db_class_id);
}
/* JS error from the engine's own message; resets the statement so the next
 * use starts clean. */
static JSValue dsh_sqlite_err(JSContext *ctx, sqlite3 *db, const char *what) {
    return JS_ThrowInternalError(ctx, "node:sqlite: %s: %s", what, db ? sqlite3_errmsg(db) : "invalid handle");
}
/* Bind one JS value at sqlite position idx (1-based). 0 ok, -1 unsupported,
 * propagates nothing (callers surface via errmsg). */
static int dsh_sqlite_bind_one(JSContext *ctx, sqlite3_stmt *stmt, int idx, JSValueConst v) {
    if (JS_IsNull(v) || JS_IsUndefined(v)) return sqlite3_bind_null(stmt, idx);
    if (JS_IsBool(v)) {
        int b = JS_ToBool(ctx, v);
        return sqlite3_bind_int(stmt, idx, b > 0 ? 1 : 0);
    }
    if (JS_IsNumber(v)) {
        double d = 0;
        if (JS_ToFloat64(ctx, &d, v) < 0) return -1;
        if (d == (double)(int64_t)d) return sqlite3_bind_int64(stmt, idx, (sqlite3_int64)d);
        return sqlite3_bind_double(stmt, idx, d);
    }
    if (JS_IsString(v)) {
        const char *text = JS_ToCString(ctx, v);
        if (!text) return -1;
        int r = sqlite3_bind_text(stmt, idx, text, -1, SQLITE_TRANSIENT);
        JS_FreeCString(ctx, text);
        return r;
    }
    size_t size = 0;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, NULL, &size, NULL);
    if (!JS_IsException(ab)) {
        size_t len = 0;
        uint8_t *bytes = JS_GetArrayBuffer(ctx, &len, ab);
        JS_FreeValue(ctx, ab);
        if (bytes) return sqlite3_bind_blob(stmt, idx, bytes, (int)len, SQLITE_TRANSIENT);
    }
    JS_FreeValue(ctx, ab);
    return -1; /* unsupported value class */
}
/* Bind a params face: undefined/null = none; array = positional from 1;
 * object = named (':k', then '@k', then '$k' — node's named-parameter
 * spellings). Returns 0 or the failing sqlite rc. */
static int dsh_sqlite_bind_params(JSContext *ctx, sqlite3_stmt *stmt, JSValueConst params) {
    if (JS_IsUndefined(params) || JS_IsNull(params)) return 0;
    if (JS_IsArray(params)) {
        JSValue lenv = JS_GetPropertyStr(ctx, params, "length");
        uint32_t len = 0;
        JS_ToUint32(ctx, &len, lenv);
        JS_FreeValue(ctx, lenv);
        for (uint32_t i = 0; i < len; i++) {
            JSValue v = JS_GetPropertyUint32(ctx, params, i);
            int r = dsh_sqlite_bind_one(ctx, stmt, (int)i + 1, v);
            JS_FreeValue(ctx, v);
            if (r < 0) return SQLITE_MISMATCH;
            if (r != SQLITE_OK) return r;
        }
        return 0;
    }
    if (JS_IsObject(params)) {
        JSPropertyEnum *tab = NULL;
        uint32_t len = 0;
        if (JS_GetOwnPropertyNames(ctx, &tab, &len, params, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) return SQLITE_MISMATCH;
        int rc = 0;
        for (uint32_t i = 0; i < len && rc == 0; i++) {
            const char *k = JS_AtomToCString(ctx, tab[i].atom);
            JSValue v = JS_GetProperty(ctx, params, tab[i].atom);
            if (k) {
                const char *prefixes[3] = { ":", "@", "$" };
                for (int pi = 0; pi < 3 && rc == 0; pi++) {
                    char named[512];
                    snprintf(named, sizeof(named), "%s%s", prefixes[pi], k);
                    int idx = sqlite3_bind_parameter_index(stmt, named);
                    if (idx > 0) {
                        int r = dsh_sqlite_bind_one(ctx, stmt, idx, v);
                        if (r < 0) rc = SQLITE_MISMATCH; else if (r != SQLITE_OK) rc = r;
                        break;
                    }
                }
            }
            JS_FreeCString(ctx, k);
            JS_FreeValue(ctx, v);
            JS_FreeAtom(ctx, tab[i].atom);
        }
        js_free(ctx, tab);
        return rc;
    }
    return SQLITE_MISMATCH;
}
/* One row → object keyed by column name (later duplicates: last wins,
 * node's shape). */
static JSValue dsh_sqlite_row(JSContext *ctx, sqlite3_stmt *stmt) {
    int cols = sqlite3_column_count(stmt);
    JSValue row = JS_NewObject(ctx);
    for (int c = 0; c < cols; c++) {
        const char *name = sqlite3_column_name(stmt, c);
        JSValue v;
        switch (sqlite3_column_type(stmt, c)) {
        case SQLITE_INTEGER: v = JS_NewInt64(ctx, sqlite3_column_int64(stmt, c)); break;
        case SQLITE_FLOAT: v = JS_NewFloat64(ctx, sqlite3_column_double(stmt, c)); break;
        case SQLITE_TEXT: {
            const unsigned char *text = sqlite3_column_text(stmt, c);
            v = JS_NewString(ctx, text ? (const char *)text : "");
            break;
        }
        case SQLITE_BLOB: {
            const void *blob = sqlite3_column_blob(stmt, c);
            int n = sqlite3_column_bytes(stmt, c);
            v = JS_NewUint8ArrayCopy(ctx, blob ? (const uint8_t *)blob : (const uint8_t *)"", n > 0 ? (size_t)n : 0);
            break;
        }
        default: v = JS_NULL; break;
        }
        JS_SetPropertyStr(ctx, row, name ? name : "?", v);
    }
    return row;
}
static int dsh_sqlite_bind_and_step(JSContext *ctx, sqlite3_stmt *stmt, JSValueConst params) {
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    int rc = dsh_sqlite_bind_params(ctx, stmt, params);
    if (rc != 0) { sqlite3_reset(stmt); return rc; }
    return sqlite3_step(stmt);
}

static JSValue js_sqlite_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) return JS_ThrowTypeError(ctx, "__dshSqliteOpen needs a path");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    sqlite3 *db = NULL;
    /* node:sqlite creates database files 0o600 (its documented default) —
     * the vendored schema tests assert the mode, and the -wal/-journal
     * sidecars inherit it from the main db (W6-V, 2026-09-28). sqlite takes
     * the mode from a compile-time default (no open-time knob — the 4th
     * open_v2 argument is the VFS name), so chmod on CREATION only: reopening
     * an existing medium must not override the caller's own chmods. */
    /* The vendored openDatabase pre-creates an EMPTY file ('wx', mode 0600)
     * through the fs seam — an existing-but-empty medium is the created case
     * (node: sqlite then keeps the file's 0600 and the sidecars inherit it). */
    int created = access(path, F_OK) != 0;
    if (!created) {
        struct stat st;
        if (stat(path, &st) == 0 && st.st_size == 0) created = 1;
    }
    int rc = sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
    if (rc == SQLITE_OK && created) (void)chmod(path, 0600);
    JS_FreeCString(ctx, path);
    if (rc != SQLITE_OK) {
        JSValue err = dsh_sqlite_err(ctx, db, "open");
        if (db) sqlite3_close(db);
        return err;
    }
    sqlite3_extended_result_codes(db, 1);
    dsh_sqlite_register_classes(ctx);
    for (int i = 0; i < DSH_SQLITE_MAX_DB; i++) {
        if (dsh_sqlite_dbs[i] == NULL) {
            DshSqliteDbCell *cell = (DshSqliteDbCell *)malloc(sizeof(*cell));
            if (!cell) {
                dsh_sqlite_dbs[i] = NULL;
                sqlite3_close(db);
                return JS_ThrowOutOfMemory(ctx);
            }
            cell->db = db;
            cell->slot = i;
            cell->enforce_mode = created;
            cell->path = created ? strdup(path) : NULL;
            dsh_sqlite_dbs[i] = db;
            dsh_sqlite_db_cells[i] = cell;
            dsh_sqlite_enforce_mode(cell);
            JSValue obj = JS_NewObjectClass(ctx, dsh_sqlite_db_class_id);
            if (JS_IsException(obj)) {
                dsh_sqlite_dbs[i] = NULL;
                dsh_sqlite_db_cells[i] = NULL;
                free(cell->path);
                free(cell);
                sqlite3_close(db);
                return obj;
            }
            JS_SetOpaque(obj, cell);
            JSValue res = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, res, "handle", obj);
            return res;
        }
    }
    /* No free slot: the live JS DatabaseSync objects may be garbage already —
     * their native sqlite3 allocations put no pressure on the JS GC, so a
     * collection pass is what releases them (node behaves equivalently by
     * finalizing on GC). One pass, then re-scan; still-full is a real leak. */
    JS_RunGC(JS_GetRuntime(ctx));
    for (int i = 0; i < DSH_SQLITE_MAX_DB; i++) {
        if (dsh_sqlite_dbs[i] == NULL) {
            DshSqliteDbCell *cell = (DshSqliteDbCell *)malloc(sizeof(*cell));
            if (!cell) {
                dsh_sqlite_dbs[i] = NULL;
                sqlite3_close(db);
                return JS_ThrowOutOfMemory(ctx);
            }
            cell->db = db;
            cell->slot = i;
            cell->enforce_mode = created;
            cell->path = created ? strdup(path) : NULL;
            dsh_sqlite_dbs[i] = db;
            dsh_sqlite_db_cells[i] = cell;
            dsh_sqlite_enforce_mode(cell);
            JSValue obj = JS_NewObjectClass(ctx, dsh_sqlite_db_class_id);
            if (JS_IsException(obj)) {
                dsh_sqlite_dbs[i] = NULL;
                dsh_sqlite_db_cells[i] = NULL;
                free(cell->path);
                free(cell);
                sqlite3_close(db);
                return obj;
            }
            JS_SetOpaque(obj, cell);
            JSValue res = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, res, "handle", obj);
            return res;
        }
    }
    sqlite3_close(db);
    return JS_ThrowInternalError(ctx, "node:sqlite: database table full (%d)", DSH_SQLITE_MAX_DB);
}

static JSValue js_sqlite_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3 *db = dsh_sqlite_db(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!db) return JS_ThrowTypeError(ctx, "__dshSqliteClose: unknown handle");
    for (int i = 0; i < DSH_SQLITE_MAX_STMT; i++) {
        if (dsh_sqlite_stmts[i] && sqlite3_db_handle(dsh_sqlite_stmts[i]) == db) {
            sqlite3_finalize(dsh_sqlite_stmts[i]);
            DshSqliteStmtCell *cell = dsh_sqlite_stmt_cells[i];
            if (cell) {
                /* Detach the still-live JS object: its finalizer only frees. */
                cell->stmt = NULL;
                cell->slot = -1;
            }
            dsh_sqlite_stmts[i] = NULL;
            dsh_sqlite_stmt_cells[i] = NULL;
        }
    }
    for (int i = 0; i < DSH_SQLITE_MAX_DB; i++) {
        if (dsh_sqlite_dbs[i] == db) {
            DshSqliteDbCell *cell = dsh_sqlite_db_cells[i];
            if (cell) {
                /* Detach the still-live JS object: its finalizer only frees. */
                cell->db = NULL;
                cell->slot = -1;
                free(cell->path);
                cell->path = NULL;
                cell->enforce_mode = 0;
            }
            dsh_sqlite_dbs[i] = NULL;
            dsh_sqlite_db_cells[i] = NULL;
        }
    }
    sqlite3_close(db);
    return JS_NewObject(ctx); /* {} — node returns void; cheap shape */
}

static JSValue js_sqlite_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3 *db = dsh_sqlite_db(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!db) return JS_ThrowTypeError(ctx, "__dshSqliteExec: unknown handle");
    const char *sql = argc > 1 && JS_IsString(argv[1]) ? JS_ToCString(ctx, argv[1]) : NULL;
    if (!sql) return JS_ThrowTypeError(ctx, "__dshSqliteExec needs sql");
    char *errmsg = NULL;
    int rc = sqlite3_exec(db, sql, NULL, NULL, &errmsg);
    JS_FreeCString(ctx, sql);
    if (rc != SQLITE_OK) {
        JSValue err = JS_ThrowInternalError(ctx, "node:sqlite: exec: %s", errmsg ? errmsg : sqlite3_errmsg(db));
        if (errmsg) sqlite3_free(errmsg);
        return err;
    }
    dsh_sqlite_enforce_mode(dsh_sqlite_db_cell(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    return JS_NewObject(ctx);
}


static JSValue js_sqlite_prepare(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3 *db = dsh_sqlite_db(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!db) return JS_ThrowTypeError(ctx, "__dshSqlitePrepare: unknown handle");
    const char *sql = argc > 1 && JS_IsString(argv[1]) ? JS_ToCString(ctx, argv[1]) : NULL;
    if (!sql) return JS_ThrowTypeError(ctx, "__dshSqlitePrepare needs sql");
    sqlite3_stmt *stmt = NULL;
    int rc = sqlite3_prepare_v2(db, sql, -1, &stmt, NULL);
    JS_FreeCString(ctx, sql);
    if (rc != SQLITE_OK || stmt == NULL) {
        return dsh_sqlite_err(ctx, db, "prepare");
    }
    dsh_sqlite_register_classes(ctx);
    for (int i = 0; i < DSH_SQLITE_MAX_STMT; i++) {
        if (dsh_sqlite_stmts[i] == NULL) {
            DshSqliteStmtCell *cell = (DshSqliteStmtCell *)malloc(sizeof(*cell));
            if (!cell) {
                sqlite3_finalize(stmt);
                return JS_ThrowOutOfMemory(ctx);
            }
            cell->stmt = stmt;
            cell->slot = i;
            dsh_sqlite_stmts[i] = stmt;
            dsh_sqlite_stmt_cells[i] = cell;
            JSValue obj = JS_NewObjectClass(ctx, dsh_sqlite_stmt_class_id);
            if (JS_IsException(obj)) {
                dsh_sqlite_stmts[i] = NULL;
                dsh_sqlite_stmt_cells[i] = NULL;
                sqlite3_finalize(stmt);
                free(cell);
                return obj;
            }
            JS_SetOpaque(obj, cell);
            JSValue res = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, res, "stmt", obj);
            return res;
        }
    }
    /* Same collect-and-retry as open: statements are GC-owned objects. */
    JS_RunGC(JS_GetRuntime(ctx));
    for (int i = 0; i < DSH_SQLITE_MAX_STMT; i++) {
        if (dsh_sqlite_stmts[i] == NULL) {
            DshSqliteStmtCell *cell = (DshSqliteStmtCell *)malloc(sizeof(*cell));
            if (!cell) {
                sqlite3_finalize(stmt);
                return JS_ThrowOutOfMemory(ctx);
            }
            cell->stmt = stmt;
            cell->slot = i;
            dsh_sqlite_stmts[i] = stmt;
            dsh_sqlite_stmt_cells[i] = cell;
            JSValue obj = JS_NewObjectClass(ctx, dsh_sqlite_stmt_class_id);
            if (JS_IsException(obj)) {
                dsh_sqlite_stmts[i] = NULL;
                dsh_sqlite_stmt_cells[i] = NULL;
                sqlite3_finalize(stmt);
                free(cell);
                return obj;
            }
            JS_SetOpaque(obj, cell);
            JSValue res = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, res, "stmt", obj);
            return res;
        }
    }
    sqlite3_finalize(stmt);
    return JS_ThrowInternalError(ctx, "node:sqlite: statement table full (%d)", DSH_SQLITE_MAX_STMT);
}

static JSValue js_sqlite_run(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3_stmt *stmt = dsh_sqlite_stmt(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!stmt) return JS_ThrowTypeError(ctx, "__dshSqliteRun: unknown stmt");
    sqlite3 *db = sqlite3_db_handle(stmt);
    int rc = dsh_sqlite_bind_and_step(ctx, stmt, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
        sqlite3_reset(stmt);
        return dsh_sqlite_err(ctx, db, "run");
    }
    sqlite3_reset(stmt);
    dsh_sqlite_enforce_mode(dsh_sqlite_db_cell(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    JSValue res = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, res, "changes", JS_NewInt64(ctx, sqlite3_changes64(db)));
    JS_SetPropertyStr(ctx, res, "lastInsertRowid", JS_NewInt64(ctx, sqlite3_last_insert_rowid(db)));
    return res;
}

static JSValue js_sqlite_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3_stmt *stmt = dsh_sqlite_stmt(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!stmt) return JS_ThrowTypeError(ctx, "__dshSqliteGet: unknown stmt");
    sqlite3 *db = sqlite3_db_handle(stmt);
    int rc = dsh_sqlite_bind_and_step(ctx, stmt, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (rc == SQLITE_ROW) {
        JSValue row = dsh_sqlite_row(ctx, stmt);
        sqlite3_reset(stmt);
        return row;
    }
    sqlite3_reset(stmt);
    if (rc == SQLITE_DONE) return JS_NULL;
    return dsh_sqlite_err(ctx, db, "get");
}

static JSValue js_sqlite_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    sqlite3_stmt *stmt = dsh_sqlite_stmt(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!stmt) return JS_ThrowTypeError(ctx, "__dshSqliteAll: unknown stmt");
    sqlite3 *db = sqlite3_db_handle(stmt);
    JSValue rows = JS_NewArray(ctx);
    uint32_t n = 0;
    /* Bind ONCE, then step to exhaustion: re-binding inside the loop resets
     * the statement and restarts the query, so every iteration re-yielded
     * row 1 and the drain never reached SQLITE_DONE (W6-V, 2026-09-28: the
     * session-query search walk hung forever on the first result set). */
    int rc = dsh_sqlite_bind_and_step(ctx, stmt, argc > 1 ? argv[1] : JS_UNDEFINED);
    while (rc == SQLITE_ROW) {
        JS_SetPropertyUint32(ctx, rows, n++, dsh_sqlite_row(ctx, stmt));
        rc = sqlite3_step(stmt);
    }
    sqlite3_reset(stmt);
    if (rc != SQLITE_DONE) {
        return dsh_sqlite_err(ctx, db, "all");
    }
    return rows;
}
#endif /* DSH_WITH_SQLITE */

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
    JS_SetPropertyStr(ctx, global, "__dshPerfProbe",
                      JS_NewCFunction(ctx, js_perf_probe, "__dshPerfProbe", 1));
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
    JS_SetPropertyStr(ctx, global, "__zstdCompressB64",
                      JS_NewCFunction(ctx, js_zstd_compress_b64, "__zstdCompressB64", 2));
    JS_SetPropertyStr(ctx, global, "__zstdDecompressB64",
                      JS_NewCFunction(ctx, js_zstd_decompress_b64, "__zstdDecompressB64", 2));
    /* The subprocess seam (see the section comment above): the
     * node:child_process shim drives REAL children through these calls —
     * spawn/spawnSync plus the per-child pump (poll/write/endStdin/kill)
     * and the facts probe (node path for process.execPath). */
    JS_SetPropertyStr(ctx, global, "__dshProcSpawn",
                      JS_NewCFunction(ctx, js_proc_spawn, "__dshProcSpawn", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcSpawnSync",
                      JS_NewCFunction(ctx, js_proc_spawn_sync, "__dshProcSpawnSync", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcPoll",
                      JS_NewCFunction(ctx, js_proc_poll, "__dshProcPoll", 1));
#if defined(DSH_WITH_SQLITE)
    JS_SetPropertyStr(ctx, global, "__dshSqliteOpen",
                      JS_NewCFunction(ctx, js_sqlite_open, "__dshSqliteOpen", 1));
    JS_SetPropertyStr(ctx, global, "__dshSqliteClose",
                      JS_NewCFunction(ctx, js_sqlite_close, "__dshSqliteClose", 1));
    JS_SetPropertyStr(ctx, global, "__dshSqliteExec",
                      JS_NewCFunction(ctx, js_sqlite_exec, "__dshSqliteExec", 2));
    JS_SetPropertyStr(ctx, global, "__dshSqlitePrepare",
                      JS_NewCFunction(ctx, js_sqlite_prepare, "__dshSqlitePrepare", 2));
    JS_SetPropertyStr(ctx, global, "__dshSqliteRun",
                      JS_NewCFunction(ctx, js_sqlite_run, "__dshSqliteRun", 2));
    JS_SetPropertyStr(ctx, global, "__dshSqliteGet",
                      JS_NewCFunction(ctx, js_sqlite_get, "__dshSqliteGet", 2));
    JS_SetPropertyStr(ctx, global, "__dshSqliteAll",
                      JS_NewCFunction(ctx, js_sqlite_all, "__dshSqliteAll", 2));
#endif
    JS_SetPropertyStr(ctx, global, "__dshProcReadReal",
                      JS_NewCFunction(ctx, js_proc_read_real, "__dshProcReadReal", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcMkdirReal",
                      JS_NewCFunction(ctx, js_proc_mkdir_real, "__dshProcMkdirReal", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcWriteFileReal",
                      JS_NewCFunction(ctx, js_proc_write_file_real, "__dshProcWriteFileReal", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcRmReal",
                      JS_NewCFunction(ctx, js_proc_rm_real, "__dshProcRmReal", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcStatReal",
                      JS_NewCFunction(ctx, js_proc_stat_real, "__dshProcStatReal", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcAccessReal",
                      JS_NewCFunction(ctx, js_proc_access_real, "__dshProcAccessReal", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcChmodReal",
                      JS_NewCFunction(ctx, js_proc_chmod_real, "__dshProcChmodReal", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcWrite",
                      JS_NewCFunction(ctx, js_proc_write, "__dshProcWrite", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcEndStdin",
                      JS_NewCFunction(ctx, js_proc_end_stdin, "__dshProcEndStdin", 1));
    JS_SetPropertyStr(ctx, global, "__dshProcWriteFd",
                      JS_NewCFunction(ctx, js_proc_write_fd, "__dshProcWriteFd", 3));
    JS_SetPropertyStr(ctx, global, "__dshProcEndFd",
                      JS_NewCFunction(ctx, js_proc_end_fd, "__dshProcEndFd", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcKill",
                      JS_NewCFunction(ctx, js_proc_kill, "__dshProcKill", 2));
    JS_SetPropertyStr(ctx, global, "__dshProcFacts",
                      JS_NewCFunction(ctx, js_proc_facts, "__dshProcFacts", 0));
    /* The forkpty seam (see the section comment above): the node-pty shim
     * drives REAL terminal children through these calls — spawn plus the
     * per-terminal pump (poll/write/resize/kill), the pty.event face the
     * D-b decision froze the shape of. */
    JS_SetPropertyStr(ctx, global, "__dshPtySpawn",
                      JS_NewCFunction(ctx, js_pty_spawn, "__dshPtySpawn", 1));
    JS_SetPropertyStr(ctx, global, "__dshPtyPoll",
                      JS_NewCFunction(ctx, js_pty_poll, "__dshPtyPoll", 1));
    JS_SetPropertyStr(ctx, global, "__dshPtyWrite",
                      JS_NewCFunction(ctx, js_pty_write, "__dshPtyWrite", 2));
    JS_SetPropertyStr(ctx, global, "__dshPtyResize",
                      JS_NewCFunction(ctx, js_pty_resize, "__dshPtyResize", 3));
    JS_SetPropertyStr(ctx, global, "__dshPtyKill",
                      JS_NewCFunction(ctx, js_pty_kill, "__dshPtyKill", 2));
    /* The socket seam's pump face (see the section comment above): the ONE
     * intrinsic — the poll the JS socket shim drives every few ms. The
     * contract primitives (socketListen/socketConnect) and the connection
     * face (socketWrite/socketEnd/socketClose) travel the gateway-call
     * bridge like every primitive. */
    JS_SetPropertyStr(ctx, global, "__dshSocketPoll",
                      JS_NewCFunction(ctx, js_socket_poll, "__dshSocketPoll", 1));
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
    /* The upstream suite's continuation chains recurse deeper than
     * quickjs-ng's default evaluation stack (measured 2026-09-23:
     * "Maximum call stack size exceeded" on agent-initiator/scope-lifecycle
     * tests Node runs in its ~1 MB default). 8 MB ≈ Node's --stack-size
     * headroom; the mobile hosts raise the same knob. */
    JS_SetMaxStackSize(s->rt, 400 * 1024 * 1024);
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
    /* Subprocess teardown before the runtime goes: SIGKILL every still-tracked
     * attached child (a run must not leak awaited children), reap, close all
     * pipe ends. Detached group leaders (node's detached:true — the
     * launchDetachedApp face) survive the spike on purpose. */
    for (int i = 0; i < DSH_PROC_MAX_SLOTS; i++) {
        dsh_proc *p = &s->procs[i];
        if (!p->used) continue;
        if (!p->detached && !p->reaped) {
            kill((pid_t)p->pid, SIGKILL);
            waitpid((pid_t)p->pid, NULL, 0);
            p->reaped = 1;
        }
        if (p->stdin_w >= 0) close(p->stdin_w);
        if (p->stdout_r >= 0) close(p->stdout_r);
        if (p->stderr_r >= 0) close(p->stderr_r);
        if (s->rt) { js_free_rt(s->rt, p->pending); }
        p->pending = NULL; p->pending_n = 0; p->pending_cap = 0;
        p->used = 0;
    }
    /* PTY teardown: the same discipline for the terminal children — SIGKILL
     * every still-tracked pty child, reap, close the master, drop the
     * backpressure buffer. A run must not leak awaited terminals. */
    for (int i = 0; i < DSH_PTY_MAX_SLOTS; i++) {
        dsh_pty *t = &s->ptys[i];
        if (!t->used) continue;
        if (!t->reaped) {
            kill((pid_t)t->pid, SIGKILL);
            waitpid((pid_t)t->pid, NULL, 0);
            t->reaped = 1;
        }
        if (t->master >= 0) close(t->master);
        if (s->rt) js_free_rt(s->rt, t->pending);
        t->pending = NULL; t->pending_n = 0; t->pending_cap = 0;
        t->used = 0;
    }
    /* Socket teardown: every loopback listener and connection fd closes —
     * a run must not leak open doors (the server lifetime is the opening
     * session's, contract §4). */
    dsh_socket_close_all();
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
