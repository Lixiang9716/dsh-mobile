/* The WebAssembly runner. See dsh_wasm.h for the ABI and the rationale; this
 * file is the whole implementation. */
#include "dsh_wasm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "wasm3.h"
#include "m3_env.h"

#define DSH_WASM_INPUT_RESERVE 4096u
#define DSH_WASM_MAX_OUTPUT (64u * 1024u)
#define DSH_WASM_STACK (64u * 1024u)

/* One run at a time: the gateway dispatches onto the runtime's serial queue, so
 * the sink needs no lock (ARCHITECTURE.md §6 thread rules). */
typedef struct {
    char buf[DSH_WASM_MAX_OUTPUT];
    size_t len;
} dsh_wasm_sink;

static dsh_wasm_sink g_sink;

static void set_error(char **error, const char *message) {
    if (error == NULL) return;
    *error = strdup(message != NULL ? message : "wasm run failed");
}

/* dsh.emit(ptr, len) — the module's whole output channel.
 *
 * Written as PLAIN C rather than through wasm3's m3ApiRawFunction /
 * m3ApiGetArgMem macros: those expand to the signature and stack plumbing
 * below, and writing the expansion out keeps the file readable by an
 * editor-level C parser (this repository's syntax check reads it) instead of
 * hiding a function definition inside a macro invocation whose arguments are
 * TYPES. The values come off the interpreter's operand stack the same way the
 * macros take them; the memory bounds check is m3ApiCheckMem's. */
static const void *dsh_host_emit(IM3Runtime runtime, IM3ImportContext _ctx,
                                 uint64_t *_sp, void *_mem) {
    const char *ptr = (const char *)m3ApiOffsetToPtr(*((uint32_t *)(_sp++)));
    uint32_t len = *((uint32_t *)(_sp++));
    uintptr_t end = (uintptr_t)_mem + (uintptr_t)m3_GetMemorySize(runtime);
    if ((const void *)ptr < _mem || (uintptr_t)ptr + (uintptr_t)len > end) {
        return m3Err_trapOutOfBoundsMemoryAccess;
    }
    if (g_sink.len + len < sizeof(g_sink.buf)) {
        memcpy(g_sink.buf + g_sink.len, ptr, (size_t)len);
        g_sink.len += (size_t)len;
    }
    return m3Err_none;
}

/* JSON string escaping for the output field: control characters and the two
 * quotes, everything else verbatim (the JSON parser on the other side is the
 * runtime's, so unpaired surrogates are the only thing it cannot represent —
 * and a WASM module emitting those is out of scope for v1). */
static char *json_escape(const char *text, size_t len) {
    size_t cap = len * 6 + 1;
    char *out = malloc(cap);
    if (out == NULL) return NULL;
    size_t at = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)text[i];
        switch (c) {
            case '"': out[at++] = '\\'; out[at++] = '"'; break;
            case '\\': out[at++] = '\\'; out[at++] = '\\'; break;
            case '\n': out[at++] = '\\'; out[at++] = 'n'; break;
            case '\r': out[at++] = '\\'; out[at++] = 'r'; break;
            case '\t': out[at++] = '\\'; out[at++] = 't'; break;
            default:
                if (c < 0x20) at += (size_t)snprintf(out + at, 7, "\\u%04x", c);
                else out[at++] = (char)c;
        }
    }
    out[at] = '\0';
    return out;
}

char *dsh_wasm_run(const uint8_t *bytes, size_t len, const char *func,
                   const char *input, char **error) {
    if (error != NULL) *error = NULL;
    if (bytes == NULL || len == 0 || func == NULL) {
        set_error(error, "wasmRun: module bytes and function name are required");
        return NULL;
    }
    dsh_wasm_sink *sink = &g_sink;
    sink->len = 0;

    IM3Environment env = m3_NewEnvironment();
    IM3Runtime rt = m3_NewRuntime(env, DSH_WASM_STACK, NULL);
    if (env == NULL || rt == NULL) {
        if (rt != NULL) m3_FreeRuntime(rt);
        if (env != NULL) m3_FreeEnvironment(env);
        set_error(error, "wasmRun: cannot create the interpreter environment");
        return NULL;
    }

    IM3Module module = NULL;
    M3Result res = m3_ParseModule(env, &module, bytes, (uint32_t)len);
    if (res != NULL) {
        char message[256];
        snprintf(message, sizeof(message), "wasmRun: module does not parse: %s", res);
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, message);
        return NULL;
    }
    res = m3_LoadModule(rt, module);
    if (res != NULL) {
        char message[256];
        snprintf(message, sizeof(message), "wasmRun: module does not load: %s", res);
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, message);
        return NULL;
    }
    /* The module calls back into the host through this import; a module that
     * does not import it is fine (it just cannot report anything). */
    res = m3_LinkRawFunction(module, "dsh", "emit", "v(ii)", &dsh_host_emit);
    if (res != NULL && strcmp(res, m3Err_functionLookupFailed) != 0) {
        char message[256];
        snprintf(message, sizeof(message), "wasmRun: cannot link dsh.emit: %s", res);
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, message);
        return NULL;
    }

    IM3Function fn = NULL;
    res = m3_FindFunction(&fn, rt, func);
    if (res != NULL) {
        char message[256];
        snprintf(message, sizeof(message), "wasmRun: no export \"%s\": %s", func, res);
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, message);
        return NULL;
    }

    /* Hand the input over inside the module's own memory (see the header). */
    uint32_t mem_size = 0;
    uint8_t *mem = m3_GetMemory(rt, &mem_size, 0);
    size_t in_len = input != NULL ? strlen(input) : 0;
    uint32_t in_ptr = 0;
    if (mem != NULL && mem_size > DSH_WASM_INPUT_RESERVE) {
        if (in_len > DSH_WASM_INPUT_RESERVE - 1) in_len = DSH_WASM_INPUT_RESERVE - 1;
        in_ptr = mem_size - DSH_WASM_INPUT_RESERVE;
        if (input != NULL && in_len > 0) memcpy(mem + in_ptr, input, in_len);
        mem[in_ptr + in_len] = '\0';
    }

    res = m3_CallV(fn, (uint32_t)in_ptr, (uint32_t)in_len);
    if (res != NULL) {
        char message[256];
        snprintf(message, sizeof(message), "wasmRun: \"%s\" trapped: %s", func, res);
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, message);
        return NULL;
    }
    uint32_t result = 0;
    m3_GetResultsV(fn, &result);

    char *escaped = json_escape(sink->buf, sink->len);
    if (escaped == NULL) {
        m3_FreeRuntime(rt); m3_FreeEnvironment(env);
        set_error(error, "wasmRun: out of memory building the result");
        return NULL;
    }
    size_t need = strlen(escaped) + 64;
    char *json = malloc(need);
    if (json != NULL) {
        snprintf(json, need, "{\"result\":%u,\"output\":\"%s\"}", result, escaped);
    }
    free(escaped);
    m3_FreeRuntime(rt);
    m3_FreeEnvironment(env);
    if (json == NULL) set_error(error, "wasmRun: out of memory building the result");
    return json;
}
