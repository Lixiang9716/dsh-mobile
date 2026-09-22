/*
 * dsh_spike_smoke.c — Android smoke backend over the shared spike host's
 * gateway dispatch bridge (dsh_spike_set_gateway_dispatch). Handler set
 * mirrors runtime/spike/host/main_cli.c: calls are only QUEUED inside
 * on_call (which fires synchronously on the runtime thread) and settled in
 * the post-pump drain pass — the deferred later-tick settlement the
 * gateway.bridge-smoke scenario exists to prove. fs payloads travel base64; the
 * scope root is an app-private directory instead of /tmp.
 */
#include "dsh_spike_smoke.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define SMOKE_DEADLINE_SECONDS 10

/* Same descriptor the CLI smoke backend sets: fs on, everything the spike
 * cannot honestly provide on Android declared unavailable (contract §2). */
static const char *SMOKE_DESCRIPTOR =
        "{\"available\":[\"fsRead\",\"fsWrite\",\"fsScope\"],"
        "\"unavailable\":[\"httpFetch\",\"notify\",\"presentApproval\","
        "\"presentPicker\",\"keychainGet\",\"keychainSet\"]}";

typedef struct smoke_req {
    int call_id;
    char *name;
    char *args;
    struct smoke_req *next;
} smoke_req;

typedef struct smoke_backend {
    dsh_spike_t *spike;
    const char *fs_root;
    smoke_req *head;
    smoke_req *tail;
    int failed;
} smoke_backend;

static void smoke_seterr(smoke_backend *b, char *err_out, size_t err_sz) {
    if (!err_out || err_sz == 0) return;
    snprintf(err_out, err_sz, "%s", dsh_spike_error(b->spike));
}

static void smoke_settle(smoke_backend *b, int call_id, int ok,
                         const char *payload) {
    if (dsh_spike_gateway_settle(b->spike, call_id, ok, payload) == 0) return;
    b->failed = 1;
}

static void smoke_reject(smoke_backend *b, int call_id, const char *primitive,
                         const char *code, const char *message) {
    char payload[256];
    snprintf(payload, sizeof(payload),
             "{\"code\":\"%s\",\"primitive\":\"%s\",\"message\":\"%s\"}",
             code, primitive, message);
    smoke_settle(b, call_id, 0, payload);
}

/* Copy the string value of key out of a flat JSON object (malloc'd,
 * NUL-terminated), or NULL when absent. The backend only receives
 * canonical JSON.stringify output of simple strings — no escapes — so raw
 * copy-to-next-quote is sufficient here (same assumption as main_cli.c). */
static char *json_str_dup(const char *json, const char *key) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *at = strstr(json, needle);
    if (!at) return NULL;
    at += strlen(needle);
    while (*at == ' ') at++;
    if (*at != '"') return NULL;
    at++;
    const char *end = strchr(at, '"');
    if (!end) return NULL;
    size_t n = (size_t)(end - at);
    char *out = malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, at, n);
    out[n] = 0;
    return out;
}

static int json_bool(const char *json, const char *key, int dflt) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *at = strstr(json, needle);
    if (!at) return dflt;
    at += strlen(needle);
    if (strncmp(at, "true", 4) == 0) return 1;
    if (strncmp(at, "false", 5) == 0) return 0;
    return dflt;
}

/* Reads a whole file into a NUL-terminated heap buffer, or NULL. */
static char *smoke_slurp(const char *path, size_t *out_len) {
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

static const char B64[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const unsigned char *src, size_t n) {
    size_t out_n = ((n + 2) / 3) * 4;
    char *out = malloc(out_n + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        size_t rem = n - i;
        unsigned b0 = src[i];
        unsigned b1 = i + 1 < n ? src[i + 1] : 0;
        unsigned b2 = i + 2 < n ? src[i + 2] : 0;
        out[o++] = B64[b0 >> 2];
        out[o++] = B64[((b0 & 3) << 4) | (b1 >> 4)];
        out[o++] = rem > 1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out[o++] = rem > 2 ? B64[b2 & 63] : '=';
    }
    out[o] = 0;
    return out;
}

static int b64_val(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static unsigned char *b64_decode(const char *src, size_t *out_n) {
    size_t len = strlen(src);
    while (len > 0 && src[len - 1] == '=') len--; /* ignore padding */
    size_t max = (len / 4) * 3 + (len % 4 ? len % 4 - 1 : 0);
    unsigned char *out = malloc(max + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 4) {
        size_t rem = len - i;
        int v0 = b64_val((unsigned char)src[i]);
        int v1 = rem > 1 ? b64_val((unsigned char)src[i + 1]) : 0;
        int v2 = rem > 2 ? b64_val((unsigned char)src[i + 2]) : 0;
        int v3 = rem > 3 ? b64_val((unsigned char)src[i + 3]) : 0;
        if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) { free(out); return NULL; }
        unsigned n = ((unsigned)v0 << 18) | ((unsigned)v1 << 12) |
                     ((unsigned)v2 << 6) | (unsigned)v3;
        out[o++] = (unsigned char)(n >> 16);
        if (rem > 2) out[o++] = (unsigned char)(n >> 8);
        if (rem > 3) out[o++] = (unsigned char)n;
    }
    *out_n = o;
    return out;
}

/* Scope-root escape check (contract §3: such a path is "invalid"). */
static int smoke_path_ok(const char *path) {
    return path && path[0] && path[0] != '/' && !strstr(path, "..");
}

static char *smoke_path(smoke_backend *b, const char *rel) {
    size_t n = strlen(b->fs_root) + strlen(rel) + 2;
    char *out = malloc(n);
    if (out) snprintf(out, n, "%s/%s", b->fs_root, rel);
    return out;
}

/* mkdir -p for the file's parent — the platform fs primitives create
 * intermediate directories on write; the smoke backend keeps parity. */
static void smoke_mkdirs(const char *path) {
    char *copy = strdup(path);
    if (!copy) return;
    char *slash = strrchr(copy, '/');
    if (!slash) { free(copy); return; }
    *slash = 0;
    for (char *at = copy + 1; *at; at++) {
        if (*at == '/') { *at = 0; mkdir(copy, 0755); *at = '/'; }
    }
    mkdir(copy, 0755);
    free(copy);
}

/* ISO-8601 UTC mtime for the fsRead payload. */
static void smoke_mtime(const char *path, char *out, size_t outsz) {
    struct stat st;
    out[0] = 0;
    if (stat(path, &st) != 0) return;
    struct tm tm;
    gmtime_r(&st.st_mtime, &tm);
    strftime(out, outsz, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/* Args bundle for the fs primitives, parsed once up front. */
typedef struct smoke_fs_args {
    char *scope;
    char *path;
    char *b64;
    int append;
    int create;
} smoke_fs_args;

static void smoke_fs_args_free(smoke_fs_args *a) {
    free(a->scope);
    free(a->path);
    free(a->b64);
}

static void smoke_fs_write(smoke_backend *b, int call_id, const char *args) {
    smoke_fs_args a = {
            json_str_dup(args, "scope"), json_str_dup(args, "path"),
            json_str_dup(args, "bytesB64"), json_bool(args, "append", 0),
            json_bool(args, "create", 1),
    };
    if (!a.scope || !a.path || !a.b64) {
        smoke_reject(b, call_id, "fsWrite", "invalid",
                     "missing scope/path/bytesB64");
    } else if (strcmp(a.scope, "app") != 0) {
        smoke_reject(b, call_id, "fsWrite", "denied", "scope not granted");
    } else if (!smoke_path_ok(a.path)) {
        smoke_reject(b, call_id, "fsWrite", "invalid",
                     "path escapes its scope");
    } else {
        size_t n = 0;
        unsigned char *bytes = b64_decode(a.b64, &n);
        char *full = bytes ? smoke_path(b, a.path) : NULL;
        if (full) smoke_mkdirs(full);
        const char *mode = a.append ? "ab" : (a.create ? "wb" : "r+b");
        FILE *f = full ? fopen(full, mode) : NULL;
        size_t written = f ? fwrite(bytes, 1, n, f) : 0;
        if (f) fclose(f);
        if (!f || written != n) {
            smoke_reject(b, call_id, "fsWrite", "io", "cannot write file");
        } else {
            char payload[64];
            snprintf(payload, sizeof(payload), "{\"written\":%zu}", written);
            smoke_settle(b, call_id, 1, payload);
        }
        free(full);
        free(bytes);
    }
    smoke_fs_args_free(&a);
}

static void smoke_fs_read(smoke_backend *b, int call_id, const char *args) {
    smoke_fs_args a = {
            json_str_dup(args, "scope"), json_str_dup(args, "path"),
            NULL, 0, 1,
    };
    char *full = NULL;
    char *content = NULL;
    if (!a.scope || !a.path) {
        smoke_reject(b, call_id, "fsRead", "invalid", "missing scope/path");
    } else if (strcmp(a.scope, "app") != 0) {
        smoke_reject(b, call_id, "fsRead", "denied", "scope not granted");
    } else if (!smoke_path_ok(a.path)) {
        smoke_reject(b, call_id, "fsRead", "invalid",
                     "path escapes its scope");
    } else {
        full = smoke_path(b, a.path);
        size_t n = 0;
        content = full ? smoke_slurp(full, &n) : NULL;
        if (!content) {
            smoke_reject(b, call_id, "fsRead", "io", "cannot read file");
        } else {
            char *b64 = b64_encode((const unsigned char *)content, n);
            char mtime[32];
            smoke_mtime(full, mtime, sizeof(mtime));
            if (b64) {
                size_t pn = strlen(b64) + strlen(mtime) + 40;
                char *payload = malloc(pn);
                if (payload) {
                    snprintf(payload, pn, "{\"bytesB64\":\"%s\",\"mtime\":\"%s\"}",
                             b64, mtime);
                    smoke_settle(b, call_id, 1, payload);
                    free(payload);
                }
                free(b64);
            }
        }
    }
    free(content);
    free(full);
    smoke_fs_args_free(&a);
}

/* True when the descriptor declares the primitive unavailable — those get
 * the honest "unavailable" code, everything else is "invalid" (fail loud
 * with the offending name, AGENTS.md rule 5). */
static int smoke_unavailable(const char *name) {
    static const char *const k[] = {"httpFetch", "notify", "presentApproval",
                                    "presentPicker", "keychainGet",
                                    "keychainSet"};
    for (size_t i = 0; i < sizeof(k) / sizeof(k[0]); i++) {
        if (strcmp(name, k[i]) == 0) return 1;
    }
    return 0;
}

static void smoke_serve(smoke_backend *b, int call_id, const char *name,
                        const char *args) {
    if (strcmp(name, "fsWrite") == 0) return smoke_fs_write(b, call_id, args);
    if (strcmp(name, "fsRead") == 0) return smoke_fs_read(b, call_id, args);
    if (strcmp(name, "fsScope.persist") == 0) {
        return smoke_settle(b, call_id, 1, "{\"ref\":\"bkm:app\"}");
    }
    if (strcmp(name, "fsScope.resolve") == 0) {
        return smoke_settle(b, call_id, 1, "{\"scope\":\"app\"}");
    }
    if (smoke_unavailable(name)) {
        smoke_reject(b, call_id, name, "unavailable",
                     "declared unavailable by the runtime descriptor");
        return;
    }
    smoke_reject(b, call_id, name, "invalid", "unknown primitive");
}

/* Dispatch callback: queue only — settlement happens after the pump pass
 * (the later-tick pattern the smoke scenario exists to prove). */
static void smoke_on_call(void *ud, int call_id, const char *name,
                          const char *args) {
    smoke_backend *b = (smoke_backend *)ud;
    smoke_req *req = calloc(1, sizeof(*req));
    if (!req) { b->failed = 1; return; }
    req->call_id = call_id;
    req->name = strdup(name);
    req->args = strdup(args);
    if (!req->name || !req->args) {
        free(req->name);
        free(req->args);
        free(req);
        b->failed = 1;
        return;
    }
    if (b->tail) b->tail->next = req; else b->head = req;
    b->tail = req;
}

static int smoke_drain(smoke_backend *b) {
    int served = 0;
    while (b->head && !b->failed) {
        smoke_req *req = b->head;
        b->head = req->next;
        if (!b->head) b->tail = NULL;
        smoke_serve(b, req->call_id, req->name, req->args);
        free(req->name);
        free(req->args);
        free(req);
        served++;
    }
    return b->failed ? -1 : served;
}

/* Monotonic-clock deadline for the drive loop. */
static void smoke_deadline(struct timespec *out, int seconds) {
    clock_gettime(CLOCK_MONOTONIC, out);
    out->tv_sec += seconds;
}

static int smoke_expired(const struct timespec *deadline) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec > deadline->tv_sec ||
           (now.tv_sec == deadline->tv_sec && now.tv_nsec >= deadline->tv_nsec);
}

/* Drive {pump -> drain} until completion, failure, or quiescence with
 * nothing outstanding (condition-driven, never sleeps). 0 ok, -1 failed. */
static int smoke_drive(smoke_backend *b) {
    struct timespec deadline;
    smoke_deadline(&deadline, SMOKE_DEADLINE_SECONDS);
    int rc = 0;
    while (rc == 0 && !b->failed && !dsh_spike_complete(b->spike)) {
        rc = dsh_spike_pump(b->spike);
        if (rc != 0) break;
        int served = smoke_drain(b);
        if (served < 0) { rc = -1; break; }
        if (dsh_spike_complete(b->spike)) break;
        if (served == 0) break; /* quiescent with nothing outstanding */
        if (smoke_expired(&deadline)) rc = -1;
    }
    return rc;
}

int dsh_smoke_run(const char *bundle_root, const char *entry_name,
                  const char *source, const char *fs_root,
                  const dsh_spike_sink *sink, char *err_out,
                  size_t err_out_sz) {
    smoke_backend b = {0};
    b.fs_root = fs_root;
    b.spike = dsh_spike_new(bundle_root, sink);
    if (!b.spike) {
        snprintf(err_out, err_out_sz, "dsh_spike_new failed");
        return 0;
    }
    dsh_spike_set_gateway_dispatch(b.spike, smoke_on_call, &b);
    dsh_spike_set_descriptor(b.spike, SMOKE_DESCRIPTOR);

    int rc = dsh_spike_eval(b.spike, entry_name, source);
    /* source stays caller-owned (freed in dsh_run_scenario) — do NOT free here. */

    /* Host readiness signal through the same gateway-event channel the
     * platform embedders use: {"event":"host.info","port":0} — the spike
     * backend has no carrier, so port 0. Scenarios waiting on it start
     * here; runtimes without a subscriber drop it (shim contract). */
    if (rc == 0 && !b.failed
        && dsh_spike_gateway_event(b.spike, "{\"event\":\"host.info\",\"port\":0}") != 0) {
        rc = -1;
    }
    if (rc == 0) rc = smoke_drive(&b);

    int passed = (rc == 0 && !b.failed && dsh_spike_complete(b.spike) &&
                  dsh_spike_pass(b.spike));
    if (!passed || dsh_spike_error(b.spike)[0]) {
        smoke_seterr(&b, err_out, err_out_sz);
    }
    dsh_spike_free(b.spike);
    return passed;
}
