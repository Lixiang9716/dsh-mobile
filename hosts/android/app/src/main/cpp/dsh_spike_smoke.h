/*
 * dsh_spike_smoke.h — the gateway bridge smoke backend for the Android spike
 * (the JNI sibling of runtime/spike/host/main_cli.c's smoke backend).
 *
 * The Android host has NO gateway implementation of its own yet: fs
 * primitives run against an app-private directory exposed as scope "app";
 * every primitive the descriptor declares unavailable (keychainGet,
 * keychainSet, httpFetch, ...) rejects with the contract's honest
 * "unavailable" code; anything outside the descriptor rejects "invalid".
 * NO new primitives, NO contract changes (AGENTS.md rule 1).
 */
#ifndef DSH_SPIKE_SMOKE_H
#define DSH_SPIKE_SMOKE_H

#include <stddef.h>

#include "dsh_spike_host.h"

/* Drives ONE gateway-bridge scenario to completion on the CALLING thread
 * (the JS runtime thread — Kotlin keeps that a single HandlerThread):
 * fresh runtime, dispatch + descriptor registered, eval, then the
 * {pump -> drain} loop with deferred post-pump settlement (the exact
 * later-tick pattern main_cli.c proves on the desktop).
 *   source     entry module text (caller-read, e.g. from filesDir/spike)
 *   entry_name bundle-root-relative module name ("scenario/m2-bridge-smoke.js")
 *   fs_root    absolute directory backing gateway scope "app" (must exist)
 *   sink       receives each canonical "dsh.spike.log: " line
 * Returns 1 when the scenario completed and passed, 0 otherwise; err_out
 * (may be NULL/0) carries the failure description either way. */
int dsh_smoke_run(const char *bundle_root, const char *entry_name,
                  const char *source, const char *fs_root,
                  const dsh_spike_sink *sink, char *err_out, size_t err_out_sz);

#endif /* DSH_SPIKE_SMOKE_H */
