/*
 * gateway_smoke.cpp — the HarmonyOS gateway-bridge smoke backend (M5).
 * Platform twin of runtime/spike/host/main_cli.c's smoke backend; see
 * gateway_smoke.h. Only the primitives m2.bridge.smoke exercises are
 * implemented; everything else fails with the contract's error codes
 * (contract/primitives.md §3): keychain honestly "unavailable" (the
 * descriptor declares it so), unknown primitives "invalid".
 */
#include <hilog/log.h>

#undef LOG_DOMAIN
#define LOG_DOMAIN 0xD5E0
#undef LOG_TAG
#define LOG_TAG "dsh.spike"

extern "C" {
#include "dsh_spike_host.h"
#include "gateway_smoke.h"
}

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

struct dsh_smoke_req {
    int call_id;
    char *name;
    char *args;
    dsh_smoke_req *next;
};

struct dsh_smoke_backend {
    dsh_spike_t *spike;
    char *fs_root;
    dsh_smoke_req *head;
    dsh_smoke_req *tail;
    int failed;
    /* binding mode (M5 host-binding phase): platform primitives forward to
     * the embedder's capability layer; the descriptor is the binding one. */
    dsh_smoke_forward_fn forward_fn;
    void *forward_ud;
    char *descriptor_json;
};

const char *DSH_SMOKE_DESCRIPTOR =
    "{\"available\":[\"fsRead\",\"fsWrite\",\"fsScope\"],"
    "\"unavailable\":[\"httpFetch\",\"notify\",\"presentApproval\","
    "\"presentPicker\",\"keychainGet\",\"keychainSet\"]}";

/* Binding descriptor: the primitives the ArkTS capability layer serves for
 * real, and the honest v1 unavailable set (picker needs the user-scope fs
 * surface, keychain the HUKS bridge, httpFetch the streaming body bridge —
 * all documented v2 paths in the agent note). */
const char *DSH_BINDING_DESCRIPTOR =
    "{\"available\":[\"fsRead\",\"fsWrite\",\"fsScope\",\"notify\","
    "\"presentApproval\"],"
    "\"unavailable\":[\"presentPicker\",\"keychainGet\",\"keychainSet\","
    "\"httpFetch\"]}";

/* ---- base64 (payloads travel B64 per the bridge contract) ---------------- */

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const unsigned char *src, size_t n) {
    size_t out_n = ((n + 2) / 3) * 4;
    char *out = static_cast<char *>(malloc(out_n + 1));
    if (!out) return nullptr;
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
    unsigned char *out = static_cast<unsigned char *>(malloc(max + 1));
    if (!out) return nullptr;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 4) {
        size_t rem = len - i;
        int v0 = b64_val(static_cast<unsigned char>(src[i]));
        int v1 = rem > 1 ? b64_val(static_cast<unsigned char>(src[i + 1])) : 0;
        int v2 = rem > 2 ? b64_val(static_cast<unsigned char>(src[i + 2])) : 0;
        int v3 = rem > 3 ? b64_val(static_cast<unsigned char>(src[i + 3])) : 0;
        if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) { free(out); return nullptr; }
        unsigned n = (static_cast<unsigned>(v0) << 18) | (static_cast<unsigned>(v1) << 12) |
                     (static_cast<unsigned>(v2) << 6) | static_cast<unsigned>(v3);
        out[o++] = static_cast<unsigned char>(n >> 16);
        if (rem > 2) out[o++] = static_cast<unsigned char>(n >> 8);
        if (rem > 3) out[o++] = static_cast<unsigned char>(n);
    }
    *out_n = o;
    return out;
}

/* ---- flat-JSON helpers (args are canonical JSON.stringify of simple
 * strings/booleans — the shim never emits escapes here, so raw copy is
 * sufficient, exactly as on the desktop CLI) ------------------------------ */

static char *json_str_dup(const char *json, const char *key) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *at = strstr(json, needle);
    if (!at) return nullptr;
    at += strlen(needle);
    while (*at == ' ') at++;
    if (*at != '"') return nullptr;
    at++;
    const char *end = strchr(at, '"');
    if (!end) return nullptr;
    size_t n = static_cast<size_t>(end - at);
    char *out = static_cast<char *>(malloc(n + 1));
    if (!out) return nullptr;
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

/* ---- settlement ---------------------------------------------------------- */

static void smoke_settle(dsh_smoke_backend *b, int call_id, int ok,
                         const char *payload) {
    if (dsh_spike_gateway_settle(b->spike, call_id, ok, payload) == 0) return;
    b->failed = 1;
    OH_LOG_ERROR(LOG_APP, "smoke: settle failed: %{public}s", dsh_spike_error(b->spike));
}

static void smoke_reject(dsh_smoke_backend *b, int call_id, const char *primitive,
                         const char *code, const char *message) {
    char payload[256];
    snprintf(payload, sizeof(payload),
             "{\"code\":\"%s\",\"primitive\":\"%s\",\"message\":\"%s\"}",
             code, primitive, message);
    smoke_settle(b, call_id, 0, payload);
}

/* ---- fs primitives (scope "app" = the backend's root dir) ---------------- */

/* Scope-root escape check (contract §3: such a path is "invalid"). */
static int smoke_path_ok(const char *path) {
    return path && path[0] && path[0] != '/' && !strstr(path, "..");
}

static char *smoke_path(dsh_smoke_backend *b, const char *rel) {
    size_t n = strlen(b->fs_root) + strlen(rel) + 2;
    char *out = static_cast<char *>(malloc(n));
    if (out) snprintf(out, n, "%s/%s", b->fs_root, rel);
    return out;
}

/* mkdir -p for the file's parent — the platform fs primitives create
 * intermediate directories on write; the smoke backend keeps parity
 * (same as the desktop CLI twin). */
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

struct smoke_fs_args {
    char *scope;
    char *path;
    char *b64;
    int append;
    int create;
};

static void smoke_fs_args_free(smoke_fs_args *a) {
    free(a->scope);
    free(a->path);
    free(a->b64);
}

static void smoke_fs_write(dsh_smoke_backend *b, int call_id, const char *args) {
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
        char *full = bytes ? smoke_path(b, a.path) : nullptr;
        if (full) smoke_mkdirs(full);
        const char *mode = a.append ? "ab" : (a.create ? "wb" : "r+b");
        FILE *f = full ? fopen(full, mode) : nullptr;
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

static void smoke_fs_read(dsh_smoke_backend *b, int call_id, const char *args) {
    smoke_fs_args a = {
        json_str_dup(args, "scope"), json_str_dup(args, "path"),
        nullptr, 0, 1,
    };
    if (!a.scope || !a.path) {
        smoke_reject(b, call_id, "fsRead", "invalid", "missing scope/path");
    } else if (strcmp(a.scope, "app") != 0) {
        smoke_reject(b, call_id, "fsRead", "denied", "scope not granted");
    } else if (!smoke_path_ok(a.path)) {
        smoke_reject(b, call_id, "fsRead", "invalid", "path escapes its scope");
    } else {
        char *full = smoke_path(b, a.path);
        FILE *f = full ? fopen(full, "rb") : nullptr;
        long n = -1;
        if (f) {
            fseek(f, 0, SEEK_END);
            n = ftell(f);
            fseek(f, 0, SEEK_SET);
        }
        if (!f || n < 0) {
            smoke_reject(b, call_id, "fsRead", "io", "cannot read file");
        } else {
            size_t len = static_cast<size_t>(n);
            unsigned char *bytes = static_cast<unsigned char *>(malloc(len + 1));
            size_t got = bytes ? fread(bytes, 1, len, f) : 0;
            if (!bytes || got != len) {
                smoke_reject(b, call_id, "fsRead", "io", "cannot read file");
            } else {
                char *b64 = b64_encode(bytes, len);
                char mtime[32];
                smoke_mtime(full, mtime, sizeof(mtime));
                if (b64) {
                    size_t pn = strlen(b64) + strlen(mtime) + 40;
                    char *payload = static_cast<char *>(malloc(pn));
                    if (payload) {
                        snprintf(payload, pn, "{\"bytesB64\":\"%s\",\"mtime\":\"%s\"}",
                                 b64, mtime);
                        smoke_settle(b, call_id, 1, payload);
                        free(payload);
                    }
                    free(b64);
                }
            }
            free(bytes);
        }
        if (f) fclose(f);
        free(full);
    }
    smoke_fs_args_free(&a);
}

/* ---- primitive table ------------------------------------------------------ */

static void smoke_serve(dsh_smoke_backend *b, int call_id, const char *name,
                        const char *args) {
    if (b->forward_fn != nullptr) {
        /* binding mode: the two platform primitives the ArkTS capability
         * layer serves for real ride the forward hook (settled later from
         * its UI callbacks — never from inside this callback); everything
         * else the binding descriptor declares unavailable rejects here. */
        if (strcmp(name, "notify") == 0 || strcmp(name, "presentApproval") == 0) {
            b->forward_fn(b->forward_ud, call_id, name, args);
            return;
        }
        if (strcmp(name, "httpFetch") == 0 || strcmp(name, "presentPicker") == 0) {
            return smoke_reject(b, call_id, name, "unavailable",
                                "declared unavailable by the host descriptor");
        }
    }
    if (strcmp(name, "fsWrite") == 0) return smoke_fs_write(b, call_id, args);
    if (strcmp(name, "fsRead") == 0) return smoke_fs_read(b, call_id, args);
    if (strcmp(name, "fsScope.persist") == 0) {
        if (b->forward_fn != nullptr) {
            /* app-scope v1: only the app scope persists (contract §4 —
             * user-scope persistence is the documented v2 path). */
            char *scope = json_str_dup(args, "scope");
            int ok = scope != nullptr && strcmp(scope, "app") == 0;
            free(scope);
            if (!ok) {
                return smoke_reject(b, call_id, "fsScope.persist", "denied",
                                    "only the app scope persists on this host");
            }
        }
        return smoke_settle(b, call_id, 1, "{\"ref\":\"bkm:app\"}");
    }
    if (strcmp(name, "fsScope.resolve") == 0) {
        if (b->forward_fn != nullptr) {
            char *ref = json_str_dup(args, "ref");
            int ok = ref != nullptr && strcmp(ref, "bkm:app") == 0;
            free(ref);
            if (!ok) {
                return smoke_reject(b, call_id, "fsScope.resolve", "io",
                                    "no scope resolves under this ref");
            }
        }
        return smoke_settle(b, call_id, 1, "{\"scope\":\"app\"}");
    }
    if (strncmp(name, "keychain", 8) == 0) {
        return smoke_reject(b, call_id, name, "unavailable",
                            "keychain is declared unavailable by the host");
    }
    smoke_reject(b, call_id, name, "invalid", "unknown primitive");
}

/* ---- bridge plumbing ------------------------------------------------------- */

/* Dispatch callback: queue only — settlement happens after the pump pass
 * (the later-tick pattern the smoke scenario exists to prove). */
static void smoke_on_call(void *ud, int call_id, const char *name,
                          const char *args) {
    dsh_smoke_backend *b = static_cast<dsh_smoke_backend *>(ud);
    dsh_smoke_req *req =
        static_cast<dsh_smoke_req *>(calloc(1, sizeof(*req)));
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

dsh_smoke_backend_t *dsh_smoke_new(const char *fs_root) {
    dsh_smoke_backend *b =
        static_cast<dsh_smoke_backend *>(calloc(1, sizeof(*b)));
    if (!b) return nullptr;
    b->fs_root = strdup(fs_root);
    if (!b->fs_root) { free(b); return nullptr; }
    if (mkdir(fs_root, 0755) != 0 && errno != EEXIST) {
        OH_LOG_ERROR(LOG_APP, "smoke: cannot create fs root %{public}s", fs_root);
        free(b->fs_root);
        free(b);
        return nullptr;
    }
    return b;
}

void dsh_smoke_set_forward(dsh_smoke_backend_t *b, dsh_smoke_forward_fn fn,
                           void *ud) {
    if (!b) return;
    b->forward_fn = fn;
    b->forward_ud = ud;
}

void dsh_smoke_set_descriptor_json(dsh_smoke_backend_t *b,
                                   const char *descriptor_json) {
    if (!b) return;
    free(b->descriptor_json);
    b->descriptor_json = strdup(descriptor_json);
}

void dsh_smoke_attach(dsh_smoke_backend_t *b, dsh_spike_t *spike) {
    if (!b) return;
    b->spike = spike;
    dsh_spike_set_gateway_dispatch(spike, smoke_on_call, b);
    dsh_spike_set_descriptor(spike, b->descriptor_json != nullptr
                                        ? b->descriptor_json
                                        : DSH_SMOKE_DESCRIPTOR);
}

int dsh_smoke_drain(dsh_smoke_backend_t *b) {
    int served = 0;
    while (b->head && !b->failed) {
        dsh_smoke_req *req = b->head;
        b->head = req->next;
        if (!b->head) b->tail = nullptr;
        smoke_serve(b, req->call_id, req->name, req->args);
        free(req->name);
        free(req->args);
        free(req);
        served++;
    }
    return b->failed ? -1 : served;
}

int dsh_smoke_failed(const dsh_smoke_backend_t *b) { return b ? b->failed : 1; }

void dsh_smoke_free(dsh_smoke_backend_t *b) {
    if (!b) return;
    while (b->head) {
        dsh_smoke_req *req = b->head;
        b->head = req->next;
        free(req->name);
        free(req->args);
        free(req);
    }
    free(b->fs_root);
    free(b->descriptor_json);
    free(b);
}
