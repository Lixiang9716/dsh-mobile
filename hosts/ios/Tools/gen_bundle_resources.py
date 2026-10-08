"""gen_bundle_resources — the RESOURCES accession table split out of
gen_bundle_header.py at the code-size gate (the file crossed 500 lines
when the web-live relocation round added its rows). Pure data: the
(suffix, path) pairs the iOS embedder stages as C arrays."""
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent.parent
DSH = REPO / "runtime" / "dsh"

RESOURCES = [
    ("logger_js", DSH / "logger.js"),
    # The cross-layer transport/E2E token table — scenarios call
    # createLogger(scenarioModule) importing it bundle-root-relative; the
    # scenario TREES row embeds the importers, this row the imported.
    ("transport_tokens_mjs", DSH / "transport-tokens.mjs"),
    # M2 real-LLM scenario + its client module (scenario llm.live-stream; the device
    # leg drives the real gateway httpFetch against the configured backend)
    # M3 completion: on-device fetch-install scenario + its new modules
    # The upstream-parity differential's port leg (scenario + the SHARED
    # projector both legs normalize through; the spine itself is embedded by
    # the TREES below — this is the drive that proves it matches Node).
    # The upstream DSH test suite's on-device leg: the driver that imports
    # ONE transpiled upstream spec (staged under upstream-tests/ by the E2E
    # runner) + the quickjs-shaped vitest harness it redirects to.
    # The agent-flow leg (the 打通流程 E2E): prompt override + skill loading
    # over the vendored skill family (the spine itself rides the TREES below;
    # the fixture skill is staged at runtime by the scenario itself).
    ("receipt_journal_js", DSH / "receipt-journal.js"),
    # M3 config layer: the install-full-cycle profile patch (cordis.patch, JSON)
    ("profile_m3_patch_json", DSH / "profiles" / "install-full-cycle" / "cordis.patch.json"),
    ("web_index_html", DSH / "web" / "index.html"),
    ("web_page_js", DSH / "web" / "carrier-page.js"),
    ("pkg_crypto_js",
     DSH / "vendor" / "dsh" / "util-crypto@0.1.6-alpha.2" / "lib" / "index.js"),
    # system implementation plugins (repo-root tree, staged bundle-relative
    # under system-plugins/ — the scenario's canonical import specifier)
    ("plugin_fs_manifest", REPO / "system-plugins" / "dsh-fs" / "manifest.json"),
    ("plugin_fs_js", REPO / "system-plugins" / "dsh-fs" / "index.js"),
    ("plugin_subprocess_manifest",
     REPO / "system-plugins" / "dsh-subprocess-quickjs" / "manifest.json"),
    ("plugin_subprocess_js",
     REPO / "system-plugins" / "dsh-subprocess-quickjs" / "index.js"),
    ("plugin_ui_manifest", REPO / "system-plugins" / "dsh-ui" / "manifest.json"),
    ("plugin_ui_js", REPO / "system-plugins" / "dsh-ui" / "index.js"),
    ("plugin_device_plane_manifest",
     REPO / "system-plugins" / "dsh-device-plane" / "manifest.json"), ("plugin_device_plane_js",
     REPO / "system-plugins" / "dsh-device-plane" / "index.js"),
    ("plugin_ble_manifest", REPO / "system-plugins" / "dsh-ble" / "manifest.json"), ("plugin_ble_js", REPO / "system-plugins" / "dsh-ble" / "index.js"),
    # the dsh-notes fixture (M3 install pipeline: builder + plugin source data)
    ("fixture_notes_js", DSH / "fixtures" / "dsh-notes.js"),
    ("fixture_notes_source_js", DSH / "fixtures" / "dsh-notes-source.js"),
    # the ACTIVE Web Client plugin (presentation/, type=web-client, web/ dir)
    ("webclient_manifest", REPO / "presentation" / "web-client" / "manifest.json"),
    ("webclient_index_html", REPO / "presentation" / "web-client" / "web" / "index.html"),
    ("webclient_main_js", REPO / "presentation" / "web-client" / "web" / "main.js"),
    # the SECOND Web Client variant (M3 UI pluggability: config-selected swap)
    ("webclient_mini_manifest",
     REPO / "presentation" / "web-client-mini" / "manifest.json"),
    ("webclient_mini_index_html",
     REPO / "presentation" / "web-client-mini" / "web" / "index.html"),
    ("webclient_mini_main_js",
     REPO / "presentation" / "web-client-mini" / "web" / "main.js"),
    # W-INTEG web-boot closure: the OFFICIAL web boot producer scenario plus
    # the upstream web-boot adapter, its shims, and the vendored npm libs the
    # composition imports (cordis -> cosmokit; schemastery -> cosmokit; the
    # client-modules node + browser faces). NOT the full agent spine — the
    # officialweb-web-live drive composes the boot wire without runtime services.
    ("upstream_web_boot_js", DSH / "upstream" / "web-boot.js"),
    ("upstream_web_shims_js", DSH / "upstream" / "web-shims.js"),
    # The WEB plane's mobile search provider (#335 B5): boot.js imports it
    # statically (the mount + the inventory web tiers ride it).
    ("upstream_web_search_keyless_js", DSH / "upstream" / "web-search-keyless.js"),
    ("npm_cordis_js",
     DSH / "vendor" / "npm" / "cordis@4.0.2" / "lib" / "index.js"),
    ("npm_cosmokit_js",
     DSH / "vendor" / "npm" / "cosmokit@1.8.3" / "lib" / "index.js"),
    ("npm_schemastery_mjs",
     DSH / "vendor" / "npm" / "schemastery@3.18.2" / "lib" / "index.mjs"),
    ("npm_client_modules_index_js",
     DSH / "vendor" / "npm"
     / "@deepseek-ai/dsh-client-modules@0.1.6-alpha.2" / "lib" / "index.js"),
    ("npm_client_modules_client_js",
     DSH / "vendor" / "npm"
     / "@deepseek-ai/dsh-client-modules@0.1.6-alpha.2" / "lib" / "client.js"),
    # The commands plane's per-user receipt key: dsh-command-feedback imports
    # the anonymous user id at module load, so the bare specifier must have a
    # staged file (the npm-face base of the vendored probe serves it).
    ("npm_anonymous_user_id_js",
     DSH / "vendor" / "npm"
     / "@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2" / "lib" / "index.js"),
    # The MOBILE preset (the interactive seat's roster row): the standard
    # composition minus the three physically-walled rows (tool-fs-search,
    # workflow-ptc, tool-web). Staged into the vendored presets COPY (never
    # the tracked vendor tree) so the seed enumerator picks it up.
    ("presets_mobile_preset_yml",
     DSH / "presets-mobile" / "mobile" / "preset.yml"),
    ("presets_mobile_agent_cordis_yml",
     DSH / "presets-mobile" / "mobile" / "agent.cordis.yml"),
    # The agent-presets closure (the Agent 预设 panel's data source): the
    # presets service package plus the five dependency libs its import chain
    # resolves through the dsh's bare map. js-yaml ships an ESM dist face.
    ("npm_agent_presets_index_js",
     DSH / "vendor" / "dsh" / "agent-presets@0.1.6-alpha.2" / "lib" / "index.js"),
    ("npm_plugin_loader_js",
     DSH / "vendor" / "npm" / "@deepseek-ai/cordis-plugin-loader@1.0.3" / "lib" / "index.js"),
    ("npm_plugin_include_js",
     DSH / "vendor" / "npm" / "@deepseek-ai/cordis-plugin-include@1.0.7" / "lib" / "index.js"),
    ("npm_js_yaml_mjs",
     DSH / "vendor" / "npm" / "js-yaml@4.1.0" / "dist" / "js-yaml.mjs"),
    # W-SESS spine closure (D9): the FULL upstream agent spine boots
    # on-device — the mobile profile boot, its settings backend, the gateway
    # llm transport, and the node shims the spine needs beyond the web-boot
    # set (async-hooks, util, util/types, os, process, the
    # session-persistence errors shim).
    ("upstream_boot_js", DSH / "upstream" / "boot.js"),
    ("upstream_wire_logger_js", DSH / "upstream" / "wire-logger.js"),
    ("upstream_llm_route_js", DSH / "upstream" / "llm-route.js"),
    ("upstream_settings_memory_js", DSH / "upstream" / "settings-memory.js"),
    # W-RPC write surface (D9): the composer's `POST /api/session/prompt` from
    # the REAL spine — the write adapter + its booting scenario.
    ("upstream_web_write_js", DSH / "upstream" / "web-write.js"),
    ("upstream_web_write_session_js", DSH / "upstream" / "web-write-session.js"),
    ("upstream_web_write_presets_js", DSH / "upstream" / "web-write-presets.js"),
    ("upstream_boot_subagent_rows_js", DSH / "upstream" / "boot-subagent-rows.js"),
    ("upstream_web_write_subagents_js", DSH / "upstream" / "web-write-subagents.js"),
    ("upstream_web_write_inventory_js", DSH / "upstream" / "web-write-inventory.js"),
    ("upstream_web_write_streams_js", DSH / "upstream" / "web-write-streams.js"),
    ("upstream_web_write_settings_js", DSH / "upstream" / "web-write-settings.js"),
    # api-full-coverage (D9): coverage adapters + llm/credential legs + the preset
    # mobile-row transform (claimed under fullCoverage — byte-identical base).
    ("upstream_web_write_files_js", DSH / "upstream" / "web-write-files.js"),
    ("upstream_web_write_picker_js", DSH / "upstream" / "web-write-picker.js"),
    ("upstream_web_write_workspace_js", DSH / "upstream" / "web-write-workspace.js"),
    ("upstream_web_write_coverage_js", DSH / "upstream" / "web-write-coverage.js"),
    ("upstream_web_write_llm_js", DSH / "upstream" / "web-write-llm.js"),
    ("upstream_preset_mobile_rows_js", DSH / "upstream" / "preset-mobile-rows.js"),
    ("shims_util_js", DSH / "upstream" / "shims" / "util.js"),
    ("shims_util_types_js", DSH / "upstream" / "shims" / "util-types.js"),
    ("shims_os_js", DSH / "upstream" / "shims" / "os.js"),
    ("shims_process_js", DSH / "upstream" / "shims" / "process.js"),
    ("shims_dsh_session_persistence_js", DSH / "upstream" / "shims" / "dsh-session-persistence.js"),
    # The outboard WebAssembly tool plugin (contract v1.2.0): a service plugin
    # that registers the model-facing `wasm_run` tool into the spine.
    ("plugin_shell_wasm_manifest",
     DSH / "system-plugins" / "dsh-shell-wasm" / "manifest.json"),
    ("plugin_shell_wasm_js",
     DSH / "system-plugins" / "dsh-shell-wasm" / "index.js"),
    ("plugin_shell_wasm_programs_js",
     DSH / "system-plugins" / "dsh-shell-wasm" / "programs.js"),
    # The outboard in-process Linux shell (contract v1.3.0): the same shape,
    # with the guest engine's `ishRun` behind it.
    ("plugin_shell_ish_manifest", DSH / "system-plugins" / "dsh-shell-ish" / "manifest.json"), ("plugin_shell_ish_js", DSH / "system-plugins" / "dsh-shell-ish" / "index.js"),
    # The Open Design client plugin: the design daemon's REST surface over
    # gateway httpFetch (projects / BYOK generate / artifact save+lint).
    ("plugin_open_design_manifest", DSH / "system-plugins" / "dsh-open-design" / "manifest.json"), ("plugin_open_design_js", DSH / "system-plugins" / "dsh-open-design" / "index.js"),
    # The plugin_manager tool row (#346); face at workspace_registry_js.
    ("plugin_manager_tools_manifest",
     DSH / "system-plugins" / "dsh-plugin-manager-tools" / "manifest.json"), ("plugin_manager_tools_js", DSH / "system-plugins" / "dsh-plugin-manager-tools" / "index.js"),
    # FIFTEEN scenario files keep NAMED accessors — RESOURCES rows emit the
    # dsh_runtime_res_<suffix> symbols Swift links against (readers:
    # JsRuntime, GatewaySession, SessionRuntime, SessionServe,
    # SessionLiveRuntime, WebBootRuntimeDrive, CarrierRuntime, AppDelegate);
    # the whole-dir scenario tree row serves the loader's file view
    # (926c6a7 dropped this block while every read site stayed — restored).
    # The four PRODUCT boot producers now live under web-live/ (suffixes keep
    # their historical names — the Swift link sites are unchanged).
    ("scenario_js", DSH / "scenario" / "boot-verification.js"),
    ("scenario_m2_js", DSH / "scenario" / "gateway-binding.js"),
    ("scenario_device_plane_js", DSH / "scenario" / "device-plane.js"),
    ("scenario_ble_plane_js", DSH / "scenario" / "ble-plane.js"),
    ("scenario_camera_plane_js", DSH / "scenario" / "camera-plane.js"),
    ("scenario_mic_plane_js", DSH / "scenario" / "mic-plane.js"),
    ("scenario_m2_session_js", DSH / "scenario" / "session-mock-llm.js"),
    ("scenario_carrier_js", DSH / "scenario" / "carrier-loopback.js"),
    ("scenario_m2_llm_js", DSH / "scenario" / "llm-live-stream.js"),
    ("scenario_m3_fetch_install_js", DSH / "scenario" / "install-from-http.js"),
    ("scenario_upstream_parity_js", DSH / "scenario" / "upstream-parity.js"),
    ("scenario_upstream_suite_js", DSH / "scenario" / "upstream-suite-leg.js"),
    ("scenario_agent_flow_js", DSH / "scenario" / "agent-flow.js"),
    ("scenario_b1_web_live_js", DSH / "web-live" / "officialweb-web-live.js"), ("scenario_b3_web_live_js", DSH / "web-live" / "session-web-live.js"),
    ("scenario_b4_web_live_js", DSH / "web-live" / "composer-web-live.js"),
    ("scenario_manager_legs_probe_js", DSH / "web-live" / "manager-legs-probe.js"),
    # The dsh-root runtime files + upstream adapters Swift stages by name
    # (BundleStager / SessionServe / SessionRuntime) — the pre-refactor
    # RESOURCES rows, restored.
    ("gateway_js", DSH / "gateway.js"),
    ("registry_js", DSH / "registry.js"),
    ("manifest_json", DSH / "manifest.json"),
    ("llm_js", DSH / "llm.js"),
    ("install_pipeline_js", DSH / "install-pipeline.js"),
    ("ed25519_js", DSH / "ed25519.js"), ("canonical_json_js", DSH / "canonical-json.js"),
    ("marketplace_resolver_js", DSH / "marketplace-resolver.js"),
    ("install_fetch_js", DSH / "install-fetch.js"),
    ("workspace_registry_js", DSH / "workspace-registry.js"), ("sha256_js", DSH / "sha256.js"),
    ("tar_mini_js", DSH / "tar-mini.js"),
    ("upstream_llm_transport_js", DSH / "upstream" / "llm-transport.js"),
    ("upstream_llm_read_idle_js", DSH / "upstream" / "llm-read-idle.js"), ("upstream_llm_retry_pacing_js", DSH / "upstream" / "llm-retry-pacing.js"),
    ("upstream_tool_present_js", DSH / "upstream" / "tool-present.js"),
    ("upstream_model_selection_projection_js", DSH / "upstream" / "model-selection-projection.js"),
    ("upstream_model_selection_holder_js", DSH / "upstream" / "model-selection-holder.js"),
    ("upstream_web_write_catalog_js", DSH / "upstream" / "web-write-catalog.js"),
    ("upstream_web_write_onboarding_js", DSH / "upstream" / "web-write-onboarding.js"),
    ("upstream_web_write_marketplace_js", DSH / "upstream" / "web-write-marketplace.js"),
    # issue #335 A1+B3: the pluginManager WRITE legs (§4 pipeline + receipts
    # journal + workspace registry) and the dynamicCordisRunner runtime-side
    # legs (the honest mobile cordis answers).
    ("upstream_web_write_plugin_manager_js", DSH / "upstream" / "web-write-plugin-manager.js"),
    ("upstream_web_write_cordis_js", DSH / "upstream" / "web-write-cordis.js"),
    # the #323 guard rings + loop-u's recovery face (llm-retry rides the vendor pin)
    ("upstream_tool_deadline_js", DSH / "upstream" / "tool-deadline.js"),
    # loop-z3: the editor tool face's relative-path anchor (boot.js mounts the vendored editor through it)
    ("upstream_tool_path_anchor_js", DSH / "upstream" / "tool-path-anchor.js"),
    ("upstream_turn_watchdog_js", DSH / "upstream" / "turn-watchdog.js"),
    ("upstream_turn_recovery_js", DSH / "upstream" / "turn-recovery.js"),
    ("upstream_retry_telemetry_js", DSH / "upstream" / "retry-telemetry.js"),
    ("upstream_boot_coverage_rows_js", DSH / "upstream" / "boot-coverage-rows.js"),
]
# Directory trees embedded whole and staged back under the same
# bundle-relative paths: the vendored upstream spine packages (verbatim
# lib/ trees, the loader's `vendor/dsh/<pkg>@<ver>/lib/**` map) — UNTRACKED
# upstream code, embedded from the materialized vendor checkout.
