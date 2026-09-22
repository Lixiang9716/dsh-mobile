#ifndef DSH_WASM_H
#define DSH_WASM_H

#include <stddef.h>
#include <stdint.h>

/* The WebAssembly seam (contract v1.2.0 `wasmRun`).
 *
 * Runs one exported function of one in-process WASM module and returns a
 * malloc'd JSON object `{"result":<i32>,"output":"<utf8>"}`; NULL on failure
 * with *error set to a malloc'd message. The caller frees both.
 *
 * ABI (what a module must expose to be runnable here):
 *   - the module exports its memory;
 *   - the export takes (param i32 ptr) (param i32 len) and returns i32;
 *   - the HOST writes the caller's input into the LAST 4096 bytes of the
 *     module's current memory and passes that offset+length, so a module keeps
 *     its own data below that region (or grows its memory and uses the new
 *     top, which this recomputes on every run);
 *   - everything the module wants to say goes through the imported function
 *     `dsh.emit(ptr, len)` — the host collects it, and the run's return value
 *     is the module's own status code.
 *
 * The interpreter is wasm3, vendored and sha256-pinned by
 * runtime/spike/vendor/ensure-wasm3.sh. Nothing here spawns a process: iOS
 * forbids it and this host refuses it (D2), which is the whole reason the
 * module is interpreted inside the caller's own process. */
char *dsh_wasm_run(const uint8_t *bytes, size_t len, const char *func,
                   const char *input, char **error);

#endif /* DSH_WASM_H */
