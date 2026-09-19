/*
 * napi_init.cpp — NAPI binding for the M5 spike host on HarmonyOS.
 *
 * Threading rule (AGENTS.md / ARCHITECTURE.md §6): the scenario JS executes
 * on ONE serial thread. The whole new+eval+pump(+settle) loop runs
 * synchronously inside startSpike on the NAPI caller thread (the ArkTS main
 * thread); it takes well under a second. No extra JS-driving threads exist.
 *
 * One launch drives ALL THREE spike scenarios:
 *   - m1.spike.boot (regression): loader + seams + gateway negotiation;
 *   - m2.bridge.smoke: the real gateway bridge, served by the smoke backend
 *     in gateway_smoke.cpp (fs on the app dir as scope "app", keychain
 *     honestly unavailable, unknown primitives invalid), with deferred
 *     settlement — calls queue in the dispatch callback and settle on the
 *     post-pump drain pass, exactly like the desktop CLI twin;
 *   - m2.session: the mini agent session over the three system plugins
 *     (registry + dsh-fs + dsh-subprocess-quickjs + dsh-ui), started by the
 *     host.info readiness event after eval.
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
#include <time.h>

extern "C" {
#include "dsh_spike_host.h"
#include "gateway_smoke.h"
}

#undef LOG_DOMAIN
#define LOG_DOMAIN 0xD5E0
#undef LOG_TAG
#define LOG_TAG "dsh.spike"

namespace {

constexpr const char *DSH_ENTRY_M1 = "scenario/m1-spike-boot.js";
constexpr const char *DSH_ENTRY_M2 = "scenario/m2-bridge-smoke.js";
constexpr const char *DSH_ENTRY_SESSION = "scenario/m2-session.js";
constexpr const char *DSH_ENGINE_NAME = "quickjs-ng";
constexpr const char *DSH_ENGINE_VERSION = "0.17.0";
constexpr const char *DSH_SCENARIO_M1 = "m1.spike.boot";
constexpr const char *DSH_SCENARIO_M2 = "m2.bridge.smoke";
constexpr const char *DSH_SCENARIO_SESSION = "m2.session";
/* Host readiness signal through the same gateway-event channel the desktop
 * backend uses: {"event":"host.info","port":0} — this embedder has no carrier,
 * so port 0. Scenarios waiting on it start after eval; scenarios without a
 * subscriber drop it (shim contract). */
constexpr const char *DSH_HOST_INFO_EVENT = "{\"event\":\"host.info\",\"port\":0}";
/* Backstop for the m2 settle loop — the scenario is sub-second; reaching
 * this deadline means the bridge is stuck, so fail loud. */
constexpr int DSH_SMOKE_DEADLINE_SECONDS = 10;

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

struct ScenarioResult {
    bool pass = false;
    std::string verdict; /* "m1.spike.boot PASS complete=1 pass=1 ..." */
};

/* Drive {pump → drain} until the scenario completes, an exception fires, or
 * the backstop deadline passes — condition-driven, never sleeps. */
int pump_until_settled(dsh_spike_t *spike, dsh_smoke_backend_t *smoke,
                       const char *scenario) {
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += DSH_SMOKE_DEADLINE_SECONDS;
    int rc = 0;
    while (rc == 0 && !dsh_spike_complete(spike)) {
        rc = dsh_spike_pump(spike);
        if (rc != 0 || smoke == nullptr) break;
        int served = dsh_smoke_drain(smoke);
        if (served < 0) { rc = -1; break; }
        if (dsh_spike_complete(spike) || served == 0) break;
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec) {
            OH_LOG_ERROR(LOG_APP,
                         "dsh.spike: %{public}ds deadline elapsed in %{public}s",
                         DSH_SMOKE_DEADLINE_SECONDS, scenario);
            rc = -1;
        }
    }
    return rc;
}

/* Eval one entry module and drive it to completion (no gateway bridge —
 * the m1 regression never dispatches a primitive call). */
ScenarioResult run_scenario(dsh_spike_t *spike, const std::string &bundle_root,
                            const char *scenario, const char *entry,
                            SinkCtx *sink_ctx) {
    (void)sink_ctx;
    ScenarioResult res;
    std::string entry_path = join_path(bundle_root, entry);
    char *source = slurp(entry_path.c_str());
    if (source == nullptr) {
        OH_LOG_ERROR(LOG_APP, "cannot read entry %{public}s", entry_path.c_str());
        res.verdict = std::string(scenario) + " FAIL error=\"cannot read entry\"";
        return res;
    }
    int rc = dsh_spike_eval(spike, entry, source);
    free(source);
    if (rc == 0) {
        rc = pump_until_settled(spike, nullptr, scenario);
    }
    res.pass = (rc == 0) && dsh_spike_complete(spike) && dsh_spike_pass(spike);
    return res;
}

/* Same, but over the gateway bridge: the smoke backend answers dispatched
 * calls (queued, then settled by the pump loop). ready_event (nullable) is
 * delivered once after eval, before the first pump pass — the host readiness
 * signal m2.session waits on. */
ScenarioResult run_smoke_scenario(dsh_spike_t *spike,
                                  const std::string &bundle_root,
                                  const char *scenario, const char *entry,
                                  dsh_smoke_backend_t *smoke, SinkCtx *sink_ctx,
                                  const char *ready_event) {
    (void)sink_ctx;
    ScenarioResult res;
    dsh_smoke_attach(smoke, spike);
    std::string entry_path = join_path(bundle_root, entry);
    char *source = slurp(entry_path.c_str());
    if (source == nullptr) {
        OH_LOG_ERROR(LOG_APP, "cannot read entry %{public}s", entry_path.c_str());
        res.verdict = std::string(scenario) + " FAIL error=\"cannot read entry\"";
        return res;
    }
    int rc = dsh_spike_eval(spike, entry, source);
    free(source);
    if (rc == 0 && ready_event != nullptr
        && dsh_spike_gateway_event(spike, ready_event) != 0) {
        rc = -1;
    }
    if (rc == 0) {
        rc = pump_until_settled(spike, smoke, scenario);
    }
    res.pass = (rc == 0) && !dsh_smoke_failed(smoke) &&
               dsh_spike_complete(spike) && dsh_spike_pass(spike);
    return res;
}

/* hilog verdict line: "<scenario> PASS|FAIL complete=… pass=… logLines=…". */
std::string verdict_line(const char *scenario, const ScenarioResult &res,
                         int lines, dsh_spike_t *spike) {
    std::string out = std::string(scenario) + " " + (res.pass ? "PASS" : "FAIL");
    out += " engine=" + std::string(DSH_ENGINE_NAME);
    out += " version=" + std::string(DSH_ENGINE_VERSION);
    out += " complete=" + std::to_string(dsh_spike_complete(spike));
    out += " pass=" + std::to_string(dsh_spike_pass(spike));
    out += " logLines=" + std::to_string(lines);
    if (!res.pass && strlen(dsh_spike_error(spike)) > 0) {
        out += std::string(" error=\"") + dsh_spike_error(spike) + "\"";
    }
    return out;
}

/* One scenario lifecycle: new runtime → run → collect → free. */
ScenarioResult run_m1(const std::string &bundle_root, dsh_spike_sink *sink,
                      SinkCtx *sink_ctx) {
    dsh_spike_t *spike = dsh_spike_new(bundle_root.c_str(), sink);
    ScenarioResult res;
    if (spike == nullptr) {
        res.verdict = std::string(DSH_SCENARIO_M1) + " FAIL error=\"runtime init failed\"";
        return res;
    }
    int lines_before = sink_ctx->lines;
    res = run_scenario(spike, bundle_root, DSH_SCENARIO_M1, DSH_ENTRY_M1, sink_ctx);
    res.verdict = verdict_line(DSH_SCENARIO_M1, res, sink_ctx->lines - lines_before, spike);
    dsh_spike_free(spike);
    return res;
}

ScenarioResult run_m2(const std::string &bundle_root, dsh_spike_sink *sink,
                      SinkCtx *sink_ctx, const char *fs_root) {
    dsh_smoke_backend_t *smoke = dsh_smoke_new(fs_root);
    dsh_spike_t *spike = dsh_spike_new(bundle_root.c_str(), sink);
    ScenarioResult res;
    if (smoke == nullptr || spike == nullptr) {
        res.verdict = std::string(DSH_SCENARIO_M2) + " FAIL error=\"runtime init failed\"";
        dsh_smoke_free(smoke);
        if (spike != nullptr) dsh_spike_free(spike);
        return res;
    }
    int lines_before = sink_ctx->lines;
    res = run_smoke_scenario(spike, bundle_root, DSH_SCENARIO_M2, DSH_ENTRY_M2,
                             smoke, sink_ctx, nullptr);
    res.verdict = verdict_line(DSH_SCENARIO_M2, res, sink_ctx->lines - lines_before, spike);
    dsh_spike_free(spike);
    dsh_smoke_free(smoke);
    return res;
}

/* m2.session — the mini agent session over the three system plugins; same
 * smoke backend, plus the host.info readiness event after eval. */
ScenarioResult run_session(const std::string &bundle_root, dsh_spike_sink *sink,
                           SinkCtx *sink_ctx, const char *fs_root) {
    dsh_smoke_backend_t *smoke = dsh_smoke_new(fs_root);
    dsh_spike_t *spike = dsh_spike_new(bundle_root.c_str(), sink);
    ScenarioResult res;
    if (smoke == nullptr || spike == nullptr) {
        res.verdict = std::string(DSH_SCENARIO_SESSION) + " FAIL error=\"runtime init failed\"";
        dsh_smoke_free(smoke);
        if (spike != nullptr) dsh_spike_free(spike);
        return res;
    }
    int lines_before = sink_ctx->lines;
    res = run_smoke_scenario(spike, bundle_root, DSH_SCENARIO_SESSION,
                             DSH_ENTRY_SESSION, smoke, sink_ctx,
                             DSH_HOST_INFO_EVENT);
    res.verdict = verdict_line(DSH_SCENARIO_SESSION, res, sink_ctx->lines - lines_before, spike);
    dsh_spike_free(spike);
    dsh_smoke_free(smoke);
    return res;
}

napi_value start_spike(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) {
        napi_throw_error(env, "EINVAL",
                         "startSpike(bundleRoot, capturePath, fsRoot) needs 3 arguments");
        return nullptr;
    }

    char bundle_root[1024] = {0};
    char capture_path[1024] = {0};
    char fs_root[1024] = {0};
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
    napi_get_value_string_utf8(env, argv[2], nullptr, 0, &len);
    if (len >= sizeof(fs_root)) {
        napi_throw_error(env, "EINVAL", "fsRoot path too long");
        return nullptr;
    }
    napi_get_value_string_utf8(env, argv[2], fs_root, sizeof(fs_root), &len);

    SinkCtx sink_ctx;
    sink_ctx.capture = fopen(capture_path, "w");
    if (sink_ctx.capture == nullptr) {
        OH_LOG_WARN(LOG_APP, "capture file not writable: %{public}s", capture_path);
    }

    dsh_spike_sink sink = {sink_on_log, &sink_ctx};
    ScenarioResult m1 = run_m1(bundle_root, &sink, &sink_ctx);
    ScenarioResult m2 = run_m2(bundle_root, &sink, &sink_ctx, fs_root);
    ScenarioResult session = run_session(bundle_root, &sink, &sink_ctx, fs_root);

    OH_LOG_INFO(LOG_APP, "dsh.spike.verdict: %{public}s", m1.verdict.c_str());
    OH_LOG_INFO(LOG_APP, "dsh.spike.verdict: %{public}s", m2.verdict.c_str());
    OH_LOG_INFO(LOG_APP, "dsh.spike.verdict: %{public}s", session.verdict.c_str());
    if (sink_ctx.capture != nullptr) {
        fclose(sink_ctx.capture);
        sink_ctx.capture = nullptr;
    }

    bool pass = m1.pass && m2.pass && session.pass;
    std::string summary = pass ? "PASS" : "FAIL";
    summary += " " + m1.verdict + " | " + m2.verdict + " | " + session.verdict;
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
