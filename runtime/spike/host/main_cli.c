/*
 * main_cli.c — desktop CLI driver for the M2 spike (macOS/Linux proof run).
 *
 * stdout carries ONLY the canonical E2E log lines (so `> logs.txt` feeds the
 * checker directly); diagnostics go to stderr; exit 0 = scenario completed
 * and passed.
 *
 * The driver doubles as the gateway BRIDGE SMOKE BACKEND: it registers the
 * dispatch (dsh_spike_set_gateway_dispatch) and a descriptor declaring
 * fsRead/fsWrite/fsScope available, everything else unavailable — plus
 * httpFetch when launched with --http (the upstream-LLM E2E streams the mock
 * chat-completions server through it; default builds keep the descriptor
 * unchanged so the bridge-smoke evidence stays stable). Incoming calls are
 * only QUEUED inside on_call — settlement is deferred to the post-pump drain
 * pass, proving the later-tick settling pattern. fs operations run against a
 * fresh temp dir exposed as scope "app"; every other primitive rejects with
 * the contract's "unavailable" error. The httpFetch backend is LOOPBACK-ONLY
 * (127.0.0.1/localhost): a phone's real egress is the platform embedder's
 * policy, not the desktop proof driver's business.
 *
 * usage: dsh-spike-cli [base] [entry] [--http] [--env KEY=VALUE ...]
 */
#include "dsh_spike_host.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define SMOKE_DEADLINE_SECONDS 10
#define HTTP_RCV_TIMEOUT_SECONDS 5
#define HTTP_HEADER_MAX 16384

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
    int http; /* --http: the loopback httpFetch backend is live */
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

/* ---- loopback httpFetch backend (--http) --------------------------------- */

/* settle/reject live below (fs section first); forward-declared here. */
static void smoke_settle(smoke_backend *b, int call_id, int ok, const char *payload);
static void smoke_reject(smoke_backend *b, int call_id, const char *primitive,
                         const char *code, const char *message);

static void http_err(char *err, size_t errsz, const char *msg) {
    snprintf(err, errsz, "%s", msg);
}

/* Parse "http://127.0.0.1:PORT/path" or the localhost spelling. Loopback
 * only — the proof driver never egresses. 0 ok, -1 with err. */
static int http_parse_url(const char *url, int *port, char *path, size_t pathsz,
                          char *err, size_t errsz) {
    const char *rest = NULL;
    if (strncmp(url, "http://127.0.0.1:", 17) == 0) rest = url + 17;
    else if (strncmp(url, "http://localhost:", 17) == 0) rest = url + 17;
    else {
        http_err(err, errsz, "only http://127.0.0.1:PORT URLs are served by the CLI backend");
        return -1;
    }
    long value = 0;
    size_t digits = 0;
    while (rest[digits] >= '0' && rest[digits] <= '9' && digits < 5) {
        value = value * 10 + (rest[digits] - '0');
        digits++;
    }
    if (digits == 0 || value <= 0 || value > 65535 || rest[digits] != '/') {
        http_err(err, errsz, "httpFetch URL must be http://127.0.0.1:PORT/path");
        return -1;
    }
    *port = (int)value;
    snprintf(path, pathsz, "%s", rest + digits);
    return 0;
}

/* Copy a JSON string literal starting at `*at` (which must point at '"') into
 * out; advances *at past the closing quote. Escapes are rejected (the bridge
 * serializes plain header tokens; anything else fails loud). 0 ok, -1 err. */
static int http_json_string(const char **at, char *out, size_t outsz, char *err, size_t errsz) {
    if (**at != '"') {
        http_err(err, errsz, "httpFetch headers: expected a string");
        return -1;
    }
    (*at)++;
    size_t o = 0;
    while (**at && **at != '"') {
        if (**at == '\\' || (unsigned char)**at < 0x20) {
            http_err(err, errsz, "httpFetch headers: escaped strings are not served");
            return -1;
        }
        if (o + 1 >= outsz) {
            http_err(err, errsz, "httpFetch headers: string too long");
            return -1;
        }
        out[o++] = *(*at)++;
    }
    if (**at != '"') {
        http_err(err, errsz, "httpFetch headers: unterminated string");
        return -1;
    }
    (*at)++;
    out[o] = 0;
    return 0;
}

/* Serialize the request headers object ("name":"value" pairs, in document
 * order) into HTTP/1.1 header lines. 0 ok, -1 err. */
static int http_headers_from_args(const char *args, char *out, size_t outsz,
                                  char *err, size_t errsz) {
    out[0] = 0;
    const char *at = strstr(args, "\"headers\":{");
    if (!at) return 0;
    at += strlen("\"headers\":{");
    size_t o = 0;
    for (;;) {
        while (*at == ' ' || *at == ',') at++;
        if (*at == '}') return 0;
        char name[128];
        char value[512];
        if (http_json_string(&at, name, sizeof(name), err, errsz) != 0) return -1;
        while (*at == ' ') at++;
        if (*at != ':') {
            http_err(err, errsz, "httpFetch headers: expected ':'");
            return -1;
        }
        at++;
        while (*at == ' ') at++;
        if (http_json_string(&at, value, sizeof(value), err, errsz) != 0) return -1;
        int n = snprintf(out + o, outsz - o, "%s: %s\r\n", name, value);
        if (n < 0 || (size_t)n >= outsz - o) {
            http_err(err, errsz, "httpFetch headers: header block too large");
            return -1;
        }
        o += (size_t)n;
    }
}

static int http_connect_loopback(int port, char *err, size_t errsz) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        http_err(err, errsz, "socket() failed");
        return -1;
    }
    struct timeval tv = { HTTP_RCV_TIMEOUT_SECONDS, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        snprintf(err, errsz, "cannot connect to 127.0.0.1:%d (%s)", port, strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

static int http_send_all(int fd, const char *buf, size_t n, char *err, size_t errsz) {
    size_t off = 0;
    while (off < n) {
        ssize_t wrote = send(fd, buf + off, n - off, 0);
        if (wrote <= 0) {
            http_err(err, errsz, "request send failed");
            return -1;
        }
        off += (size_t)wrote;
    }
    return 0;
}

/* Read the response head into a scan buffer. Returns 0 and fills:
 *   *head     — malloc'd buffer, header text NUL-terminated (the terminator's
 *               final CRLF bytes are excluded from the string, but *head_len
 *               still counts them so byte offsets stay exact);
 *   *head_len — byte offset where the body starts;
 *   *received — total bytes read (body bytes beyond *head_len stay in buffer).
 * -1 on error/EOF-before-head. */
static int http_read_head(int fd, char **head, long *head_len, long *received,
                          char *err, size_t errsz) {
    size_t cap = 4096;
    long len = 0;
    char *buf = malloc(cap);
    if (!buf) return -1;
    for (;;) {
        if ((size_t)len + 1 >= cap) {
            if (cap >= HTTP_HEADER_MAX) {
                free(buf);
                http_err(err, errsz, "response head too large");
                return -1;
            }
            cap *= 2;
            char *grown = realloc(buf, cap);
            if (!grown) {
                free(buf);
                return -1;
            }
            buf = grown;
        }
        ssize_t got = recv(fd, buf + len, cap - (size_t)len - 1, 0);
        if (got <= 0) {
            free(buf);
            http_err(err, errsz, "connection closed before response head completed");
            return -1;
        }
        len += (long)got;
        buf[len] = 0;
        char *end = strstr(buf, "\r\n\r\n");
        if (end) {
            *head_len = (long)(end - buf) + 4;
            *received = len;
            end[2] = 0; /* header text ends after the last header CRLF */
            *head = buf;
            return 0;
        }
    }
}

/* Lowercase a header name in place. */
static void http_lower(char *s) {
    for (; *s; s++) {
        if (*s >= 'A' && *s <= 'Z') *s += 'a' - 'A';
    }
}

/* Minimal JSON string escape for header values (quotes + backslashes only —
 * other control bytes fail loud at the scan site). */
static void http_json_escape(const char *in, char *out, size_t outsz) {
    size_t o = 0;
    for (const char *p = in; *p && o + 2 < outsz; p++) {
        if (*p == '"' || *p == '\\') out[o++] = '\\';
        out[o++] = *p;
    }
    out[o] = 0;
}

/* Parse the head buffer (status line + header lines, NUL-terminated): status
 * int + headers as a lowercase-keyed JSON object. 0 ok, -1 err. */
static int http_parse_head(const char *head, int *status,
                           char *headers_json, size_t jsonsz, char *err, size_t errsz) {
    int major = 0, minor = 0, code = 0;
    if (sscanf(head, "HTTP/%d.%d %d", &major, &minor, &code) != 3 || code < 100 || code > 599) {
        http_err(err, errsz, "malformed response status line");
        return -1;
    }
    *status = code;
    size_t o = (size_t)snprintf(headers_json, jsonsz, "{");
    const char *line = strchr(head, '\r'); /* end of the status line */
    while (line && line[1] == '\n' && line[2] != '\r' && line[2] != 0) {
        line += 2; /* start of one header line */
        const char *colon = strchr(line, ':');
        if (!colon || colon - line > 256) {
            http_err(err, errsz, "malformed response header line");
            return -1;
        }
        char name[257];
        char value[1024];
        size_t nlen = (size_t)(colon - line);
        memcpy(name, line, nlen);
        name[nlen] = 0;
        http_lower(name);
        const char *vp = colon + 1;
        while (*vp == ' ') vp++;
        size_t vlen = 0;
        while (vp[vlen] && vp[vlen] != '\r' && vlen < sizeof(value) - 1) vlen++;
        if (vp[vlen] != '\r') {
            http_err(err, errsz, "response header value too long");
            return -1;
        }
        memcpy(value, vp, vlen);
        value[vlen] = 0;
        char escaped[2049];
        http_json_escape(value, escaped, sizeof(escaped));
        int wrote = snprintf(headers_json + o, jsonsz - o, "%s\"%s\":\"%s\"",
                             o > 1 ? "," : "", name, escaped);
        if (wrote < 0 || (size_t)wrote >= jsonsz - o) {
            http_err(err, errsz, "response headers too large for the settle payload");
            return -1;
        }
        o += (size_t)wrote;
        line = vp + vlen; /* at the '\r' ending this header line */
    }
    snprintf(headers_json + o, jsonsz - o, "}");
    return 0;
}

/* Emit one decoded body chunk to JS (base64 bridge event), then drain the
 * microtasks the delivery spins up. */
static void http_emit_body(smoke_backend *b, int call_id, const char *bytes, long len) {
    if (len <= 0) return;
    char *b64 = b64_encode((const unsigned char *)bytes, (size_t)len);
    if (!b64) {
        b->failed = 1;
        return;
    }
    size_t n = strlen(b64) + 64;
    char *event = malloc(n);
    if (!event) {
        free(b64);
        b->failed = 1;
        return;
    }
    snprintf(event, n,
             "{\"event\":\"http.body\",\"callId\":%d,\"chunkB64\":\"%s\"}", call_id, b64);
    dsh_spike_gateway_event(b->spike, event);
    free(event);
    free(b64);
}

/* Pending-bytes buffer: bytes read after the response head, ahead of framing. */
typedef struct http_pending {
    char *data;
    long len;
} http_pending;

/* recv more bytes into the pending buffer; 0 eof/error. */
static int http_fill(int fd, http_pending *p, char *buf, size_t bufsz) {
    ssize_t got = recv(fd, buf, bufsz, 0);
    if (got <= 0) return 0;
    char *grown = realloc(p->data, (size_t)p->len + (size_t)got);
    if (!grown) return 0;
    p->data = grown;
    memcpy(p->data + p->len, buf, (size_t)got);
    p->len += (long)got;
    return 1;
}

static void http_drop(http_pending *p, long n) {
    memmove(p->data, p->data + n, (size_t)(p->len - n));
    p->len -= n;
}

/* Stream the response body through http.body events until framing says stop,
 * then http.end. Framing: chunked, content-length, or EOF (connection close).
 * The JS runtime is quiescent while the driver blocks here — every event
 * delivery drains the microtasks that parse the SSE bytes upstream. */
static void http_stream_body(smoke_backend *b, int call_id, int fd,
                             const char *head, long head_len, long leftover_len) {
    (void)head_len;
    const char *te = strstr(head, "\r\ntransfer-encoding:");
    int chunked = te != NULL && strncasecmp(te + 20, " chunked", 8) == 0;
    long remaining = -1; /* content-length framing; -1 = read to EOF */
    const char *clen = strstr(head, "\r\ncontent-length:");
    if (!chunked && clen) remaining = atol(clen + 17);

    char buf[16384];
    http_pending p = { NULL, 0 };
    if (leftover_len > 0) {
        p.data = malloc((size_t)leftover_len);
        if (!p.data) goto fail;
        memcpy(p.data, head + head_len, (size_t)leftover_len);
        p.len = leftover_len;
    }
    for (;;) {
        if (chunked) {
            char *line_end;
            while ((line_end = memchr(p.data, '\r', (size_t)(p.len > 0 ? p.len - 1 : 0))) == NULL
                   || p.len - (line_end - p.data) < 2) {
                if (!http_fill(fd, &p, buf, sizeof(buf))) goto emit_end;
            }
            long size = strtol(p.data, NULL, 16);
            long consumed = (line_end - p.data) + 2; /* size line + CRLF */
            if (size == 0) goto emit_end; /* last chunk — trailers end with the connection */
            while (p.len < consumed + size + 2) {
                if (!http_fill(fd, &p, buf, sizeof(buf))) goto emit_end;
            }
            http_emit_body(b, call_id, p.data + consumed, size);
            if (b->failed) goto fail;
            http_drop(&p, consumed + size + 2);
            continue;
        }
        if (remaining == 0) goto emit_end;
        if (p.len > 0) {
            long take = p.len;
            if (remaining >= 0 && take > remaining) take = remaining;
            http_emit_body(b, call_id, p.data, take);
            if (b->failed) goto fail;
            http_drop(&p, take);
            if (remaining >= 0) remaining -= take;
            continue;
        }
        ssize_t got = recv(fd, buf, sizeof(buf), 0);
        if (got <= 0) goto emit_end;
        long take = (long)got;
        if (remaining >= 0 && take > remaining) take = remaining;
        http_emit_body(b, call_id, buf, take);
        if (b->failed) goto fail;
        if (remaining >= 0) {
            remaining -= take;
            if (remaining > 0 && take < (long)got) {
                /* clamped: keep the surplus for a future call — not our case
                 * (we always drain), but stay correct. */
                p.data = malloc((size_t)((long)got - take));
                if (p.data) {
                    memcpy(p.data, buf + take, (size_t)((long)got - take));
                    p.len = (long)got - take;
                }
            }
        }
    }
emit_end:
    free(p.data);
    char end[64];
    snprintf(end, sizeof(end), "{\"event\":\"http.end\",\"callId\":%d}", call_id);
    dsh_spike_gateway_event(b->spike, end);
    return;
fail:
    free(p.data);
    fprintf(stderr, "smoke: http body stream failed\n");
    b->failed = 1;
}

/* The httpFetch primitive: loopback POST/GET with real sockets. Header phase
 * settles the call (bodyId/status/headers); the body streams as http.body
 * events. Connect errors reject the call (contract "io"); mid-body failures
 * fail the driver (the scenario cannot continue on a broken transport). */
static void smoke_http_fetch(smoke_backend *b, int call_id, const char *args) {
    char err[256];
    char *url = json_str_dup(args, "url");
    char *method = json_str_dup(args, "method");
    char *body_b64 = json_str_dup(args, "bodyB64");
    char headers[2048];
    int port = 0;
    char path[512];
    unsigned char *body = NULL;
    size_t body_len = 0;
    int fd = -1;
    char *head = NULL;
    long head_len = 0;
    long received = 0;
    if (!url || !method) {
        smoke_reject(b, call_id, "httpFetch", "invalid", "missing url/method");
        goto done;
    }
    if (http_parse_url(url, &port, path, sizeof(path), err, sizeof(err)) != 0) {
        smoke_reject(b, call_id, "httpFetch", "invalid", err);
        goto done;
    }
    if (http_headers_from_args(args, headers, sizeof(headers), err, sizeof(err)) != 0) {
        smoke_reject(b, call_id, "httpFetch", "invalid", err);
        goto done;
    }
    if (body_b64) {
        body = b64_decode(body_b64, &body_len);
        if (!body) {
            smoke_reject(b, call_id, "httpFetch", "invalid", "cannot decode bodyB64");
            goto done;
        }
    }
    fd = http_connect_loopback(port, err, sizeof(err));
    if (fd < 0) {
        smoke_reject(b, call_id, "httpFetch", "io", err);
        goto done;
    }
    {
        char request[4096];
        int n = snprintf(request, sizeof(request),
                         "%s %s HTTP/1.1\r\n"
                         "host: 127.0.0.1:%d\r\n"
                         "connection: close\r\n"
                         "%s"
                         "content-length: %zu\r\n"
                         "\r\n",
                         method, path, port, headers, body_len);
        if (n < 0 || (size_t)n >= sizeof(request)
            || http_send_all(fd, request, (size_t)n, err, sizeof(err)) != 0
            || (body_len > 0 && http_send_all(fd, (const char *)body, body_len, err, sizeof(err)) != 0)) {
            smoke_reject(b, call_id, "httpFetch", "io", err[0] ? err : "request send failed");
            goto done;
        }
    }
    if (http_read_head(fd, &head, &head_len, &received, err, sizeof(err)) != 0) {
        smoke_reject(b, call_id, "httpFetch", "io", err[0] ? err : "no response head");
        goto done;
    }
    {
        int status = 0;
        char headers_json[4096];
        if (http_parse_head(head, &status, headers_json,
                            sizeof(headers_json), err, sizeof(err)) != 0) {
            smoke_reject(b, call_id, "httpFetch", "io", err);
            goto done;
        }
        char payload[4352];
        snprintf(payload, sizeof(payload),
                 "{\"bodyId\":\"body:%d\",\"status\":%d,\"headers\":%s}",
                 call_id, status, headers_json);
        smoke_settle(b, call_id, 1, payload);
        http_stream_body(b, call_id, fd, head, head_len, received - head_len);
    }
done:
    if (fd >= 0) close(fd);
    free(head);
    free(body);
    free(url);
    free(method);
    free(body_b64);
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
    if (strcmp(name, "httpFetch") == 0 && b->http) return smoke_http_fetch(b, call_id, args);
    if (strcmp(name, "httpFetch.abort") == 0 && b->http) {
        /* loopback requests complete synchronously inside one drain pass, so
         * there is never an in-flight call left to cancel by the time JS
         * aborts — the shim's local cancelled-error path covers it. */
        return;
    }
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

    /* Flags: --http enables the loopback httpFetch backend (descriptor gains
     * the primitive); --env KEY=VALUE (repeatable) feeds the launch-env
     * snapshot the scenario merges into its profile container. Values pass
     * through unescaped — reject quotes/backslashes instead of escaping. */
    int http = 0;
    char env_json[2048] = "{";
    size_t env_len = 1;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--http") == 0) {
            http = 1;
            continue;
        }
        if (strncmp(argv[i], "--env ", 6) == 0 || strcmp(argv[i], "--env") == 0) {
            const char *kv = argv[i][5] == ' ' ? argv[i] + 6
                             : (i + 1 < argc ? argv[++i] : NULL);
            if (!kv) {
                fprintf(stderr, "spike: --env needs KEY=VALUE\n");
                return 2;
            }
            const char *eq = strchr(kv, '=');
            if (!eq || eq == kv || strchr(kv, '"') || strchr(kv, '\\')
                || (size_t)(eq - kv) > 128 || strlen(eq + 1) > 512) {
                fprintf(stderr, "spike: --env needs plain KEY=VALUE (no quotes/backslashes)\n");
                return 2;
            }
            int n = snprintf(env_json + env_len, sizeof(env_json) - env_len,
                             "%s%.*s\":\"%s\"", env_len > 1 ? ",\"" : "\"",
                             (int)(eq - kv), kv, eq + 1);
            if (n < 0 || (size_t)n >= sizeof(env_json) - env_len) {
                fprintf(stderr, "spike: launch env snapshot overflow\n");
                return 2;
            }
            env_len += (size_t)n;
            continue;
        }
        fprintf(stderr, "spike: unknown argument '%s'\n", argv[i]);
        return 2;
    }
    snprintf(env_json + env_len, sizeof(env_json) - env_len, "}");

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
    signal(SIGPIPE, SIG_IGN);
    b.http = http;
    dsh_spike_set_gateway_dispatch(b.spike, smoke_on_call, &b);
    dsh_spike_set_descriptor(b.spike, http
        ? "{\"available\":[\"fsRead\",\"fsWrite\",\"fsScope\",\"httpFetch\"],"
          "\"unavailable\":[\"notify\",\"presentApproval\",\"presentPicker\","
          "\"keychainGet\",\"keychainSet\"]}"
        : SMOKE_DESCRIPTOR);
    dsh_spike_set_launch_env(b.spike, env_json);

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
