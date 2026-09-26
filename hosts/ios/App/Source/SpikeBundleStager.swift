import Foundation

/// Stages the embedded JS bundle into a fresh writable sandbox directory,
/// preserving the runtime/spike layout the C loader expects: logger.js and
/// gateway.js at the root, manifest.json beside them (the M2 embedder reads
/// the scenario's declared capabilities from it), the entries under
/// scenario/, and the vendored upstream package under vendor/ (the
/// "dsh:util-crypto" import maps there). The bytes come from the embedded
/// arrays (gen_bundle_header.py), so what the simulator runs is
/// byte-identical to the checkout.
enum SpikeBundleStager {
    static func stage() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("spike", isDirectory: true)
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        try write("logger.js", data: resData(dsh_spike_res_logger_js),
                  under: root)
        try write("gateway.js", data: resData(dsh_spike_res_gateway_js),
                  under: root)
        try write("manifest.json", data: resData(dsh_spike_res_manifest_json),
                  under: root)
        try write("scenario/boot-verification.js", data: resData(dsh_spike_res_scenario_js),
                  under: root)
        try write("scenario/gateway-binding.js",
                  data: resData(dsh_spike_res_scenario_m2_js), under: root)
        try write("scenario/gateway-bridge-smoke.js",
                  data: resData(dsh_spike_res_scenario_m2_smoke_js), under: root)
        try write("scenario/carrier-loopback.js",
                  data: resData(dsh_spike_res_scenario_carrier_js), under: root)
        try write("registry.js", data: resData(dsh_spike_res_registry_js), under: root)
        try write("install-pipeline.js",
                  data: resData(dsh_spike_res_install_pipeline_js), under: root)
        try write("sha256.js", data: resData(dsh_spike_res_sha256_js), under: root)
        try write("tar-mini.js", data: resData(dsh_spike_res_tar_mini_js), under: root)
        try writeScenarioEntries(root)
        try writeWebBootClosure(root)
        try writePluginsAndClients(root)
        try writeWebClientNext(root)
        try writeSpineClosure(root)
        try writeSpineTree(root)
        try write("web/index.html", data: resData(dsh_spike_res_web_index_html),
                  under: root)
        try write("web/carrier-page.js", data: resData(dsh_spike_res_web_page_js),
                  under: root)
        try write("vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js",
                  data: resData(dsh_spike_res_pkg_crypto_js), under: root)
        try writeStagedSpecs(root)
        return root
    }

    /// The upstream test-suite specs are TRANSPILED OUTSIDE the app (the
    /// E2E runner stages them into Documents/upstream-tests/, which survives
    /// relaunch); this bundle root is rebuilt from scratch on every launch,
    /// so the staged specs are lifted in here — the `upstream.suite` drive
    /// imports them by bundle-root-relative path.
    private static func writeStagedSpecs(_ root: URL) throws {
        let staged = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Documents/upstream-tests", isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: staged, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "mjs" {
            try? FileManager.default.createDirectory(
                at: root.appendingPathComponent("upstream-tests", isDirectory: true),
                withIntermediateDirectories: true)
            try? FileManager.default.copyItem(
                at: file, to: root.appendingPathComponent("upstream-tests/\(file.lastPathComponent)"))
        }
    }

    /// Scenario entries (the m1/m2 E2E scenarios, plus the M3 on-device
    /// fetch-install scenario and its modules + the profile config patch,
    /// and the M2 real-LLM scenario with its client module).

    /// The upstream/shims set the embedded spine's host-compat surface
    /// needs staged bundle-relative — extracted from stage() for the
    /// function-shape budget.
    private static func writeHostShims(_ root: URL) throws {
            try write("upstream/shims/buffer.js",
                      data: resData(dsh_spike_res_shims_buffer_js), under: root)
            try write("upstream/shims/url.js",
                      data: resData(dsh_spike_res_shims_url_js), under: root)
            try write("upstream/shims/fs.js",
                      data: resData(dsh_spike_res_shims_fs_js), under: root)
            try write("upstream/shims/crypto.js",
                      data: resData(dsh_spike_res_shims_crypto_js), under: root)
            try write("upstream/shims/globals.js",
                      data: resData(dsh_spike_res_shims_globals_js), under: root)
            try write("upstream/shims/node-perf-hooks.js",
                      data: resData(dsh_spike_res_shims_node_perf_hooks_js), under: root)
            try write("upstream/shims/node-addon-system-flock.js",
                      data: resData(dsh_spike_res_shims_node_addon_flock_js), under: root)
            try write("upstream/shims/expect-poll.js",
                      data: resData(dsh_spike_res_shims_expect_poll_js), under: root)
            try write("upstream/shims/node-module.js",
                      data: resData(dsh_spike_res_shims_node_module_js), under: root)
            try write("upstream/shims/path.js",
                      data: resData(dsh_spike_res_shims_path_js), under: root)
            try write("upstream/shims/fs-promises.js",
                      data: resData(dsh_spike_res_shims_fs_promises_js), under: root)
            try write("upstream/shims/timers-promises.js",
                      data: resData(dsh_spike_res_shims_timers_promises_js), under: root)
            try write("upstream/shims/timers.js",
                      data: resData(dsh_spike_res_shims_timers_js), under: root)
            try write("upstream/shims/npm-bridges.js",
                      data: resData(dsh_spike_res_shims_npm_bridges_js), under: root)
            try write("upstream/shims/fs-workspace.js",
                      data: resData(dsh_spike_res_shims_fs_workspace_js), under: root)
            try write("upstream/shims/async-hooks.js",
                      data: resData(dsh_spike_res_shims_async_hooks_js), under: root)
            try write("upstream/shims/util.js",
                      data: resData(dsh_spike_res_shims_util_js), under: root)
            try write("upstream/shims/util-types.js",
                      data: resData(dsh_spike_res_shims_util_types_js), under: root)
            try write("upstream/shims/os.js",
                      data: resData(dsh_spike_res_shims_os_js), under: root)
            try write("upstream/shims/process.js",
                      data: resData(dsh_spike_res_shims_process_js), under: root)
            try write("upstream/shims/dsh-session-persistence.js",
                      data: resData(dsh_spike_res_shims_dsh_session_persistence_js), under: root)
    }

    private static func writeScenarioEntries(_ root: URL) throws {
        try write("scenario/session-mock-llm.js",
                  data: resData(dsh_spike_res_scenario_m2_session_js), under: root)
        try write("scenario/install-from-http.js",
                  data: resData(dsh_spike_res_scenario_m3_fetch_install_js), under: root)
        try write("scenario/llm-live-stream.js",
                  data: resData(dsh_spike_res_scenario_m2_llm_js), under: root)
        try write("scenario/upstream-parity.js",
                  data: resData(dsh_spike_res_scenario_upstream_parity_js), under: root)
        try write("scenario/parity-projector.js",
                  data: resData(dsh_spike_res_scenario_parity_projector_js), under: root)
        try write("scenario/upstream-suite-leg.js",
                  data: resData(dsh_spike_res_scenario_upstream_suite_js), under: root)
        try write("scenario/upstream-test-harness.js",
                  data: resData(dsh_spike_res_scenario_upstream_harness_js), under: root)
        try write("llm.js", data: resData(dsh_spike_res_llm_js), under: root)
        try write("install-fetch.js",
                  data: resData(dsh_spike_res_install_fetch_js), under: root)
        try write("receipt-journal.js",
                  data: resData(dsh_spike_res_receipt_journal_js), under: root)
        try write("profiles/install-full-cycle/cordis.patch.json",
                  data: resData(dsh_spike_res_profile_m3_patch_json), under: root)
    }

    /// The W-INTEG web-boot closure (officialweb-web-live drive): the upstream
    /// web-boot adapter, its shims, and the vendored npm libs the official
    /// client-modules composition imports — staged at the exact bundle-root
    /// relative paths the C loader's bare map resolves.
    private static func writeWebBootClosure(_ root: URL) throws {
        try write("scenario/officialweb-web-live.js",
                  data: resData(dsh_spike_res_scenario_b1_web_live_js), under: root)
        try write("upstream/web-boot.js",
                  data: resData(dsh_spike_res_upstream_web_boot_js), under: root)
        try write("upstream/web-shims.js",
                  data: resData(dsh_spike_res_upstream_web_shims_js), under: root)
        try write("upstream/shims/buffer.js",
                  data: resData(dsh_spike_res_shims_buffer_js), under: root)
        try write("upstream/shims/url.js",
                  data: resData(dsh_spike_res_shims_url_js), under: root)
        try write("upstream/shims/fs.js",
                  data: resData(dsh_spike_res_shims_fs_js), under: root)
        try write("upstream/shims/crypto.js",
                  data: resData(dsh_spike_res_shims_crypto_js), under: root)
        try write("upstream/shims/globals.js",
                  data: resData(dsh_spike_res_shims_globals_js), under: root)
        try write("upstream/shims/node-perf-hooks.js",
                  data: resData(dsh_spike_res_shims_node_perf_hooks_js), under: root)
        try write("upstream/shims/node-addon-system-flock.js",
                  data: resData(dsh_spike_res_shims_node_addon_flock_js), under: root)
        try write("upstream/shims/expect-poll.js",
                  data: resData(dsh_spike_res_shims_expect_poll_js), under: root)
        try write("upstream/shims/node-zlib.js",
                  data: resData(dsh_spike_res_shims_node_zlib_js), under: root)
        try write("upstream/shims/node-worker-threads.js",
                  data: resData(dsh_spike_res_shims_node_worker_threads_js), under: root)
        try write("upstream/shims/node-stream.js",
                  data: resData(dsh_spike_res_shims_node_stream_js), under: root)
        try write("upstream/shims/describe-each.js",
                  data: resData(dsh_spike_res_shims_describe_each_js), under: root)
        try write("upstream/shims/node-module.js",
                  data: resData(dsh_spike_res_shims_node_module_js), under: root)
        try write("upstream/shims/path.js",
                  data: resData(dsh_spike_res_shims_path_js), under: root)

        try writeWebBootNpmLibs(root)
    }

    /// The vendored npm libs the W-INTEG web-boot closure imports (the
    /// cordis chain, client-modules faces) — split from
    /// writeWebBootClosure for the function-shape budget.
    private static func writeWebBootNpmLibs(_ root: URL) throws {
        try write("vendor/npm/cordis@4.0.2/lib/index.js",
                  data: resData(dsh_spike_res_npm_cordis_js), under: root)
        try write("vendor/npm/cosmokit@1.8.3/lib/index.js",
                  data: resData(dsh_spike_res_npm_cosmokit_js), under: root)
        try write("vendor/npm/schemastery@3.18.2/lib/index.mjs",
                  data: resData(dsh_spike_res_npm_schemastery_mjs), under: root)
        try write("vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/index.js",
                  data: resData(dsh_spike_res_npm_client_modules_index_js), under: root)
        try write("vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/client.js",
                  data: resData(dsh_spike_res_npm_client_modules_client_js), under: root)
        try write("vendor/npm/@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2/lib/index.js",
                  data: resData(dsh_spike_res_npm_anonymous_user_id_js), under: root)
        // The agent-presets closure (the Agent 预设 panel's data source): the
        // import chain the C-host bare map resolves — every mapped specifier
        // needs its staged file, or boot fails with `cannot load module`.
        try write("upstream/shims/fs-promises.js",
                  data: resData(dsh_spike_res_shims_fs_promises_js), under: root)
        try write("upstream/shims/timers-promises.js",
                  data: resData(dsh_spike_res_shims_timers_promises_js), under: root)
        try write("upstream/shims/timers.js",
                  data: resData(dsh_spike_res_shims_timers_js), under: root)
        try write("vendor/dsh/agent-presets@0.1.6-alpha.2/lib/index.js",
                  data: resData(dsh_spike_res_npm_agent_presets_index_js), under: root)
        try write("vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile/preset.yml",
                  data: resData(dsh_spike_res_presets_mobile_preset_yml), under: root)
        try write("vendor/dsh/agent-presets@0.1.6-alpha.2/presets/mobile/agent.cordis.yml",
                  data: resData(dsh_spike_res_presets_mobile_agent_cordis_yml), under: root)
        try write("vendor/npm/@deepseek-ai/cordis-plugin-loader@1.0.3/lib/index.js",
                  data: resData(dsh_spike_res_npm_plugin_loader_js), under: root)
        try write("vendor/npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib/index.js",
                  data: resData(dsh_spike_res_npm_plugin_include_js), under: root)
        // atomic-write / home-paths moved to the shared 0.1.6-alpha.2 stream
        // (2026-09-22 re-pin) and now stage through the spine-tree embed.
        try write("vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs",
                  data: resData(dsh_spike_res_npm_js_yaml_mjs), under: root)
    }

    /// System implementation plugins + the install-pipeline fixture + both
    /// Web Client variants (the ACTIVE one is selected by configuration).
    private static func writePluginsAndClients(_ root: URL) throws {
        try write("system-plugins/dsh-fs/manifest.json",
                  data: resData(dsh_spike_res_plugin_fs_manifest), under: root)
        try write("system-plugins/dsh-fs/index.js",
                  data: resData(dsh_spike_res_plugin_fs_js), under: root)
        try write("system-plugins/dsh-subprocess-quickjs/manifest.json",
                  data: resData(dsh_spike_res_plugin_subprocess_manifest), under: root)
        try write("system-plugins/dsh-subprocess-quickjs/index.js",
                  data: resData(dsh_spike_res_plugin_subprocess_js), under: root)
        try write("system-plugins/dsh-shell-wasm/manifest.json",
                  data: resData(dsh_spike_res_plugin_shell_wasm_manifest), under: root)
        try write("system-plugins/dsh-shell-wasm/index.js",
                  data: resData(dsh_spike_res_plugin_shell_wasm_js), under: root)
        try write("system-plugins/dsh-shell-ish/manifest.json",
                  data: resData(dsh_spike_res_plugin_shell_ish_manifest), under: root)
        try write("system-plugins/dsh-shell-ish/index.js",
                  data: resData(dsh_spike_res_plugin_shell_ish_js), under: root)
        try write("system-plugins/dsh-ui/manifest.json",
                  data: resData(dsh_spike_res_plugin_ui_manifest), under: root)
        try write("system-plugins/dsh-ui/index.js",
                  data: resData(dsh_spike_res_plugin_ui_js), under: root)
        try write("fixtures/dsh-notes.js",
                  data: resData(dsh_spike_res_fixture_notes_js), under: root)
        try write("fixtures/dsh-notes-source.js",
                  data: resData(dsh_spike_res_fixture_notes_source_js), under: root)
        try write("webclient/manifest.json",
                  data: resData(dsh_spike_res_webclient_manifest), under: root)
        try write("webclient/web/index.html",
                  data: resData(dsh_spike_res_webclient_index_html), under: root)
        try write("webclient/web/main.js",
                  data: resData(dsh_spike_res_webclient_main_js), under: root)
        try write("webclient-mini/manifest.json",
                  data: resData(dsh_spike_res_webclient_mini_manifest), under: root)
        try write("webclient-mini/web/index.html",
                  data: resData(dsh_spike_res_webclient_mini_index_html), under: root)
        try write("webclient-mini/web/main.js",
                  data: resData(dsh_spike_res_webclient_mini_main_js), under: root)
    }

    /// The W-SESS spine single files: the mobile profile boot, its settings
    /// backend, the gateway llm transport, the b3 scenario, and the node
    /// shims the spine needs beyond the web-boot set — staged at the exact
    /// bundle-relative paths the C loader resolves (imports fail loud
    /// otherwise).
    private static func writeSpineClosure(_ root: URL) throws {
        try write("scenario/session-web-live.js",
                  data: resData(dsh_spike_res_scenario_b3_web_live_js), under: root)
        try write("upstream/boot.js",
                  data: resData(dsh_spike_res_upstream_boot_js), under: root)
        try write("upstream/tool-present.js",
                  data: resData(dsh_spike_res_upstream_tool_present_js), under: root)
        try write("upstream/settings-memory.js",
                  data: resData(dsh_spike_res_upstream_settings_memory_js), under: root)
        try write("upstream/llm-transport.js",
                  data: resData(dsh_spike_res_upstream_llm_transport_js), under: root)
        // The W-RPC write surface (b4): the composer-send adapter + scenario.
        try writeWriteSurface(root)
        try write("upstream/web-write-streams.js",
                  data: resData(dsh_spike_res_upstream_web_write_streams_js), under: root)
        try write("upstream/web-write-settings.js",
                  data: resData(dsh_spike_res_upstream_web_write_settings_js), under: root)
        // The npm bridge shim registers bare `diff` before the file tools
        // resolve it (upstream/boot.js's FILE-TOOLS row).
        try write("upstream/shims/npm-bridges.js",
                  data: resData(dsh_spike_res_shims_npm_bridges_js), under: root)
        // The writable workspace VFS half of the fs shim (the FILE-TOOLS
        // row's world; split from fs.js at the file-size gate).
        try write("upstream/shims/fs-workspace.js",
                  data: resData(dsh_spike_res_shims_fs_workspace_js), under: root)
        try write("scenario/composer-web-live.js",
                  data: resData(dsh_spike_res_scenario_b4_web_live_js), under: root)
        try write("upstream/shims/async-hooks.js",
                  data: resData(dsh_spike_res_shims_async_hooks_js), under: root)
        try write("upstream/shims/util.js",
                  data: resData(dsh_spike_res_shims_util_js), under: root)
        try write("upstream/shims/util-types.js",
                  data: resData(dsh_spike_res_shims_util_types_js), under: root)
        try write("upstream/shims/os.js",
                  data: resData(dsh_spike_res_shims_os_js), under: root)
        try write("upstream/shims/process.js",
                  data: resData(dsh_spike_res_shims_process_js), under: root)
        try write("upstream/shims/dsh-session-persistence.js",
                  data: resData(dsh_spike_res_shims_dsh_session_persistence_js), under: root)
    }

    /// The self-hosted Web Client (presentation/web-client-next), embedded
    /// whole by gen_bundle_header.py's own tree (html/css ride along — the
    /// spine tree's suffix filter would drop them) and staged back at the
    /// bundle-relative path the carrier serves. Fails loud when empty.
    private static func writeWebClientNext(_ root: URL) throws {
        var staged = 0
        var index = 0
        while true {
            var path: UnsafePointer<CChar>?
            var data: UnsafePointer<CChar>?
            var len = 0
            guard dsh_spike_webclient_tree_file(index, &path, &data, &len) != 0 else { break }
            guard let path, let data, len > 0 else {
                throw SpikeBundleError.emptyResource("webclient tree entry \(index)")
            }
            try write(String(cString: path), data: Data(bytes: data, count: len),
                      under: root)
            staged += 1
            index += 1
        }
        guard staged > 0 else {
            throw SpikeBundleError.emptyResource("embedded webclient tree (0 files)")
        }
    }

    /// The W-SESS spine tree: the vendored upstream spine packages (verbatim
    /// lib/ trees) plus the pinned zod closure, embedded whole by
    /// gen_bundle_header.py and staged back at the bundle-relative paths the
    /// C loader's bare map resolves (`vendor/dsh/<pkg>@<ver>/lib/**`,
    /// `vendor/npm/zod@4.4.3/**`). Fails loud when the embedded tree is
    /// empty (a generator/stager mismatch can never boot quietly).
    private static func writeSpineTree(_ root: URL) throws {
        var staged = 0
        var index = 0
        while true {
            var path: UnsafePointer<CChar>?
            var data: UnsafePointer<CChar>?
            var len = 0
            guard dsh_spike_bundle_tree_file(index, &path, &data, &len) != 0 else { break }
            guard let path, let data, len > 0 else {
                throw SpikeBundleError.emptyResource("spine tree entry \(index)")
            }
            try write(String(cString: path), data: Data(bytes: data, count: len),
                      under: root)
            staged += 1
            index += 1
        }
        guard staged > 0 else {
            throw SpikeBundleError.emptyResource("embedded spine tree (0 files)")
        }
    }

    private static func resData(
        _ accessor: (UnsafeMutablePointer<Int>?) -> UnsafePointer<CChar>?
    ) -> Data {
        var len: Int = 0
        guard let bytes = accessor(&len), len > 0 else { return Data() }
        return Data(bytes: bytes, count: len)
    }

    private static func write(_ relative: String, data: Data, under root: URL) throws {
        guard !data.isEmpty else {
            throw SpikeBundleError.emptyResource(relative)
        }
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: url)
    }
}

enum SpikeBundleError: Error {
    case emptyResource(String)
}

extension SpikeBundleStager {
    /// The `@deepseek-ai` package scope the /plugins route and the web-boot
    /// plugin delivery both read their client bundles from. The EMBEDDED app
    /// resource wins when present: a user-facing build ships the vendored
    /// official client bundles inside the app (Tools/stage_official_web.py),
    /// so a plain launch needs nothing staged from outside. The harness
    /// (Debug) embeds nothing and falls through to Documents/web-plugins,
    /// which the E2E runners stage — the harness keeps reading exactly the
    /// tree it staged. Nil when neither tree carries a package.
    static func stagedPluginScope() -> URL? {
        var scopes: [URL] = []
        if let resources = Bundle.main.resourceURL {
            scopes.append(resources.appendingPathComponent(
                "official-web/plugins/npm/@deepseek-ai", isDirectory: true))
        }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        scopes.append(docs.appendingPathComponent(
            "web-plugins/npm/@deepseek-ai", isDirectory: true))
        for scope in scopes {
            let dirs = ((try? FileManager.default.contentsOfDirectory(
                at: scope, includingPropertiesForKeys: nil, options: []))?
                .filter(\.hasDirectoryPath)) ?? []
            if !dirs.isEmpty { return scope }
        }
        return nil
    }
}


extension SpikeBundleStager {
    /// The W-RPC write surface's five coverage splits + the composer adapter
    /// and its catalog: staged beside web-write.js (the api-full-coverage
    /// round split the surface across files; each needs its own embed row).
    static func writeWriteSurface(_ root: URL) throws {
        try write("upstream/web-write.js",
                  data: resData(dsh_spike_res_upstream_web_write_js), under: root)
        try write("upstream/web-write-catalog.js",
                  data: resData(dsh_spike_res_upstream_web_write_catalog_js), under: root)
        try write("upstream/web-write-coverage.js",
                  data: resData(dsh_spike_res_upstream_web_write_coverage_js), under: root)
        try write("upstream/web-write-llm.js",
                  data: resData(dsh_spike_res_upstream_web_write_llm_js), under: root)
        try write("upstream/preset-mobile-rows.js",
                  data: resData(dsh_spike_res_upstream_preset_mobile_rows_js), under: root)
        try write("upstream/web-write-files.js",
                  data: resData(dsh_spike_res_upstream_web_write_files_js), under: root)
        try write("upstream/web-write-picker.js",
                  data: resData(dsh_spike_res_upstream_web_write_picker_js), under: root)
        try write("upstream/web-write-workspace.js",
                  data: resData(dsh_spike_res_upstream_web_write_workspace_js), under: root)
        try write("upstream/web-write-inventory.js",
                  data: resData(dsh_spike_res_upstream_web_write_inventory_js), under: root)
    }
}