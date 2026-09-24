#!/usr/bin/env python3
"""Embed the runtime/spike JS bundle into the iOS app as C byte arrays.

The spike host loads ESM imports (logger.js, the vendored dsh package) from
disk under a bundle_root. Compiling the JS into the binary and staging it to
a writable sandbox directory at launch keeps the app free of asset-path
resolution: the bytes the simulator runs are byte-identical to the checkout.

Outputs are committed (App/Generated/) so a fresh clone builds without this
script; the Xcode pre-build phase re-runs it whenever an input changes.
"""

from pathlib import Path

HOSTS_IOS = Path(__file__).resolve().parents[1]
REPO = HOSTS_IOS.parents[1]
SPIKE = REPO / "runtime" / "spike"
OUT = HOSTS_IOS / "App" / "Generated"
GUARD = "DSH_IOS_SPIKE_BUNDLE_H"

# (accessor suffix, source file) -> dsh_spike_res_<suffix>()
RESOURCES = [
    ("logger_js", SPIKE / "logger.js"),
    ("gateway_js", SPIKE / "gateway.js"),
    ("registry_js", SPIKE / "registry.js"),
    ("install_pipeline_js", SPIKE / "install-pipeline.js"),
    ("sha256_js", SPIKE / "sha256.js"),
    ("tar_mini_js", SPIKE / "tar-mini.js"),
    ("manifest_json", SPIKE / "manifest.json"),
    ("scenario_js", SPIKE / "scenario" / "boot-verification.js"),
    ("scenario_m2_js", SPIKE / "scenario" / "gateway-binding.js"),
    ("scenario_m2_smoke_js", SPIKE / "scenario" / "gateway-bridge-smoke.js"),
    ("scenario_m2_session_js", SPIKE / "scenario" / "session-mock-llm.js"),
    ("scenario_carrier_js", SPIKE / "scenario" / "carrier-loopback.js"),
    # M2 real-LLM scenario + its client module (scenario llm.live-stream; the device
    # leg drives the real gateway httpFetch against the configured backend)
    ("llm_js", SPIKE / "llm.js"),
    ("scenario_m2_llm_js", SPIKE / "scenario" / "llm-live-stream.js"),
    # M3 completion: on-device fetch-install scenario + its new modules
    ("scenario_m3_fetch_install_js", SPIKE / "scenario" / "install-from-http.js"),
    # The upstream-parity differential's port leg (scenario + the SHARED
    # projector both legs normalize through; the spine itself is embedded by
    # the TREES below — this is the drive that proves it matches Node).
    ("scenario_upstream_parity_js", SPIKE / "scenario" / "upstream-parity.js"),
    ("scenario_parity_projector_js", SPIKE / "scenario" / "parity-projector.js"),
    # The upstream DSH test suite's on-device leg: the driver that imports
    # ONE transpiled upstream spec (staged under upstream-tests/ by the E2E
    # runner) + the quickjs-shaped vitest harness it redirects to.
    ("scenario_upstream_suite_js", SPIKE / "scenario" / "upstream-suite-leg.js"),
    ("scenario_upstream_harness_js", SPIKE / "scenario" / "upstream-test-harness.js"),
    # The agent-flow leg (the 打通流程 E2E): prompt override + skill loading
    # over the vendored skill family (the spine itself rides the TREES below;
    # the fixture skill is staged at runtime by the scenario itself).
    ("scenario_agent_flow_js", SPIKE / "scenario" / "agent-flow.js"),
    ("install_fetch_js", SPIKE / "install-fetch.js"),
    ("receipt_journal_js", SPIKE / "receipt-journal.js"),
    # M3 config layer: the install-full-cycle profile patch (cordis.patch, JSON)
    ("profile_m3_patch_json", SPIKE / "profiles" / "install-full-cycle" / "cordis.patch.json"),
    ("web_index_html", SPIKE / "web" / "index.html"),
    ("web_page_js", SPIKE / "web" / "carrier-page.js"),
    ("pkg_crypto_js",
     SPIKE / "vendor" / "dsh" / "util-crypto@0.1.6-alpha.2" / "lib" / "index.js"),
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
    # the dsh-notes fixture (M3 install pipeline: builder + plugin source data)
    ("fixture_notes_js", SPIKE / "fixtures" / "dsh-notes.js"),
    ("fixture_notes_source_js", SPIKE / "fixtures" / "dsh-notes-source.js"),
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
    ("scenario_b1_web_live_js", SPIKE / "scenario" / "officialweb-web-live.js"),
    ("upstream_web_boot_js", SPIKE / "upstream" / "web-boot.js"),
    ("upstream_web_shims_js", SPIKE / "upstream" / "web-shims.js"),
    ("shims_buffer_js", SPIKE / "upstream" / "shims" / "buffer.js"),
    ("shims_url_js", SPIKE / "upstream" / "shims" / "url.js"),
    ("shims_fs_js", SPIKE / "upstream" / "shims" / "fs.js"),
    ("shims_fs_workspace_js", SPIKE / "upstream" / "shims" / "fs-workspace.js"),
    ("shims_fs_promises_js", SPIKE / "upstream" / "shims" / "fs-promises.js"),
    ("shims_timers_promises_js", SPIKE / "upstream" / "shims" / "timers-promises.js"),
    ("shims_timers_js", SPIKE / "upstream" / "shims" / "timers.js"),
    ("shims_crypto_js", SPIKE / "upstream" / "shims" / "crypto.js"),
    # the upstream-suite globals (AbortController/structuredClone — installed by
    # the test harness before any spec imports; lives with the other shims)
    ("shims_globals_js", SPIKE / "upstream" / "shims" / "globals.js"),
    ("shims_node_perf_hooks_js", SPIKE / "upstream" / "shims" / "node-perf-hooks.js"),
    ("shims_node_addon_flock_js", SPIKE / "upstream" / "shims" / "node-addon-system-flock.js"),
    ("shims_expect_poll_js", SPIKE / "upstream" / "shims" / "expect-poll.js"),
    ("shims_node_zlib_js", SPIKE / "upstream" / "shims" / "node-zlib.js"),
    ("shims_node_worker_threads_js", SPIKE / "upstream" / "shims" / "node-worker-threads.js"),
    ("shims_node_stream_js", SPIKE / "upstream" / "shims" / "node-stream.js"),
    ("shims_describe_each_js", SPIKE / "upstream" / "shims" / "describe-each.js"),
    ("shims_node_module_js", SPIKE / "upstream" / "shims" / "node-module.js"),
    ("shims_path_js", SPIKE / "upstream" / "shims" / "path.js"),
    ("shims_npm_bridges_js", SPIKE / "upstream" / "shims" / "npm-bridges.js"),
    ("npm_cordis_js",
     SPIKE / "vendor" / "npm" / "cordis@4.0.2" / "lib" / "index.js"),
    ("npm_cosmokit_js",
     SPIKE / "vendor" / "npm" / "cosmokit@1.8.3" / "lib" / "index.js"),
    ("npm_schemastery_mjs",
     SPIKE / "vendor" / "npm" / "schemastery@3.18.2" / "lib" / "index.mjs"),
    ("npm_client_modules_index_js",
     SPIKE / "vendor" / "npm"
     / "@deepseek-ai/dsh-client-modules@0.1.6-alpha.2" / "lib" / "index.js"),
    ("npm_client_modules_client_js",
     SPIKE / "vendor" / "npm"
     / "@deepseek-ai/dsh-client-modules@0.1.6-alpha.2" / "lib" / "client.js"),
    # The commands plane's per-user receipt key: dsh-command-feedback imports
    # the anonymous user id at module load, so the bare specifier must have a
    # staged file (the npm-face base of the vendored probe serves it).
    ("npm_anonymous_user_id_js",
     SPIKE / "vendor" / "npm"
     / "@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2" / "lib" / "index.js"),
    # The MOBILE preset (the interactive seat's roster row): the standard
    # composition minus the three physically-walled rows (tool-fs-search,
    # workflow-ptc, tool-web). Staged into the vendored presets COPY (never
    # the tracked vendor tree) so the seed enumerator picks it up.
    ("presets_mobile_preset_yml",
     SPIKE / "presets-mobile" / "mobile" / "preset.yml"),
    ("presets_mobile_agent_cordis_yml",
     SPIKE / "presets-mobile" / "mobile" / "agent.cordis.yml"),
    # The agent-presets closure (the Agent 预设 panel's data source): the
    # presets service package plus the five dependency libs its import chain
    # resolves through the spike's bare map. js-yaml ships an ESM dist face.
    ("npm_agent_presets_index_js",
     SPIKE / "vendor" / "dsh" / "agent-presets@0.1.6-alpha.2" / "lib" / "index.js"),
    ("npm_plugin_loader_js",
     SPIKE / "vendor" / "npm" / "@deepseek-ai/cordis-plugin-loader@1.0.3" / "lib" / "index.js"),
    ("npm_plugin_include_js",
     SPIKE / "vendor" / "npm" / "@deepseek-ai/cordis-plugin-include@1.0.7" / "lib" / "index.js"),
    ("npm_js_yaml_mjs",
     SPIKE / "vendor" / "npm" / "js-yaml@4.1.0" / "dist" / "js-yaml.mjs"),
    # W-SESS spine closure (D9): the FULL upstream agent spine boots
    # on-device — the mobile profile boot, its settings backend, the gateway
    # llm transport, and the node shims the spine needs beyond the web-boot
    # set (async-hooks, util, util/types, os, process, the
    # session-persistence errors shim).
    ("upstream_boot_js", SPIKE / "upstream" / "boot.js"),
    ("upstream_settings_memory_js", SPIKE / "upstream" / "settings-memory.js"),
    ("upstream_llm_transport_js", SPIKE / "upstream" / "llm-transport.js"),
    ("scenario_b3_web_live_js", SPIKE / "scenario" / "session-web-live.js"),
    # W-RPC write surface (D9): the official app's composer send
    # (`POST /api/session/prompt`) answered from the REAL spine — the write
    # adapter plus the scenario that boots the runtime composed with it.
    ("upstream_web_write_js", SPIKE / "upstream" / "web-write.js"),
    ("upstream_web_write_inventory_js", SPIKE / "upstream" / "web-write-inventory.js"),
    ("upstream_web_write_streams_js", SPIKE / "upstream" / "web-write-streams.js"),
    ("upstream_web_write_settings_js", SPIKE / "upstream" / "web-write-settings.js"),
    # api-full-coverage (D9): the workspaceFiles / workspace / directoryPicker
    # / catalog coverage adapters of the write surface (claimed only under
    # the fullCoverage write option — the base claims stay byte-identical).
    ("upstream_web_write_files_js", SPIKE / "upstream" / "web-write-files.js"),
    ("upstream_web_write_picker_js", SPIKE / "upstream" / "web-write-picker.js"),
    ("upstream_web_write_workspace_js", SPIKE / "upstream" / "web-write-workspace.js"),
    ("upstream_web_write_coverage_js", SPIKE / "upstream" / "web-write-coverage.js"),
    ("upstream_web_write_llm_js", SPIKE / "upstream" / "web-write-llm.js"),
    ("upstream_web_write_catalog_js", SPIKE / "upstream" / "web-write-catalog.js"),
    ("scenario_b4_web_live_js", SPIKE / "scenario" / "composer-web-live.js"),
    ("shims_async_hooks_js", SPIKE / "upstream" / "shims" / "async-hooks.js"),
    ("shims_util_js", SPIKE / "upstream" / "shims" / "util.js"),
    ("shims_util_types_js", SPIKE / "upstream" / "shims" / "util-types.js"),
    ("shims_os_js", SPIKE / "upstream" / "shims" / "os.js"),
    ("shims_process_js", SPIKE / "upstream" / "shims" / "process.js"),
    ("shims_dsh_session_persistence_js",
     SPIKE / "upstream" / "shims" / "dsh-session-persistence.js"),
    # The outboard WebAssembly tool plugin (contract v1.2.0): a service plugin
    # that registers the model-facing `wasm_run` tool into the spine.
    ("plugin_shell_wasm_manifest",
     SPIKE / "system-plugins" / "dsh-shell-wasm" / "manifest.json"),
    ("plugin_shell_wasm_js",
     SPIKE / "system-plugins" / "dsh-shell-wasm" / "index.js"),
    # The outboard in-process Linux shell (contract v1.3.0): the same shape,
    # with the guest engine's `ishRun` behind it.
    ("plugin_shell_ish_manifest",
     SPIKE / "system-plugins" / "dsh-shell-ish" / "manifest.json"),
    ("plugin_shell_ish_js",
     SPIKE / "system-plugins" / "dsh-shell-ish" / "index.js"),
]

# Directory trees embedded whole and staged back under the same
# bundle-relative paths: the vendored upstream spine packages (verbatim
# lib/ trees, the loader's `vendor/dsh/<pkg>@<ver>/lib/**` map). Trees are
# UNTRACKED upstream code — embedded from the materialized vendor checkout,
# sha256-pinned by ensure-dsh.sh.
TREES = [
    (f"vendor/dsh/{pkg}@0.1.6-alpha.2",
     SPIKE / "vendor" / "dsh" / f"{pkg}@0.1.6-alpha.2")
    for pkg in [
        "agent", "agent-loop", "brand", "llm", "sandbox", "scope",
        "agent-presets", "atomic-write", "home-paths",
        "fs", "attachment", "fs-local", "tool-fs", "tool-str-replace-editor",
        "session", "session-projection", "settings", "system-prompt",
        "session-persistence",
        "commands", "command-feedback",
        "timeout", "tool-todo", "tools", "typert-protocol", "util-values",
        # The interactive circle (the "/" surface's session plugins): these
        # ride the preset health check — every row of the mobile preset
        # resolves against the seeded markers, so the packages must be
        # embedded, not merely present in a dev tree.
        "persona", "agent-instructions", "plan-mode", "command-goal",
        "tool-goal", "tool-jobs", "tool-ask-user", "tool-subagent",
        "tool-subagent-control", "tool-workflow", "compaction-basic",
        "command-compact", "compaction-tool-result-pruner", "credentials",
        "terminal", "goal", "jobs", "output-retention", "user-questions",
        "chunked-list", "util-time", "subagent", "workflow", "compaction",
        "token-meter",
        # the SKILL row (the agent-flow E2E): the ctx.skills registry, the
        # filesystem discovery provider, and the model-facing `skill` tool.
        "skill", "skill-filesystem", "tool-skill",
    ]
] + [
    # present/ralph/bash/pwsh (the mobile preset's shell surface): pinned on
    # the NPM face (ensure-dsh.sh fetches the published tarballs; the mirror
    # serves no vendor/dsh tree for them) but STAGED at the vendor/dsh/<pkg>
    # @ver rel path — the dir the preset-health marker seeder walks.
    *(("vendor/dsh/%s@0.1.6-alpha.2" % n,
       SPIKE / "vendor" / "npm" / "@deepseek-ai" / ("dsh-%s@0.1.6-alpha.2" % n))
      for n in ("tool-present", "tool-ralph", "tool-bash", "tool-pwsh")),
] + [
    # api-full-coverage (D9): the vendored services the coverage rows mount —
    # the event-sourced goal service (goals/*) and the local file-reference
    # discovery (fileReferences/list, with its base package). Dynamic imports
    # of boot.js's gated GOAL/FILE-REFERENCE rows; absent trees would refuse
    # the coverage boot loud, so they ride the embed with the adapters.
    ("vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2",
     SPIKE / "vendor" / "npm" / "@deepseek-ai" / "dsh-goal@0.1.6-alpha.2"),
    ("vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2",
     SPIKE / "vendor" / "npm" / "@deepseek-ai" / "dsh-file-reference@0.1.6-alpha.2"),
    ("vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2",
     SPIKE / "vendor" / "npm" / "@deepseek-ai" / "dsh-file-reference-local@0.1.6-alpha.2"),
] + [
    # the npm `diff` bridge target (upstream/shims/npm-bridges.js re-exports
    # vendor/npm/diff@9.0.0/libesm/index.js behind the bare specifier the
    # vendored tool-fs imports for structuredPatch)
    ("vendor/npm/diff@9.0.0/libesm",
     SPIKE / "vendor" / "npm" / "diff@9.0.0" / "libesm"),
    # the npm `yaml` bridge target (the SKILL row): upstream/shims/
    # npm-bridges.js re-exports the browser/ ESM face behind the bare
    # specifier @deepseek-ai/dsh-skill-filesystem imports for frontmatter
    # (the package's "node" face is CJS, which the loader cannot serve).
    ("vendor/npm/yaml@2.9.0/browser",
     SPIKE / "vendor" / "npm" / "yaml@2.9.0" / "browser"),
] + [
    # the pinned npm packages' package.json (the node-module shim serves the
    # upstream attribution reads: `require('../package.json')`) — the lib/
    # bundles themselves are embedded individually in RESOURCES above.
    ("vendor/npm/cordis@4.0.2/package.json",
     SPIKE / "vendor" / "npm" / "cordis@4.0.2" / "package.json"),
    ("vendor/npm/cosmokit@1.8.3/package.json",
     SPIKE / "vendor" / "npm" / "cosmokit@1.8.3" / "package.json"),
    ("vendor/npm/schemastery@3.18.2/package.json",
     SPIKE / "vendor" / "npm" / "schemastery@3.18.2" / "package.json"),
    ("vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/package.json",
     SPIKE / "vendor" / "npm"
     / "@deepseek-ai/dsh-client-modules@0.1.6-alpha.2" / "package.json"),
]

# The pinned zod's runtime closure: `zod` → index.js → the classic build's
# relative import graph (computed once by walking imports from index.js at
# the pin). The rest of the package (src/, v3/, mini/, .d.ts) never loads.
ZOD_ROOT = ("vendor/npm/zod@4.4.3", SPIKE / "vendor" / "npm" / "zod@4.4.3")
ZOD_FILES = [
    "index.js",
    "v4/classic/checks.js",
    "v4/classic/coerce.js",
    "v4/classic/compat.js",
    "v4/classic/errors.js",
    "v4/classic/external.js",
    "v4/classic/from-json-schema.js",
    "v4/classic/iso.js",
    "v4/classic/parse.js",
    "v4/classic/schemas.js",
    "v4/core/api.js",
    "v4/core/checks.js",
    "v4/core/core.js",
    "v4/core/doc.js",
    "v4/core/errors.js",
    "v4/core/index.js",
    "v4/core/json-schema-generator.js",
    "v4/core/json-schema-processors.js",
    "v4/core/json-schema.js",
    "v4/core/parse.js",
    "v4/core/regexes.js",
    "v4/core/registries.js",
    "v4/core/schemas.js",
    "v4/core/to-json-schema.js",
    "v4/core/util.js",
    "v4/core/versions.js",
    "v4/locales/ar.js",
    "v4/locales/az.js",
    "v4/locales/be.js",
    "v4/locales/bg.js",
    "v4/locales/ca.js",
    "v4/locales/cs.js",
    "v4/locales/da.js",
    "v4/locales/de.js",
    "v4/locales/el.js",
    "v4/locales/en.js",
    "v4/locales/eo.js",
    "v4/locales/es.js",
    "v4/locales/fa.js",
    "v4/locales/fi.js",
    "v4/locales/fr-CA.js",
    "v4/locales/fr.js",
    "v4/locales/he.js",
    "v4/locales/hr.js",
    "v4/locales/hu.js",
    "v4/locales/hy.js",
    "v4/locales/id.js",
    "v4/locales/index.js",
    "v4/locales/is.js",
    "v4/locales/it.js",
    "v4/locales/ja.js",
    "v4/locales/ka.js",
    "v4/locales/kh.js",
    "v4/locales/km.js",
    "v4/locales/ko.js",
    "v4/locales/lt.js",
    "v4/locales/mk.js",
    "v4/locales/ms.js",
    "v4/locales/nl.js",
    "v4/locales/no.js",
    "v4/locales/ota.js",
    "v4/locales/pl.js",
    "v4/locales/ps.js",
    "v4/locales/pt.js",
    "v4/locales/ro.js",
    "v4/locales/ru.js",
    "v4/locales/sl.js",
    "v4/locales/sv.js",
    "v4/locales/ta.js",
    "v4/locales/th.js",
    "v4/locales/tr.js",
    "v4/locales/ua.js",
    "v4/locales/uk.js",
    "v4/locales/ur.js",
    "v4/locales/uz.js",
    "v4/locales/vi.js",
    "v4/locales/yo.js",
    "v4/locales/zh-CN.js",
    "v4/locales/zh-TW.js",
]


def collect_tree_files():
    """The staged tree: (bundle_relative_path, absolute source path), in
    stable order (trees first, then the zod list)."""
    out = []
    for rel_dir, src_dir in TREES:
        if src_dir.is_file():
            out.append((rel_dir, src_dir))
            continue
        if not src_dir.is_dir():
            # absent tree = silent-empty rglob = the row vanishes (2026-09-24 drift)
            raise SystemExit(
                f"gen_bundle_header: TREES row {rel_dir!r} source missing: "
                f"{src_dir} — fix the row or run ensure-dsh.sh")
        for path in sorted(src_dir.rglob("*")):
            if path.is_file() and path.suffix in (".js", ".mjs", ".json", ".yaml", ".yml", ".md"):
                out.append((f"{rel_dir}/{path.relative_to(src_dir)}", path))
    rel_root, abs_root = ZOD_ROOT
    for rel in ZOD_FILES:
        out.append((f"{rel_root}/{rel}", abs_root / rel))
    return out


def c_array(symbol: str, data: bytes, raw: bytes) -> str:
    if b"\x00" in raw:
        raise SystemExit(f"gen_bundle_header: {symbol} contains a NUL byte")
    rows = []
    for at in range(0, len(raw), 16):
        chunk = ", ".join(f"0x{b:02x}" for b in raw[at:at + 16])
        rows.append(f"  {chunk},")
    body = "\n".join(rows)
    # trailing NUL keeps the array a valid C string (dsh_spike_eval strlens)
    return f"static const unsigned char {symbol}[] = {{\n{body}\n  0x00\n}};\n"


def emit_resources(parts: list, decls: list, funcs: list) -> None:
    for suffix, path in RESOURCES:
        if not path.is_file():
            raise SystemExit(f"gen_bundle_header: missing input {path}")
        symbol = f"DSH_{suffix.upper()}"
        raw = path.read_bytes()
        data = raw + b"\x00"
        parts.append(f"/* {path.relative_to(REPO)} ({len(data) - 1} bytes) */\n{c_array(symbol, data, raw)}")
        decls.append(f"const char *dsh_spike_res_{suffix}(size_t *len);")
        funcs.append(
            f"const char *dsh_spike_res_{suffix}(size_t *len) {{\n"
            f"  if (len) *len = sizeof({symbol}) - 1;\n"
            f"  return (const char *){symbol};\n"
            f"}}\n"
        )


def tree_c_source(tree: list) -> str:
    """The staged tree as one C section: per-file arrays addressed by a
    single index accessor (the Swift stager walks it without N decls)."""
    tree_arrays, tree_paths, tree_lens = [], [], []
    for i, (rel, path) in enumerate(tree):
        if not path.is_file():
            raise SystemExit(f"gen_bundle_header: missing tree input {path}")
        symbol = f"DSH_TREE_{i:03d}"
        raw = path.read_bytes()
        if b"\x00" in raw:
            raise SystemExit(f"gen_bundle_header: {rel} contains a NUL byte")
        tree_arrays.append(
            f"/* {path.relative_to(REPO)} ({len(raw)} bytes) */\n{c_array(symbol, raw, raw)}")
        tree_paths.append(f'  "{rel}",')
        tree_lens.append(f"  sizeof({symbol}) - 1,")
    data_idx_rows = "\n".join(
        "  DSH_TREE_%03d," % i for i in range(len(tree)))
    parts_head = [
        "/* ---- the staged tree (vendored spine packages + zod closure) ---- */\n",
        "\n".join(tree_arrays),
        "\nstatic const char *const DSH_TREE_PATHS[] = {\n",
        "\n".join(tree_paths),
        "\n};\n\nstatic const unsigned char *const DSH_TREE_DATA[] = {\n",
        data_idx_rows,
        "\n};\n\nstatic const size_t DSH_TREE_LENS[] = {\n",
        "\n".join(tree_lens),
        "\n};\n\n",
    ]
    walker = [
        "int dsh_spike_bundle_tree_file(size_t index, const char **path,\n",
        "  const char **data, size_t *len) {\n",
        "  if (index >= %d) return 0;\n" % len(tree),
        "  if (path) *path = DSH_TREE_PATHS[index];\n",
        "  if (data) *data = DSH_TREE_DATA[index];\n",
        "  if (len) *len = DSH_TREE_LENS[index];\n",
        "  return 1;\n",
        "}\n",
    ]
    return "".join(parts_head) + "".join(walker)


TREE_WALKER_DECL = (
    "/* The staged tree walker (vendored spine packages + zod closure):\n"
    " * fills path/data/len for `index`, returns 0 past the end. */\n"
    "int dsh_spike_bundle_tree_file(size_t index, const char **path,\n"
    " const char **data, size_t *len);")


def emit() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    parts, decls, funcs = [], [], []
    emit_resources(parts, decls, funcs)
    tree = collect_tree_files()
    parts.append(tree_c_source(tree))
    decls.append(TREE_WALKER_DECL)
    total = sum(p.stat().st_size for _, p in tree)
    print(f"gen_bundle_header: tree = {len(tree)} files, {total} bytes "
          f"({total / 1024:.0f} KiB)")

    header = "\n".join([
        "/* Generated by hosts/ios/Tools/gen_bundle_header.py — do not edit.",
        " * Re-embeds the runtime/spike JS bundle (byte arrays, NUL-terminated). */",
        f"#ifndef {GUARD}",
        f"#define {GUARD}",
        "",
        "#include <stddef.h>",
        "",
        *decls,
        "",
        f"#endif /* {GUARD} */",
        "",
    ])
    source = "\n".join([
        "/* Generated by hosts/ios/Tools/gen_bundle_header.py — do not edit. */",
        '#include "SpikeBundle.h"',
        "",
        *parts,
        *funcs,
    ])
    (OUT / "SpikeBundle.h").write_text(header, encoding="utf-8")
    (OUT / "SpikeBundle.c").write_text(source, encoding="utf-8")
    print(f"gen_bundle_header: wrote {OUT / 'SpikeBundle.c'} + .h")


if __name__ == "__main__":
    emit()
