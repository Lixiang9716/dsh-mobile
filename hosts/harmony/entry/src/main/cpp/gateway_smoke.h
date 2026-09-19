/*
 * gateway_smoke.h — the HarmonyOS gateway-bridge smoke backend (M5).
 *
 * The platform twin of the desktop CLI driver's smoke backend
 * (runtime/spike/host/main_cli.c): it answers scenario m2.bridge.smoke
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

/* The includer must include dsh_spike_host.h FIRST — inside extern "C"
 * from C++ (that header carries no __cplusplus guard on purpose; see its
 * header comment). This header only reuses its types. */
#ifdef __cplusplus
extern "C" {
#endif

typedef struct dsh_smoke_backend dsh_smoke_backend_t;

/* RuntimeDescriptor served to JS via __dshGatewayDescriptor(): fs on the
 * app dir, everything else declared unavailable. */
extern const char *DSH_SMOKE_DESCRIPTOR;

/* Create the backend and its scope-"app" root directory. Returns NULL
 * when the directory cannot be created (fail loud — embedder bug). */
dsh_smoke_backend_t *dsh_smoke_new(const char *fs_root);

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

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DSH_GATEWAY_SMOKE_H */
