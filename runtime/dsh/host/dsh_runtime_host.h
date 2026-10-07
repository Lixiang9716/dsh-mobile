/*
 * dsh_runtime_host.h — embeddable M2 rt host for quickjs-ng (platform-
 * neutral C). Every platform host (macOS CLI, iOS, Android, HarmonyOS NAPI)
 * links this one file plus the vendored quickjs-ng sources and drives the
 * runtime from a SINGLE thread: eval, then pump until the scenario
 * completes. There is no other threading model in the rt (ARCHITECTURE.md
 * §6 thread rules).
 */
#ifndef DSH_SPIKE_HOST_H
#define DSH_SPIKE_HOST_H

#include <stddef.h>

/* Plain C interface only — C++ embedders wrap this header in extern "C"
 * themselves. (No #ifdef __cplusplus guard: the syntax-class checker's
 * tree-sitter C grammar misparses the preprocessor/brace interleave, and
 * the rt has no C++ embedder to serve.) */

typedef struct dsh_runtime dsh_runtime_t;

/* Receives each canonical E2E line, already prefixed "dsh.spike.log: ".
 * Platforms print it to their native log (NSLog / logcat / hilog) or stdout
 * (CLI). Called only from the thread that drives the runtime. */
typedef struct dsh_runtime_sink {
    void (*on_log)(void *ud, const char *line);
    void *ud;
} dsh_runtime_sink;

/* bundle_root: directory containing logger.js, gateway.js, manifest.json,
 * scenario/, vendor/ (the checkout's runtime/dsh/). Returns NULL on init
 * failure (details via dsh_runtime_error on a fresh struct is impossible —
 * check stderr/errno at the call site; init failures are embedder bugs, not
 * scenario outcomes). */
dsh_runtime_t *dsh_runtime_new(const char *bundle_root, const dsh_runtime_sink *sink);

/* Compile+run the entry module from source (the embedder reads the file —
 * or embeds it as a resource — wherever its platform stores it).
 * module_name is the entry's bundle-root-relative path; relative imports
 * inside the module resolve against it. 0 ok, -1 JS exception. */
int dsh_runtime_eval(dsh_runtime_t *s, const char *module_name, const char *source);

/* Drain microtasks until quiescent. Gateway settlement now happens through
 * dsh_runtime_gateway_settle / dsh_runtime_gateway_event, not inside pump.
 * 0 ok (scenario may or may not have completed yet), -1 JS exception. */
int dsh_runtime_pump(dsh_runtime_t *s);

int dsh_runtime_complete(const dsh_runtime_t *s); /* scenario called __dshComplete */
int dsh_runtime_pass(const dsh_runtime_t *s);     /* its pass flag */

/* Last C-side failure description (eval/pump/settle/event/new), or "" —
 * valid until free. */
const char *dsh_runtime_error(const dsh_runtime_t *s);

/* ---- gateway bridge (contract/ v1.0.0, real dispatch) -------------------
 * JS calls globalThis.__dshGatewayCall(name, argsJson) and gets a Promise;
 * the host assigns a monotonic call_id (from 1) and reports the call here.
 * on_call fires SYNCHRONOUSLY ON THE RUNTIME THREAD during the call — hop
 * to your transport queue there, never block. Multiple calls may be in
 * flight simultaneously. Bytes travel base64 in fields ending B64; errors
 * are objects {"code","primitive","message"}. */

typedef void (*dsh_runtime_gateway_fn)(void *ud, int call_id, const char *name,
                                     const char *args_json);

/* Register BEFORE eval (typically before dsh_runtime_new's eval sibling).
 * args_json is the JSON.stringify'd argument object, NUL-terminated UTF-8. */
void dsh_runtime_set_gateway_dispatch(dsh_runtime_t *s, dsh_runtime_gateway_fn on_call,
                                    void *ud);

/* Store the runtime descriptor JSON (e.g. {"available":[...],"unavailable":
 * [...]}) BEFORE eval; JS reads it verbatim via __dshGatewayDescriptor()
 * (which yields "null" when never set). Copies the string. */
void dsh_runtime_set_descriptor(dsh_runtime_t *s, const char *descriptor_json);

/* Store the launch environment snapshot (a JSON object of string KV pairs)
 * BEFORE eval; JS reads it verbatim via globalThis.__dshLaunchEnv() (yields
 * "{}" when never set). The CLI driver fills it from --env KEY=VALUE args;
 * scenarios merge it into their profile container so upstream-style
 * process.env sees the launch facts (e.g. the mock LLM endpoint). Copies. */
void dsh_runtime_set_launch_env(dsh_runtime_t *s, const char *env_json);

/* Settle one in-flight call: resolves (ok=1) / rejects (ok=0) the promise
 * stored for call_id with payload_json parsed as a JSON value ("null"
 * resolves null). Unknown or already-settled id → -1 (fail loud).
 * RUNTIME-THREAD-ONLY: must be called from the same thread that drives
 * eval/pump (dispatch your platform result onto that queue first). Drains
 * pending jobs after settling; -1 on JS exception. */
int dsh_runtime_gateway_settle(dsh_runtime_t *s, int call_id, int ok,
                             const char *payload_json);

/* Deliver one bridge event line (JSON text) into JS: calls the global
 * __dshGatewayOnEvent(eventJson) when the scenario subscribed (undefined
 * handler → 0, dropped, mirroring bus_deliver), then drains pending jobs.
 * RUNTIME-THREAD-ONLY (same rule as gateway_settle). -1 on JS exception. */
int dsh_runtime_gateway_event(dsh_runtime_t *s, const char *event_json);

/* ---- carrier message-bus seam (M1 local-carrier rt) ------------------
 * One JSON text line per crossing, both directions. JS posts to the host
 * via globalThis.__dshBusPost(line); the embedder receives it through the
 * callback registered here (on the thread that drives the runtime). The
 * embedder delivers into JS via dsh_runtime_bus_deliver — the scenario's
 * globalThis.__dshBusOnMessage(line) handler runs, then microtasks drain —
 * and MUST only call it from that same single thread (ARCHITECTURE.md §6). */

void dsh_runtime_set_bus_sink(dsh_runtime_t *s,
                            void (*on_bus)(void *ud, const char *line),
                            void *ud);

/* 0 ok (delivered, or no handler subscribed yet), -1 JS exception. */
int dsh_runtime_bus_deliver(dsh_runtime_t *s, const char *line);

/* Live slots in the subprocess seam's process table (spawned children not
 * yet reaped + drained). The CLI drive loop consults it so a run awaiting a
 * child does not tear down as quiescent (W5-R, 2026-09-28). */
int dsh_runtime_procs_alive(dsh_runtime_t *s);

void dsh_runtime_free(dsh_runtime_t *s);

#endif /* DSH_SPIKE_HOST_H */
