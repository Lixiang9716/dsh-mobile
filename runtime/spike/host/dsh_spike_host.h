/*
 * dsh_spike_host.h — embeddable M1 spike host for quickjs-ng (platform-
 * neutral C). Every platform host (macOS CLI, iOS, Android, HarmonyOS NAPI)
 * links this one file plus the vendored quickjs-ng sources and drives the
 * runtime from a SINGLE thread: eval, then pump until the scenario
 * completes. There is no other threading model in the spike (ARCHITECTURE.md
 * §6 thread rules).
 */
#ifndef DSH_SPIKE_HOST_H
#define DSH_SPIKE_HOST_H

#include <stddef.h>

/* Plain C interface only — C++ embedders wrap this header in extern "C"
 * themselves. (No #ifdef __cplusplus guard: the syntax-class checker's
 * tree-sitter C grammar misparses the preprocessor/brace interleave, and
 * the spike has no C++ embedder to serve.) */

typedef struct dsh_spike dsh_spike_t;

/* Receives each canonical E2E line, already prefixed "dsh.spike.log: ".
 * Platforms print it to their native log (NSLog / logcat / hilog) or stdout
 * (CLI). Called only from the thread that drives the runtime. */
typedef struct dsh_spike_sink {
    void (*on_log)(void *ud, const char *line);
    void *ud;
} dsh_spike_sink;

/* bundle_root: directory containing logger.js, scenario/, vendor/ (the
 * checkout's runtime/spike/). Returns NULL on init failure (details via
 * dsh_spike_error on a fresh struct is impossible — check stderr/errno at
 * the call site; init failures are embedder bugs, not scenario outcomes). */
dsh_spike_t *dsh_spike_new(const char *bundle_root, const dsh_spike_sink *sink);

/* Compile+run the entry module from source (the embedder reads the file —
 * or embeds it as a resource — wherever its platform stores it).
 * module_name is the entry's bundle-root-relative path; relative imports
 * inside the module resolve against it. 0 ok, -1 JS exception. */
int dsh_spike_eval(dsh_spike_t *s, const char *module_name, const char *source);

/* Drain microtasks and host-side gateway completions until quiescent.
 * 0 ok (scenario may or may not have completed yet), -1 JS exception. */
int dsh_spike_pump(dsh_spike_t *s);

int dsh_spike_complete(const dsh_spike_t *s); /* scenario called __dshComplete */
int dsh_spike_pass(const dsh_spike_t *s);     /* its pass flag */

/* Last C-side failure description (eval/pump/new), or "" — valid until free. */
const char *dsh_spike_error(const dsh_spike_t *s);

void dsh_spike_free(dsh_spike_t *s);

#endif /* DSH_SPIKE_HOST_H */
