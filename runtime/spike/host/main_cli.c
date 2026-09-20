/*
 * main_cli.c — desktop CLI driver for the M2 spike (macOS/Linux proof run).
 *
 * stdout carries ONLY the canonical E2E log lines (so `> logs.txt` feeds the
 * checker directly); diagnostics go to stderr; exit 0 = scenario completed
 * and passed.
 *
 * The driver doubles as the gateway BRIDGE SMOKE BACKEND: it registers the
 * dispatch (dsh_spike_set_gateway_dispatch) and a descriptor declaring
 * fsRead/fsWrite/fsScope available, everything else unavailable. Incoming
 * calls are only QUEUED inside on_call — settlement is deferred to the
 * post-pump drain pass, proving the later-tick settling pattern. fs
 * operations run against a fresh temp dir exposed as scope "app"; every
 * other primitive rejects with the contract's "unavailable" error.
 */
#include "dsh_spike_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define SMOKE_DEADLINE_SECONDS 10

static void on_log(void *ud, const char *line) {
    (void)ud;
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static char *slurp(const char *path, size_t *out_len) {
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

/* ---- smoke backend ------------------------------------------------------- */

typedef struct smoke_req {
    int call_id;
    char *name;
    char *args;
    struct smoke_req *next;
} smoke_req;

typedef struct smoke_backend {
    dsh_spike_t *spike;
    char *tmpdir;
    smoke_req *head;
    smoke_req *tail;
    int failed;
} smoke_backend;

static const char *SMOKE_DESCRIPTOR =
    "{\"available\":[\"fsRead\",\"fsWrite\",\"fsScope\"],"
    "\"unavailable\":[\"httpFetch\",\"notify\",\"presentApproval\","
    "\"presentPicker\",\"keychainGet\",\"keychainSet\"]}";

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

/* Copy the string value of key out of a flat JSON object (malloc'd,
 * NUL-terminated), or NULL when absent. The smoke backend only receives
 * canonical JSON.stringify output of simple strings — no escapes — so raw
 * copy-to-next-quote is sufficient here. */
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

static void smoke_settle(smoke_backend *b, int call_id, int ok,
                         const char *payload) {
    if (dsh_spike_gateway_settle(b->spike, call_id, ok, payload) == 0) return;
    b->failed = 1;
    fprintf(stderr, "smoke: settle failed: %s\n", dsh_spike_error(b->spike));
}

static void smoke_reject(smoke_backend *b, int call_id, const char *primitive,
                         const char *code, const char *message) {
    char payload[256];
    snprintf(payload, sizeof(payload),
             "{\"code\":\"%s\",\"primitive\":\"%s\",\"message\":\"%s\"}",
             code, primitive, message);
    smoke_settle(b, call_id, 0, payload);
}

/* Scope-root escape check (contract §3: such a path is "invalid"). */
static int smoke_path_ok(const char *path) {
    return path && path[0] && path[0] != '/' && !strstr(path, "..");
}

static char *smoke_path(smoke_backend *b, const char *rel) {
    size_t n = strlen(b->tmpdir) + strlen(rel) + 2;
    char *out = malloc(n);
    if (out) snprintf(out, n, "%s/%s", b->tmpdir, rel);
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
        smoke_reject(b, call_id, "fsWrite", "invalid", "missing scope/path/bytesB64");
    } else if (strcmp(a.scope, "app") != 0) {
        smoke_reject(b, call_id, "fsWrite", "denied", "scope not granted");
    } else if (!smoke_path_ok(a.path)) {
        smoke_reject(b, call_id, "fsWrite", "invalid", "path escapes its scope");
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
        smoke_reject(b, call_id, "fsRead", "invalid", "path escapes its scope");
    } else {
        full = smoke_path(b, a.path);
        size_t n = 0;
        content = full ? slurp(full, &n) : NULL;
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

static void smoke_serve(smoke_backend *b, int call_id, const char *name,
                        const char *args) {
    if (strcmp(name, "fsWrite") == 0) return smoke_fs_write(b, call_id, args);
    if (strcmp(name, "fsRead") == 0) return smoke_fs_read(b, call_id, args);
    if (strcmp(name, "fsScope.persist") == 0) {
        return smoke_settle(b, call_id, 1, "{\"ref\":\"bkm:tmp\"}");
    }
    if (strcmp(name, "fsScope.resolve") == 0) {
        /* The profile container IS the scope root: return its absolute POSIX
         * path so session cwd pinning is honest (the gateway fs scope and the
         * filesystem view stay the same directory). */
        char payload[640];
        snprintf(payload, sizeof(payload), "{\"scope\":\"app\",\"path\":\"%s\"}", b->tmpdir);
        return smoke_settle(b, call_id, 1, payload);
    }
    smoke_reject(b, call_id, name, "unavailable",
                 "declared unavailable by the smoke backend");
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

static char *smoke_tmpdir(void) {
    char tmpl[] = "/tmp/dsh-spike-smoke.XXXXXX";
    char *dir = mkdtemp(tmpl);
    return dir ? strdup(dir) : NULL; /* temp litter is left for /tmp cleanup */
}

int main(int argc, char **argv) {
    const char *base = argc > 1 ? argv[1] : "..";
    const char *entry = argc > 2 ? argv[2] : "scenario/m1-spike-boot.js";
    char entry_path[1024];
    snprintf(entry_path, sizeof(entry_path), "%s/%s", base, entry);

    char *source = slurp(entry_path, NULL);
    if (!source) {
        fprintf(stderr, "spike: cannot read entry %s\n", entry_path);
        return 2;
    }

    dsh_spike_sink sink = { on_log, NULL };
    smoke_backend b = {0};
    b.tmpdir = smoke_tmpdir();
    b.spike = dsh_spike_new(base, &sink);
    if (!b.spike || !b.tmpdir) {
        fprintf(stderr, "spike: runtime init failed\n");
        free(source);
        free(b.tmpdir);
        if (b.spike) dsh_spike_free(b.spike);
        return 2;
    }
    dsh_spike_set_gateway_dispatch(b.spike, smoke_on_call, &b);
    dsh_spike_set_descriptor(b.spike, SMOKE_DESCRIPTOR);

    int rc = dsh_spike_eval(b.spike, entry, source);
    free(source);

    /* Host readiness signal through the same gateway-event channel the
     * platform embedders use: {"event":"host.info","port":0} — the desktop
     * backend has no carrier, so port 0. Scenarios waiting on it start here;
     * scenarios without a subscriber drop it (shim contract). */
    if (rc == 0 && !b.failed
        && dsh_spike_gateway_event(b.spike, "{\"event\":\"host.info\",\"port\":0}") != 0) {
        rc = -1;
    }

    /* Drive {pump → drain} until the scenario completes, an exception fires,
     * or the backstop deadline passes — condition-driven, never sleeps. */
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += SMOKE_DEADLINE_SECONDS;
    while (rc == 0 && !b.failed && !dsh_spike_complete(b.spike)) {
        rc = dsh_spike_pump(b.spike);
        if (rc != 0) break;
        int served = smoke_drain(&b);
        if (served < 0) { rc = -1; break; }
        if (dsh_spike_complete(b.spike)) break;
        if (served == 0) break; /* quiescent with nothing outstanding */
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) {
            fprintf(stderr, "smoke: %ds deadline elapsed before completion\n",
                    SMOKE_DEADLINE_SECONDS);
            rc = -1;
            break;
        }
    }

    int exit_code = (rc == 0 && !b.failed && dsh_spike_complete(b.spike) &&
                     dsh_spike_pass(b.spike)) ? 0 : 1;
    fprintf(stderr, "spike: %s (complete=%d pass=%d)\n",
            exit_code == 0 ? "PASS" : "FAIL",
            dsh_spike_complete(b.spike), dsh_spike_pass(b.spike));
    if (rc < 0 || exit_code != 0) {
        fprintf(stderr, "spike: error: %s\n", dsh_spike_error(b.spike));
    }
    dsh_spike_free(b.spike);
    free(b.tmpdir);
    return exit_code;
}
