/* dsh_socket.c — the loopback socket seam's whole implementation. See
 * dsh_socket.h for the ABI, the security invariants and the thread rules;
 * this file adds only the POSIX/BSD plumbing.
 *
 * Shape notes for the editor-level C parser this repository runs on gates
 * (the dsh_wasm.c lesson): plain C, no function definitions inside macro
 * invocations, tables as fixed arrays.
 */
#include "dsh_socket.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define DSH_SOCKET_MAX_SERVERS 8
#define DSH_SOCKET_MAX_CONNS 32
/* Per-connection write-backpressure park (the pty slot's buffer size). */
#define DSH_SOCKET_WRITE_CAP (256u * 1024u)
/* One poll's read ceiling: 64 KiB of payload before the pump comes back. */
#define DSH_SOCKET_READ_CHUNK 65536
#define DSH_SOCKET_B64_CHUNK ((DSH_SOCKET_READ_CHUNK + 2) / 3 * 4 + 4)

typedef struct {
    int used;
    int fd; /* listening socket */
    char id[16];
} dsh_sock_server;

typedef struct {
    int used;
    int fd; /* -1 once closed */
    char id[16];
    int connecting;   /* non-blocking connect not yet completed */
    int connect_err;  /* SO_ERROR once the dial failed */
    int eof;          /* peer half-closed / read side exhausted */
    int write_closed; /* the caller asked for a half-close (end) */
    int ended;        /* the shutdown(SHUT_WR) has been performed */
    unsigned char *pending;
    size_t pending_n;
} dsh_sock_conn;

static dsh_sock_server g_servers[DSH_SOCKET_MAX_SERVERS];
static dsh_sock_conn g_conns[DSH_SOCKET_MAX_CONNS];
static int g_next_id;
static void (*g_audit)(const char *json_line);

void dsh_socket_audit_set(void (*sink)(const char *json_line)) {
    g_audit = sink;
}

/* The default sink keeps the audit mandatory even for a host that forgot to
 * wire one (contract §6: audit is mandatory and host-fixed). */
static void audit_stderr(const char *json_line) {
    fprintf(stderr, "%s\n", json_line);
}

static void audit_emit(const char *json_line) {
    void (*sink)(const char *) = g_audit ? g_audit : audit_stderr;
    sink(json_line);
}

static void set_err(char *err, size_t cap, const char *message) {
    if (err != NULL && cap > 0) snprintf(err, cap, "%s", message);
}

static void id_for(char *out, size_t cap, const char *prefix) {
    snprintf(out, cap, "%s:%d", prefix, ++g_next_id);
}

static int set_nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static dsh_sock_server *server_by_id(const char *id) {
    if (id == NULL) return NULL;
    for (int i = 0; i < DSH_SOCKET_MAX_SERVERS; i++) {
        if (g_servers[i].used && strcmp(g_servers[i].id, id) == 0) return &g_servers[i];
    }
    return NULL;
}

static dsh_sock_conn *conn_by_id(const char *id) {
    if (id == NULL) return NULL;
    for (int i = 0; i < DSH_SOCKET_MAX_CONNS; i++) {
        if (g_conns[i].used && strcmp(g_conns[i].id, id) == 0) return &g_conns[i];
    }
    return NULL;
}

int dsh_socket_alive(void) {
    int n = 0;
    for (int i = 0; i < DSH_SOCKET_MAX_SERVERS; i++) n += g_servers[i].used ? 1 : 0;
    for (int i = 0; i < DSH_SOCKET_MAX_CONNS; i++) n += g_conns[i].used ? 1 : 0;
    return n;
}

void dsh_socket_close_all(void) {
    for (int i = 0; i < DSH_SOCKET_MAX_SERVERS; i++) {
        if (!g_servers[i].used) continue;
        if (g_servers[i].fd >= 0) close(g_servers[i].fd);
        g_servers[i].used = 0;
    }
    for (int i = 0; i < DSH_SOCKET_MAX_CONNS; i++) {
        if (!g_conns[i].used) continue;
        if (g_conns[i].fd >= 0) close(g_conns[i].fd);
        free(g_conns[i].pending);
        g_conns[i].used = 0;
    }
}

/* ---- minimal base64 (encode only; the pump hands JS base64 chunks) ------ */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const unsigned char *bytes, size_t len) {
    char *out = malloc(((len + 2) / 3) * 4 + 1);
    if (out == NULL) return NULL;
    size_t at = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned v = (unsigned)bytes[i] << 16;
        int rem = (int)(len - i);
        if (rem > 1) v |= (unsigned)bytes[i + 1] << 8;
        if (rem > 2) v |= bytes[i + 2];
        out[at++] = B64[(v >> 18) & 63];
        out[at++] = B64[(v >> 12) & 63];
        out[at++] = rem > 1 ? B64[(v >> 6) & 63] : '=';
        out[at++] = rem > 2 ? B64[v & 63] : '=';
    }
    out[at] = '\0';
    return out;
}

/* ---- listen / connect ---------------------------------------------------- */

int dsh_socket_listen(int port, char *server_id_out, size_t cap,
                      int *bound_port, char *err, size_t errcap) {
    if (port < 0 || port > 65535) {
        set_err(err, errcap, "socketListen: port must be within 0-65535");
        return -1;
    }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        set_err(err, errcap, "socketListen: socket() failed");
        return -1;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    /* The invariant: INADDR_LOOPBACK and nothing else — the host may never
     * widen the bind past the grant class it served (rule 2, by construction). */
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((unsigned short)port);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        snprintf(err, errcap, "socketListen: bind 127.0.0.1:%d failed (%s)",
                 port, strerror(errno));
        close(fd);
        return -1;
    }
    if (listen(fd, 16) < 0) {
        set_err(err, errcap, "socketListen: listen() failed");
        close(fd);
        return -1;
    }
    if (set_nonblock(fd) < 0) {
        set_err(err, errcap, "socketListen: cannot go non-blocking");
        close(fd);
        return -1;
    }
    struct sockaddr_in got;
    socklen_t got_len = sizeof(got);
    if (getsockname(fd, (struct sockaddr *)&got, &got_len) < 0) {
        set_err(err, errcap, "socketListen: getsockname failed");
        close(fd);
        return -1;
    }
    dsh_sock_server *slot = NULL;
    for (int i = 0; i < DSH_SOCKET_MAX_SERVERS; i++) {
        if (!g_servers[i].used) { slot = &g_servers[i]; break; }
    }
    if (slot == NULL) {
        set_err(err, errcap, "socketListen: server table full");
        close(fd);
        return -1;
    }
    slot->used = 1;
    slot->fd = fd;
    id_for(slot->id, sizeof(slot->id), "srv");
    snprintf(server_id_out, cap, "%s", slot->id);
    *bound_port = ntohs(got.sin_port);
    char line[192];
    snprintf(line, sizeof(line),
             "{\"audit\":\"socket.listen\",\"direction\":\"inbound\","
             "\"grant\":\"socket.listen.loopback\",\"scope\":\"loopback\","
             "\"port\":%d,\"outcome\":\"granted\"}", *bound_port);
    audit_emit(line);
    return 0;
}

int dsh_socket_connect(const char *host, int port, char *conn_id_out,
                       size_t cap, char *err, size_t errcap) {
    /* The literal loopback spelling ONLY — a hostname, ::1, 127.0.0.2 or a
     * LAN address is out of the v0 grant class (rule 2), refused here even
     * if the serve layer was ever wired to pass one through. */
    if (host == NULL || strcmp(host, "127.0.0.1") != 0) {
        set_err(err, errcap, "socketConnect: only the literal 127.0.0.1 is dialable (loopback scope)");
        return -1;
    }
    if (port <= 0 || port > 65535) {
        set_err(err, errcap, "socketConnect: port must be within 1-65535");
        return -1;
    }
    dsh_sock_conn *slot = NULL;
    for (int i = 0; i < DSH_SOCKET_MAX_CONNS; i++) {
        if (!g_conns[i].used) { slot = &g_conns[i]; break; }
    }
    if (slot == NULL) {
        set_err(err, errcap, "socketConnect: connection table full");
        return -1;
    }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        set_err(err, errcap, "socketConnect: socket() failed");
        return -1;
    }
    if (set_nonblock(fd) < 0) {
        set_err(err, errcap, "socketConnect: cannot go non-blocking");
        close(fd);
        return -1;
    }
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((unsigned short)port);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 && errno != EINPROGRESS) {
        snprintf(err, errcap, "socketConnect: dial 127.0.0.1:%d failed (%s)",
                 port, strerror(errno));
        close(fd);
        return -1;
    }
    slot->used = 1;
    slot->fd = fd;
    slot->connecting = 1;
    slot->connect_err = 0;
    slot->eof = 0;
    slot->write_closed = 0;
    slot->ended = 0;
    slot->pending = NULL;
    slot->pending_n = 0;
    id_for(slot->id, sizeof(slot->id), "conn");
    snprintf(conn_id_out, cap, "%s", slot->id);
    char line[192];
    snprintf(line, sizeof(line),
             "{\"audit\":\"socket.connect\",\"direction\":\"outbound\","
             "\"grant\":\"socket.connect.loopback\",\"peer\":\"127.0.0.1:%d\","
             "\"outcome\":\"granted\"}", port);
    audit_emit(line);
    return 0;
}

/* ---- poll ---------------------------------------------------------------- */

static void conn_finish_connect(dsh_sock_conn *c) {
    int so_err = 0;
    socklen_t len = sizeof(so_err);
    getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &so_err, &len);
    c->connect_err = so_err;
    c->connecting = 0;
}

/* Accept every queued connection into fresh slots; returns the JSON array
 * fragment the caller splices in (malloc'd) — "[]" when nothing queued. */
static char *server_accept_all(dsh_sock_server *sv) {
    char *out = malloc(64 + DSH_SOCKET_MAX_CONNS * 48);
    if (out == NULL) return NULL;
    size_t at = 0;
    out[at++] = '[';
    for (;;) {
        struct sockaddr_in peer;
        socklen_t peer_len = sizeof(peer);
        int fd = accept(sv->fd, (struct sockaddr *)&peer, &peer_len);
        if (fd < 0) break; /* EAGAIN — queue drained (or real error: same face) */
        dsh_sock_conn *slot = NULL;
        for (int i = 0; i < DSH_SOCKET_MAX_CONNS; i++) {
            if (!g_conns[i].used) { slot = &g_conns[i]; break; }
        }
        if (slot == NULL) {
            /* Table full: refuse THIS connection honestly, keep the server. */
            close(fd);
            continue;
        }
        set_nonblock(fd);
        slot->used = 1;
        slot->fd = fd;
        slot->connecting = 0;
        slot->connect_err = 0;
        slot->eof = 0;
        slot->write_closed = 0;
        slot->ended = 0;
        slot->pending = NULL;
        slot->pending_n = 0;
        id_for(slot->id, sizeof(slot->id), "conn");
        int peer_port = ntohs(peer.sin_port);
        char line[192];
        snprintf(line, sizeof(line),
                 "{\"audit\":\"socket.accept\",\"direction\":\"inbound\","
                 "\"grant\":\"socket.listen.loopback\",\"serverId\":\"%s\","
                 "\"connectionId\":\"%s\",\"peer\":\"127.0.0.1:%d\","
                 "\"outcome\":\"granted\"}", sv->id, slot->id, peer_port);
        audit_emit(line);
        at += (size_t)snprintf(out + at, 48, "%s{\"connectionId\":\"%s\",\"peerPort\":%d}",
                               at > 1 ? "," : "", slot->id, peer_port);
    }
    out[at++] = ']';
    out[at] = '\0';
    return out;
}

static char *conn_poll_json(dsh_sock_conn *c) {
    if (c->connecting) conn_finish_connect(c);
    /* A FAILED dial is TERMINAL: report connected:false / eof:true with the
     * SO_ERROR errno and release the slot right here — the JS pump turns
     * this poll into the node connect-failure face ('error' ECONNREFUSED
     * then 'close') and stops re-arming, so neither side holds a dead id
     * and dsh_socket_alive() drops back to the truth. Leaving the slot with
     * eof:false here would hold the pump (and the run loop) forever. */
    if (c->connect_err != 0) {
        char *out = malloc(128);
        if (out == NULL) return NULL;
        snprintf(out, 128,
                 "{\"kind\":\"connection\",\"connected\":false,\"chunkB64\":null,"
                 "\"eof\":true,\"pendingWrite\":0,\"flushError\":null,"
                 "\"dialError\":%d}", c->connect_err);
        close(c->fd);
        free(c->pending);
        c->pending = NULL;
        c->pending_n = 0;
        c->fd = -1;
        c->used = 0;
        return out;
    }
    int flush_err = 0;
    if (c->fd >= 0 && !c->connecting && c->connect_err == 0) {
        /* Drain the write-backpressure park first (the pty discipline); a
         * pending half-close performs its shutdown only once the tail is on
         * the wire — the FIN must never jump the queued bytes. */
        while (c->pending_n > 0) {
            ssize_t w = write(c->fd, c->pending, c->pending_n);
            if (w > 0) {
                memmove(c->pending, c->pending + w, c->pending_n - (size_t)w);
                c->pending_n -= (size_t)w;
                continue;
            }
            if (w < 0 && errno == EINTR) continue;
            if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
            flush_err = errno ? errno : EIO;
            break;
        }
        if (c->write_closed && !c->ended && c->pending_n == 0) {
            if (shutdown(c->fd, SHUT_WR) == 0 || errno == ENOTCONN) c->ended = 1;
        }
    }
    char *b64 = NULL;
    int eof = c->eof;
    if (c->fd >= 0 && !c->connecting && c->connect_err == 0 && !eof) {
        unsigned char buf[DSH_SOCKET_READ_CHUNK];
        size_t total = 0;
        for (;;) {
            ssize_t r = recv(c->fd, buf + total, sizeof(buf) - total, 0);
            if (r > 0) {
                total += (size_t)r;
                if (total == sizeof(buf)) break;
                continue;
            }
            if (r == 0) { eof = 1; c->eof = 1; break; }
            if (errno == EINTR) continue;
            break; /* EAGAIN — nothing more this tick */
        }
        if (total > 0) b64 = b64_encode(buf, total);
    }
    char flush[24];
    if (flush_err != 0) snprintf(flush, sizeof(flush), "%d", flush_err);
    else snprintf(flush, sizeof(flush), "null");
    const char *connected = (c->connect_err == 0 && !c->connecting) ? "true" : "false";
    const char *eof_s = eof ? "true" : "false";
    size_t need = 160 + (b64 != NULL ? strlen(b64) : 0);
    char *out = malloc(need);
    if (out == NULL) {
        free(b64);
        return NULL;
    }
    snprintf(out, need,
             "{\"kind\":\"connection\",\"connected\":%s,\"chunkB64\":%s%s%s,"
             "\"eof\":%s,\"pendingWrite\":%d,\"flushError\":%s}",
             connected,
             b64 != NULL ? "\"" : "", b64 != NULL ? b64 : "null", b64 != NULL ? "\"" : "",
             eof_s, (int)c->pending_n, flush);
    free(b64);
    return out;
}

char *dsh_socket_poll(const char *id, char *err, size_t errcap) {
    dsh_sock_server *sv = server_by_id(id);
    if (sv != NULL) {
        char *accepted = server_accept_all(sv);
        if (accepted == NULL) {
            set_err(err, errcap, "socket poll: out of memory");
            return NULL;
        }
        char *out = malloc(strlen(accepted) + 48);
        if (out == NULL) {
            free(accepted);
            set_err(err, errcap, "socket poll: out of memory");
            return NULL;
        }
        snprintf(out, strlen(accepted) + 48,
                 "{\"kind\":\"server\",\"accepted\":%s}", accepted);
        free(accepted);
        return out;
    }
    dsh_sock_conn *c = conn_by_id(id);
    if (c != NULL) return conn_poll_json(c);
    set_err(err, errcap, "socket poll: unknown id");
    return NULL;
}

/* ---- write / end / close -------------------------------------------------- */

int dsh_socket_write(const char *id, const unsigned char *bytes, size_t len,
                     int *written, int *buffered, char *err, size_t errcap) {
    dsh_sock_conn *c = conn_by_id(id);
    if (c == NULL || c->fd < 0) {
        set_err(err, errcap, "socketWrite: unknown or closed connection");
        return -1;
    }
    if (c->connecting) conn_finish_connect(c);
    if (c->connecting || c->connect_err != 0) {
        set_err(err, errcap, "socketWrite: connection not established");
        return -1;
    }
    if (c->write_closed) {
        set_err(err, errcap, "socketWrite: write side already ended");
        return -1;
    }
    size_t done = 0;
    while (done < len) {
        ssize_t w = write(c->fd, bytes + done, len - done);
        if (w > 0) { done += (size_t)w; continue; }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        snprintf(err, errcap, "socketWrite: write failed (%s)", strerror(errno));
        return -1;
    }
    size_t parked = len - done;
    if (parked > 0) {
        if (c->pending_n + parked > DSH_SOCKET_WRITE_CAP) {
            set_err(err, errcap, "socketWrite: backpressure buffer full");
            return -1;
        }
        unsigned char *grown = realloc(c->pending, c->pending_n + parked);
        if (grown == NULL) {
            set_err(err, errcap, "socketWrite: out of memory");
            return -1;
        }
        c->pending = grown;
        memcpy(c->pending + c->pending_n, bytes + done, parked);
        c->pending_n += parked;
    }
    *written = (int)done;
    *buffered = (int)c->pending_n;
    return 0;
}

int dsh_socket_write_b64(const char *id, const char *b64,
                         int *written, int *buffered, char *err, size_t errcap) {
    if (b64 == NULL) {
        set_err(err, errcap, "socketWrite: bytesB64 missing");
        return -1;
    }
    size_t n = strlen(b64);
    if (n % 4 != 0) {
        set_err(err, errcap, "socketWrite: bytesB64 is not valid base64");
        return -1;
    }
    size_t max = n / 4 * 3;
    unsigned char *bytes = malloc(max > 0 ? max : 1);
    if (bytes == NULL) {
        set_err(err, errcap, "socketWrite: out of memory");
        return -1;
    }
    size_t at = 0;
    int pad = 0;
    for (size_t i = 0; i < n; i += 4) {
        int v[4];
        for (int k = 0; k < 4; k++) {
            char c = b64[i + k];
            if (c == '=') { /* padding: legal only in the last two slots */
                if (k < 2) {
                    free(bytes);
                    set_err(err, errcap, "socketWrite: bytesB64 is not valid base64");
                    return -1;
                }
                v[k] = 0;
                continue;
            }
            const char *p = strchr(B64, c);
            if (p == NULL || c == '\0') {
                free(bytes);
                set_err(err, errcap, "socketWrite: bytesB64 is not valid base64");
                return -1;
            }
            v[k] = (int)(p - B64);
        }
        if (b64[i + 2] == '=') pad++;
        if (b64[i + 3] == '=') pad++;
        if (pad > 2) {
            free(bytes);
            set_err(err, errcap, "socketWrite: bytesB64 is not valid base64");
            return -1;
        }
        unsigned word = ((unsigned)v[0] << 18) | ((unsigned)v[1] << 12)
            | ((unsigned)v[2] << 6) | (unsigned)v[3];
        if (at < max) bytes[at++] = (unsigned char)(word >> 16);
        if (pad < 2 && at < max) bytes[at++] = (unsigned char)(word >> 8);
        if (pad < 1 && at < max) bytes[at++] = (unsigned char)word;
    }
    int rc = dsh_socket_write(id, bytes, at, written, buffered, err, errcap);
    free(bytes);
    return rc;
}

int dsh_socket_end(const char *id, char *err, size_t errcap) {
    dsh_sock_conn *c = conn_by_id(id);
    if (c == NULL || c->fd < 0) {
        set_err(err, errcap, "socketEnd: unknown or closed connection");
        return -1;
    }
    /* The parked tail flushes on the next pump tick; the shutdown happens
     * there (empty park) or right here (nothing parked) — the FIN never
     * jumps the queued bytes. */
    c->write_closed = 1;
    if (c->pending_n == 0 && !c->ended) {
        if (shutdown(c->fd, SHUT_WR) < 0 && errno != ENOTCONN) {
            snprintf(err, errcap, "socketEnd: shutdown failed (%s)", strerror(errno));
            return -1;
        }
        c->ended = 1;
    }
    return 0;
}

int dsh_socket_close(const char *id, char *err, size_t errcap) {
    dsh_sock_server *sv = server_by_id(id);
    if (sv != NULL) {
        close(sv->fd);
        sv->fd = -1;
        sv->used = 0; /* listener gone; its live connections stay addressable */
        return 0;
    }
    dsh_sock_conn *c = conn_by_id(id);
    if (c == NULL) {
        set_err(err, errcap, "socketClose: unknown id");
        return -1;
    }
    if (c->fd >= 0) close(c->fd);
    c->fd = -1;
    free(c->pending);
    c->pending = NULL;
    c->pending_n = 0;
    c->used = 0;
    return 0;
}
