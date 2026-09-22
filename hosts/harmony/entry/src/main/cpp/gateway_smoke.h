/*
 * gateway_smoke.h — the HarmonyOS gateway-bridge smoke backend (M5).
 *
 * The platform twin of the desktop CLI driver's smoke backend
 * (runtime/spike/host/main_cli.c): it answers scenario gateway.bridge-smoke
 * over the REAL dsh_spike dispatch bridge — fs primitives on a
 * host-app directory exposed as scope "app", keychain honestly
 * "unavailable" (declared so in the descriptor), unknown primitives
 * "invalid". Calls are only QUEUED in the dispatch callback; settlement
 * is deferred to the post-pump drain pass (the later-tick pattern the
 * scenario exists to prove). All calls run on the single JS runtime
 * thread (ARCHITECTURE.md §6) — no locking.
 */
#ifndef DSH_GATEWAY_SMOKE_H
#define DSH_GATEWAY_SMOKE_H

/* Plain C interface only. The includer must include dsh_spike_host.h FIRST
 * (this header only reuses its types) and, from C++, wrap BOTH includes in
 * one extern "C" block — like dsh_spike_host.h, there is no #ifdef
 * __cplusplus guard on purpose: the syntax-class checker's tree-sitter C
 * grammar misparses the preprocessor/brace interleave. */

typedef struct dsh_smoke_backend dsh_smoke_backend_t;

/* RuntimeDescriptor served to JS via __dshGatewayDescriptor(): fs on the
 * app dir, everything else declared unavailable. */
extern const char *DSH_SMOKE_DESCRIPTOR;

/* Create the backend and its scope-"app" root directory. Returns NULL
 * when the directory cannot be created (fail loud — embedder bug). */
dsh_smoke_backend_t *dsh_smoke_new(const char *fs_root);

/* Binding-mode extension (M5 host-binding phase). The forward hook receives
 * the platform primitives the ArkTS capability layer serves for real
 * (notify / presentApproval) and is consulted BEFORE the local table; with
 * an override descriptor the host also declares presentPicker +
 * keychainGet/Set + httpFetch honestly unavailable and serves fsScope
 * persist/resolve strictly on the app scope (the documented v1: persist =
 * resolve to the app files scope). Both setters must be called BEFORE
 * dsh_smoke_attach. The hook fires on the runtime thread inside the JS
 * call — hop to your capability queue there, never re-enter the runtime. */
typedef void (*dsh_smoke_forward_fn)(void *ud, int call_id, const char *name,
                                     const char *args_json);

void dsh_smoke_set_forward(dsh_smoke_backend_t *b, dsh_smoke_forward_fn fn,
                           void *ud);

/* Override the descriptor attach serves (binding mode: 5 available /
 * 4 unavailable). Copies the string. */
void dsh_smoke_set_descriptor_json(dsh_smoke_backend_t *b,
                                   const char *descriptor_json);

/* Register the dispatch callback + descriptor on the spike. Call BEFORE
 * dsh_spike_eval. */
void dsh_smoke_attach(dsh_smoke_backend_t *b, dsh_spike_t *spike);

/* Serve every queued call (settling each on the runtime thread). Returns
 * the number served, or -1 when a settlement failed (details via
 * dsh_spike_error). */
int dsh_smoke_drain(dsh_smoke_backend_t *b);

/* 1 once any settlement failed — the run must fail loud. */
int dsh_smoke_failed(const dsh_smoke_backend_t *b);

void dsh_smoke_free(dsh_smoke_backend_t *b);

#endif /* DSH_GATEWAY_SMOKE_H */
