/* dsh_socket.h — the loopback socket seam (contract v1.8.0, decision D-d).
 *
 * The C core of `socketListen` / `socketConnect` + the per-socket data face:
 * audited LOOPBACK-ONLY TCP under the five-rule model of the adopted proposal
 * (contract/proposals/2026-09-28-socket-seam.md). This file is the whole
 * policy; the gateway serve layer (main_cli.c on the desktop CLI) owns the
 * grant checks and the descriptor.
 *
 * Portability: plain POSIX/BSD sockets, no engine dependencies (the same
 * "portable C, the spine carries it" rule as dsh_wasm.c) — the per-host
 * builds compile it, and a host whose gateway layer does not SERVE the
 * socket primitives simply answers `unavailable` (negotiation, not a branch).
 *
 * Threading: the gateway dispatches onto the runtime's serial queue, so the
 * table needs no lock (ARCHITECTURE.md §6) — one runtime at a time, the same
 * discipline as dsh_wasm.c's sink.
 *
 * Security invariants (fail loud, never silently widen):
 *   - `dsh_socket_listen` binds INADDR_LOOPBACK and nothing else; a port
 *     of 0 makes the OS pick and the bound port is reported back.
 *   - `dsh_socket_connect` refuses any host spelling other than the literal
 *     "127.0.0.1" at THIS layer too (defense in depth: the serve layer has
 *     already validated the request against the grant class).
 *   - Every listen/connect/accepted connection emits one structured audit
 *     record through the sink below (contract §6: structured records, never
 *     payload bytes).
 */

#ifndef DSH_SOCKET_H
#define DSH_SOCKET_H

#include <stddef.h>

/* One audit record (JSON line, no trailing newline) per security-relevant
 * socket event. The host injects its own sink (CLI: one stderr line);
 * the default sink is fprintf(stderr) so a host that stays silent about
 * wiring the sink still produces the records (rule 5). */
void dsh_socket_audit_set(void (*sink)(const char *json_line));

/* Bind a loopback listener. port 0 = host picks. On success returns 0, fills
 * server_id_out ("srv:N", NUL-terminated) and *bound_port. Returns -1 with
 * err filled on any failure (bad port, bind, listen). */
int dsh_socket_listen(int port, char *server_id_out, size_t cap,
                      int *bound_port, char *err, size_t errcap);

/* Dial a loopback endpoint. host MUST be the literal "127.0.0.1" (refused
 * otherwise). The dial is non-blocking: success means the connection is
 * IN PROGRESS and completes on the pump (dsh_socket_poll reports
 * "connected"/"failed"). Returns 0 and fills conn_id_out ("conn:N"); -1 with
 * err filled when the dial cannot even start. */
int dsh_socket_connect(const char *host, int port, char *conn_id_out,
                       size_t cap, char *err, size_t errcap);

/* One non-blocking pass, the pump contract the JS pump drives every few ms
 * (the same shape the child-process/pty polls serve):
 *   - server id  → {"kind":"server","accepted":[{"connectionId":"conn:N",
 *                  "peerPort":P}...]} — every currently-accepted connection,
 *                  then the slot forgets them.
 *   - conn id    → {"kind":"connection","connected":bool,"chunkB64":str|null,
 *                  "eof":bool,"pendingWrite":N,"flushError":int|null}
 *                  (pendingWrite/flushError surface the write-backpressure
 *                  buffer's drain, mirroring the pty poll).
 * Returns a malloc'd JSON string (caller frees) or NULL with err filled for
 * an unknown id. */
char *dsh_socket_poll(const char *id, char *err, size_t errcap);

/* Write bytes to a connection. Refused tail parks in the slot's backpressure
 * buffer and drains on the pump's poll ticks. On success the written and
 * buffered counts are set. Returns 0, or -1 with err filled (unknown id, dead
 * peer). */
int dsh_socket_write(const char *id, const unsigned char *bytes, size_t len,
                     int *written, int *buffered, char *err, size_t errcap);

/* The gateway serve layer's spelling of socketWrite: base64 in (the bridge's
 * wire encoding), everything else identical to dsh_socket_write. The decoder
 * is strict (alphabet + padding) and rejects in place. */
int dsh_socket_write_b64(const char *id, const char *b64,
                         int *written, int *buffered, char *err, size_t errcap);
int dsh_socket_write(const char *id, const unsigned char *bytes, size_t len,
                     int *written, int *buffered, char *err, size_t errcap);

/* Half-close a connection (shutdown(SHUT_WR)): the peer reads the trailing
 * bytes then sees EOF; our read side stays open. Returns 0, or -1 with err. */
int dsh_socket_end(const char *id, char *err, size_t errcap);

/* Close a server (its listener fd only — live connections stay addressable,
 * node's server.close semantics) or a connection. Returns 0, or -1. */
int dsh_socket_close(const char *id, char *err, size_t errcap);

/* Live servers + connections — the run loop's quiescence check (a listener
 * with nobody polling keeps the loop alive, mirroring dsh_spike_procs_alive).
 * Also nonzero while any connect is still in progress. */
int dsh_socket_alive(void);

/* Teardown: close every fd and free every slot (dsh_spike_free's socket
 * mirror of the SIGKILL-and-reap child sweep). */
void dsh_socket_close_all(void);

#endif /* DSH_SOCKET_H */
