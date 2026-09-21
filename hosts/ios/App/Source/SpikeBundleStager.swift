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
        try write("scenario/m1-spike-boot.js", data: resData(dsh_spike_res_scenario_js),
                  under: root)
        try write("scenario/m2-gateway-binding.js",
                  data: resData(dsh_spike_res_scenario_m2_js), under: root)
        try write("scenario/m2-bridge-smoke.js",
                  data: resData(dsh_spike_res_scenario_m2_smoke_js), under: root)
        try write("scenario/m1-carrier-loopback.js",
                  data: resData(dsh_spike_res_scenario_carrier_js), under: root)
        try write("registry.js", data: resData(dsh_spike_res_registry_js), under: root)
        try write("install-pipeline.js",
                  data: resData(dsh_spike_res_install_pipeline_js), under: root)
        try write("sha256.js", data: resData(dsh_spike_res_sha256_js), under: root)
        try write("tar-mini.js", data: resData(dsh_spike_res_tar_mini_js), under: root)
        try writeScenarioEntries(root)
        try writePluginsAndClients(root)
        try write("web/index.html", data: resData(dsh_spike_res_web_index_html),
                  under: root)
        try write("web/carrier-page.js", data: resData(dsh_spike_res_web_page_js),
                  under: root)
        try write("vendor/dsh/util-crypto@0.1.6-alpha.1/lib/index.js",
                  data: resData(dsh_spike_res_pkg_crypto_js), under: root)
        return root
    }

    /// Scenario entries (the m1/m2 E2E scenarios, plus the M3 on-device
    /// fetch-install scenario and its modules + the profile config patch,
    /// and the M2 real-LLM scenario with its client module).
    private static func writeScenarioEntries(_ root: URL) throws {
        try write("scenario/m2-session.js",
                  data: resData(dsh_spike_res_scenario_m2_session_js), under: root)
        try write("scenario/m3-fetch-install.js",
                  data: resData(dsh_spike_res_scenario_m3_fetch_install_js), under: root)
        try write("scenario/m2-llm.js",
                  data: resData(dsh_spike_res_scenario_m2_llm_js), under: root)
        try write("llm.js", data: resData(dsh_spike_res_llm_js), under: root)
        try write("install-fetch.js",
                  data: resData(dsh_spike_res_install_fetch_js), under: root)
        try write("receipt-journal.js",
                  data: resData(dsh_spike_res_receipt_journal_js), under: root)
        try write("profiles/m3-complete/cordis.patch.json",
                  data: resData(dsh_spike_res_profile_m3_patch_json), under: root)
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
