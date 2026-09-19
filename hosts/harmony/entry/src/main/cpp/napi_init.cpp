/*
 * napi_init.cpp — NAPI binding for the M1 spike host on HarmonyOS.
 *
 * Threading rule (AGENTS.md / ARCHITECTURE.md §6): the scenario JS executes
 * on ONE serial thread. The whole new+eval+pump loop runs synchronously
 * inside startSpike on the NAPI caller thread (the ArkTS main thread); it
 * takes well under a second. No extra JS-driving threads exist.
 *
 * The sink receives each canonical E2E line ("dsh.spike.log: {...") from
 * dsh_spike_host and forwards it, byte-unmodified, to (a) hilog under
 * domain 0xD5E0 / tag "dsh.spike" (hilog requires printing through its
 * format string, hence "%{public}s"), and (b) a capture file under the
 * app's cache dir, pulled verbatim via `hdc file recv` as the checker's
 * second, truncation-proof capture.
 */
#include "napi/native_api.h"
#include <hilog/log.h>

#include <cstdio>
#include <cstring>
#include <string>

extern "C" {
#include "dsh_spike_host.h"
}

#undef LOG_DOMAIN
#define LOG_DOMAIN 0xD5E0
#undef LOG_TAG
#define LOG_TAG "dsh.spike"

namespace {

constexpr const char *DSH_ENTRY = "scenario/m1-spike-boot.js";
constexpr const char *DSH_ENGINE_NAME = "quickjs-ng";
constexpr const char *DSH_ENGINE_VERSION = "0.17.0";

struct SinkCtx {
    FILE *capture = nullptr;
    int lines = 0;
};

void sink_on_log(void *ud, const char *line) {
    SinkCtx *ctx = static_cast<SinkCtx *>(ud);
    OH_LOG_INFO(LOG_APP, "%{public}s", line);
    if (ctx->capture != nullptr) {
        fputs(line, ctx->capture);
        fputc('\n', ctx->capture);
        fflush(ctx->capture);
        ctx->lines++;
    }
}

char *slurp(const char *path) {
    FILE *f = fopen(path, "rb");
    if (f == nullptr) {
        return nullptr;
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) {
        fclose(f);
        return nullptr;
    }
    char *buf = static_cast<char *>(malloc(static_cast<size_t>(n) + 1));
    if (buf == nullptr) {
        fclose(f);
        return nullptr;
    }
    size_t got = fread(buf, 1, static_cast<size_t>(n), f);
    fclose(f);
    buf[got] = 0;
    return buf;
}

std::string join_path(const std::string &dir, const std::string &rel) {
    return dir + "/" + rel;
}

napi_value start_spike(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) {
        napi_throw_error(env, "EINVAL", "startSpike(bundleRoot, capturePath) needs 2 arguments");
        return nullptr;
    }

    char bundle_root[1024] = {0};
    char capture_path[1024] = {0};
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len);
    if (len >= sizeof(bundle_root)) {
        napi_throw_error(env, "EINVAL", "bundleRoot path too long");
        return nullptr;
    }
    napi_get_value_string_utf8(env, argv[0], bundle_root, sizeof(bundle_root), &len);
    napi_get_value_string_utf8(env, argv[1], nullptr, 0, &len);
    if (len >= sizeof(capture_path)) {
        napi_throw_error(env, "EINVAL", "capturePath too long");
        return nullptr;
    }
    napi_get_value_string_utf8(env, argv[1], capture_path, sizeof(capture_path), &len);

    SinkCtx sink_ctx;
    sink_ctx.capture = fopen(capture_path, "w");
    if (sink_ctx.capture == nullptr) {
        OH_LOG_WARN(LOG_APP, "capture file not writable: %{public}s", capture_path);
    }

    dsh_spike_sink sink = {sink_on_log, &sink_ctx};
    dsh_spike_t *spike = dsh_spike_new(bundle_root, &sink);
    if (spike == nullptr) {
        if (sink_ctx.capture != nullptr) {
            fclose(sink_ctx.capture);
        }
        napi_throw_error(env, "EINIT", "spike runtime init failed");
        return nullptr;
    }

    int rc = -1;
    std::string entry_path = join_path(bundle_root, DSH_ENTRY);
    char *source = slurp(entry_path.c_str());
    if (source == nullptr) {
        OH_LOG_ERROR(LOG_APP, "cannot read entry %{public}s", entry_path.c_str());
    } else {
        rc = dsh_spike_eval(spike, DSH_ENTRY, source);
        free(source);
        if (rc == 0) {
            rc = dsh_spike_pump(spike);
        }
    }

    bool pass = (rc == 0) && dsh_spike_complete(spike) && dsh_spike_pass(spike);
    std::string summary = pass ? "PASS" : "FAIL";
    summary += std::string(" engine=") + DSH_ENGINE_NAME;
    summary += std::string(" version=") + DSH_ENGINE_VERSION;
    summary += " complete=" + std::to_string(dsh_spike_complete(spike));
    summary += " pass=" + std::to_string(dsh_spike_pass(spike));
    summary += " logLines=" + std::to_string(sink_ctx.lines);
    if (!pass && strlen(dsh_spike_error(spike)) > 0) {
        summary += std::string(" error=\"") + dsh_spike_error(spike) + "\"";
    }

    OH_LOG_INFO(LOG_APP, "dsh.spike.verdict: %{public}s", summary.c_str());
    if (sink_ctx.capture != nullptr) {
        fclose(sink_ctx.capture);
        sink_ctx.capture = nullptr;
    }
    dsh_spike_free(spike);

    napi_value out;
    napi_create_string_utf8(env, summary.c_str(), summary.size(), &out);
    return out;
}

}  // namespace

extern "C" {

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"startSpike", nullptr, start_spike, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

}  /* extern "C" */

static napi_module dsh_spike_module;

/* Runs at .so load time, before the ArkTS side imports libspike.so. */
extern "C" __attribute__((constructor)) void RegisterDshSpikeModule(void) {
    dsh_spike_module.nm_version = 1;
    dsh_spike_module.nm_flags = 0;
    dsh_spike_module.nm_filename = nullptr;
    dsh_spike_module.nm_register_func = Init;
    dsh_spike_module.nm_modname = "spike";
    dsh_spike_module.nm_priv = nullptr;
    dsh_spike_module.reserved[0] = 0;
    napi_module_register(&dsh_spike_module);
}
