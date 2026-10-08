#!/usr/bin/env python3
"""Embed the runtime/dsh JS bundle into the iOS app as C byte arrays.

The dsh host loads ESM imports from disk under a bundle_root; compiling
the JS into the binary and staging it to a writable sandbox at launch keeps
the bytes the simulator runs byte-identical to the checkout. Outputs are
committed (App/Generated/) so a fresh clone builds without this script.
"""

from pathlib import Path

import gen_bundle_trees as trees

HOSTS_IOS = Path(__file__).resolve().parents[1]
REPO = HOSTS_IOS.parents[1]
DSH = REPO / "runtime" / "dsh"
OUT = HOSTS_IOS / "App" / "Generated"
GUARD = "DSH_IOS_SPIKE_BUNDLE_H"

# (accessor suffix, source file) -> dsh_runtime_res_<suffix>()
from gen_bundle_resources import RESOURCES

TREES = [
    ("vendor/dsh/agent@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "agent@0.1.6-alpha.2"),
    ("vendor/dsh/agent-loop@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "agent-loop@0.1.6-alpha.2"),
    ("vendor/dsh/brand@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "brand@0.1.6-alpha.2"),
    ("vendor/dsh/llm@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "llm@0.1.6-alpha.2"),
    ("vendor/dsh/sandbox@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "sandbox@0.1.6-alpha.2"),
    ("vendor/dsh/scope@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "scope@0.1.6-alpha.2"),
    ("vendor/dsh/agent-presets@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "agent-presets@0.1.6-alpha.2"),
    ("vendor/dsh/atomic-write@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "atomic-write@0.1.6-alpha.2"),
    ("vendor/dsh/home-paths@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "home-paths@0.1.6-alpha.2"),
    ("vendor/dsh/fs@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "fs@0.1.6-alpha.2"),
    ("vendor/dsh/attachment@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "attachment@0.1.6-alpha.2"),
    ("vendor/dsh/fs-local@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "fs-local@0.1.6-alpha.2"),
    ("vendor/dsh/tool-fs@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-fs@0.1.6-alpha.2"),
    ("vendor/dsh/tool-str-replace-editor@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-str-replace-editor@0.1.6-alpha.2"),
    ("vendor/dsh/session@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "session@0.1.6-alpha.2"),
    ("vendor/dsh/session-projection@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "session-projection@0.1.6-alpha.2"),
    ("vendor/dsh/settings@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "settings@0.1.6-alpha.2"),
    ("vendor/dsh/system-prompt@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "system-prompt@0.1.6-alpha.2"),
    ("vendor/dsh/session-persistence@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "session-persistence@0.1.6-alpha.2"),
    ("vendor/dsh/commands@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "commands@0.1.6-alpha.2"),
    ("vendor/dsh/command-feedback@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "command-feedback@0.1.6-alpha.2"),
    ("vendor/dsh/timeout@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "timeout@0.1.6-alpha.2"),
    ("vendor/dsh/tool-todo@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-todo@0.1.6-alpha.2"),
    ("vendor/dsh/tools@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tools@0.1.6-alpha.2"),
    ("vendor/dsh/typert-protocol@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "typert-protocol@0.1.6-alpha.2"),
    ("vendor/dsh/util-values@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "util-values@0.1.6-alpha.2"),
    ("vendor/dsh/persona@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "persona@0.1.6-alpha.2"),
    ("vendor/dsh/agent-instructions@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "agent-instructions@0.1.6-alpha.2"),
    ("vendor/dsh/plan-mode@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "plan-mode@0.1.6-alpha.2"),
    ("vendor/dsh/command-goal@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "command-goal@0.1.6-alpha.2"),
    ("vendor/dsh/tool-goal@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-goal@0.1.6-alpha.2"),
    ("vendor/dsh/tool-jobs@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-jobs@0.1.6-alpha.2"),
    ("vendor/dsh/tool-ask-user@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-ask-user@0.1.6-alpha.2"),
    ("vendor/dsh/tool-subagent@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-subagent@0.1.6-alpha.2"),
    ("vendor/dsh/tool-subagent-control@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-subagent-control@0.1.6-alpha.2"),
    ("vendor/dsh/tool-workflow@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-workflow@0.1.6-alpha.2"),
    ("vendor/dsh/compaction-basic@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "compaction-basic@0.1.6-alpha.2"),
    ("vendor/dsh/command-compact@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "command-compact@0.1.6-alpha.2"),
    ("vendor/dsh/compaction-tool-result-pruner@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "compaction-tool-result-pruner@0.1.6-alpha.2"),
    ("vendor/dsh/credentials@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "credentials@0.1.6-alpha.2"),
    ("vendor/dsh/terminal@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "terminal@0.1.6-alpha.2"),
    ("vendor/dsh/goal@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "goal@0.1.6-alpha.2"),
    ("vendor/dsh/jobs@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "jobs@0.1.6-alpha.2"),
    ("vendor/dsh/output-retention@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "output-retention@0.1.6-alpha.2"),
    ("vendor/dsh/user-questions@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "user-questions@0.1.6-alpha.2"),
    ("vendor/dsh/chunked-list@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "chunked-list@0.1.6-alpha.2"),
    ("vendor/dsh/util-time@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "util-time@0.1.6-alpha.2"),
    ("vendor/dsh/subagent@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "subagent@0.1.6-alpha.2"),
    ("vendor/dsh/workflow@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "workflow@0.1.6-alpha.2"),
    ("vendor/dsh/compaction@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "compaction@0.1.6-alpha.2"),
    ("vendor/dsh/token-meter@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "token-meter@0.1.6-alpha.2"),
    ("vendor/dsh/skill@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "skill@0.1.6-alpha.2"),
    ("vendor/dsh/skill-filesystem@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "skill-filesystem@0.1.6-alpha.2"),
    ("vendor/dsh/tool-skill@0.1.6-alpha.2", DSH / "vendor" / "dsh" / "tool-skill@0.1.6-alpha.2"),
    ("vendor/dsh/tool-present@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-tool-present@0.1.6-alpha.2"),
    ("vendor/dsh/tool-ralph@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-tool-ralph@0.1.6-alpha.2"),
    ("vendor/dsh/tool-bash@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-tool-bash@0.1.6-alpha.2"),
    ("vendor/dsh/tool-pwsh@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-tool-pwsh@0.1.6-alpha.2"),
    ("vendor/dsh/plugin-manager@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-plugin-manager@0.1.6-alpha.2"),
    ("vendor/dsh/tool-web@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-tool-web@0.1.6-alpha.2"),
    ("vendor/dsh/session-query@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-session-query@0.1.6-alpha.2"),
    ("vendor/dsh/session-title@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-session-title@0.1.6-alpha.2"),
    ("vendor/dsh/session-format-catalog@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-session-format-catalog@0.1.6-alpha.2"),
    ("vendor/dsh/compaction-image-offload@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-compaction-image-offload@0.1.6-alpha.2"),
    ("vendor/dsh/dsh-web@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-web@0.1.6-alpha.2"),
    ("vendor/npm/turndown@7.2.4/lib", DSH / "vendor" / "npm" / "turndown@7.2.4" / "lib"),
    ("vendor/npm/@mixmark-io/domino@2.2.0/lib", DSH / "vendor" / "npm" / "@mixmark-io" / "domino@2.2.0" / "lib"),
    ("vendor/npm/@joplin/turndown-plugin-gfm@1.0.67/lib", DSH / "vendor" / "npm" / "@joplin" / "turndown-plugin-gfm@1.0.67" / "lib"),
    ("vendor/npm/@deepseek-ai/dsh-goal@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-goal@0.1.6-alpha.2"),
    ("vendor/npm/@deepseek-ai/dsh-file-reference@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-file-reference@0.1.6-alpha.2"),
    ("vendor/npm/@deepseek-ai/dsh-file-reference-local@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-file-reference-local@0.1.6-alpha.2"),
    ("vendor/npm/@deepseek-ai/dsh-llm-retry@0.1.6-alpha.2", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-llm-retry@0.1.6-alpha.2"),
    ("vendor/npm/diff@9.0.0/libesm", DSH / "vendor" / "npm" / "diff@9.0.0" / "libesm"),
    ("vendor/npm/yaml@2.9.0/browser", DSH / "vendor" / "npm" / "yaml@2.9.0" / "browser"),
    ("vendor/npm/fflate@0.8.2/esm", DSH / "vendor" / "npm" / "fflate@0.8.2" / "esm"),
    ("vendor/npm/pngjs@5.0.0/lib", DSH / "vendor" / "npm" / "pngjs@5.0.0" / "lib"),
    ("vendor/npm/jpeg-js@0.4.4", DSH / "vendor" / "npm" / "jpeg-js@0.4.4"),
    ("vendor/npm/fflate@0.8.2/lib/index.cjs", DSH / "vendor" / "npm" / "fflate@0.8.2" / "lib" / "index.cjs"),
    ("vendor/npm/@noble/hashes@2.3.0", DSH / "vendor" / "npm" / "@noble" / "hashes@2.3.0"),
    ("vendor/npm/@earendil-works/pi-ai@0.85.1", DSH / "vendor" / "npm" / "@earendil-works" / "pi-ai@0.85.1"),
    ("system-plugins/dsh-office", DSH / "system-plugins" / "dsh-office"),
    ("upstream/shims", DSH / "upstream" / "shims"),
    ("scenario", DSH / "scenario"),
    ("web-live", DSH / "web-live"),
    ("vendor/npm/cordis@4.0.2/package.json", DSH / "vendor" / "npm" / "cordis@4.0.2" / "package.json"),
    ("vendor/npm/cosmokit@1.8.3/package.json", DSH / "vendor" / "npm" / "cosmokit@1.8.3" / "package.json"),
    ("vendor/npm/schemastery@3.18.2/package.json", DSH / "vendor" / "npm" / "schemastery@3.18.2" / "package.json"),
    ("vendor/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/package.json", DSH / "vendor" / "npm" / "@deepseek-ai" / "dsh-client-modules@0.1.6-alpha.2" / "package.json"),
]

# The pinned zod's runtime closure: `zod` → index.js → the classic build's
# relative import graph (computed once by walking imports from index.js at
# the pin). The rest of the package (src/, v3/, mini/, .d.ts) never loads.
ZOD_ROOT = ("vendor/npm/zod@4.4.3", DSH / "vendor" / "npm" / "zod@4.4.3")
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
    "v4/locales/ar.js", "v4/locales/az.js", "v4/locales/be.js", "v4/locales/bg.js",
    "v4/locales/ca.js", "v4/locales/cs.js", "v4/locales/da.js", "v4/locales/de.js",
    "v4/locales/el.js", "v4/locales/en.js", "v4/locales/eo.js", "v4/locales/es.js",
    "v4/locales/fa.js", "v4/locales/fi.js", "v4/locales/fr-CA.js", "v4/locales/fr.js",
    "v4/locales/he.js", "v4/locales/hr.js", "v4/locales/hu.js", "v4/locales/hy.js",
    "v4/locales/id.js", "v4/locales/index.js", "v4/locales/is.js", "v4/locales/it.js",
    "v4/locales/ja.js", "v4/locales/ka.js", "v4/locales/kh.js", "v4/locales/km.js",
    "v4/locales/ko.js", "v4/locales/lt.js", "v4/locales/mk.js", "v4/locales/ms.js",
    "v4/locales/nl.js", "v4/locales/no.js", "v4/locales/ota.js", "v4/locales/pl.js",
    "v4/locales/ps.js", "v4/locales/pt.js", "v4/locales/ro.js", "v4/locales/ru.js",
    "v4/locales/sl.js", "v4/locales/sv.js", "v4/locales/ta.js", "v4/locales/th.js",
    "v4/locales/tr.js", "v4/locales/ua.js", "v4/locales/uk.js", "v4/locales/ur.js",
    "v4/locales/uz.js", "v4/locales/vi.js", "v4/locales/yo.js", "v4/locales/zh-CN.js",
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


# The SELF-HOSTED Web Client plugin (presentation/web-client-v2): its own
# tree so .html/.css ride along — the spine tree's suffix filter is
# .js/.mjs/.json/... and a silent suffix drop is exactly the 2026-09-24
# drift class this repo refuses. Staged under webclient-v2/ (BundleStager).
WEBCLIENT_TREES = [
    ("webclient-v2", REPO / "presentation" / "web-client-v2"),
    ("webclient-compact", REPO / "presentation" / "web-client-compact"),
]
WEBCLIENT_SUFFIXES = (".html", ".css", ".js", ".json")


def collect_webclient_files():
    """The self-hosted client tree: (bundle_relative_path, absolute path)."""
    out = []
    for rel_dir, src_dir in WEBCLIENT_TREES:
        if not src_dir.is_dir():
            raise SystemExit(
                f"gen_bundle_header: webclient tree row {rel_dir!r} source missing: "
                f"{src_dir} — fix the row or restore the plugin")
        for path in sorted(src_dir.rglob("*")):
            if path.is_file() and path.suffix in WEBCLIENT_SUFFIXES:
                out.append((f"{rel_dir}/{path.relative_to(src_dir)}", path))
    return out


def c_array(symbol: str, data: bytes, raw: bytes) -> str:
    if b"\x00" in raw:
        raise SystemExit(f"gen_bundle_header: {symbol} contains a NUL byte")
    rows = []
    for at in range(0, len(raw), 16):
        chunk = ", ".join(f"0x{b:02x}" for b in raw[at:at + 16])
        rows.append(f"  {chunk},")
    body = "\n".join(rows)
    # trailing NUL keeps the array a valid C string (dsh_runtime_eval strlens)
    return f"static const unsigned char {symbol}[] = {{\n{body}\n  0x00\n}};\n"


def emit_resources(parts: list, decls: list, funcs: list) -> None:
    for suffix, path in RESOURCES:
        if not path.is_file():
            raise SystemExit(f"gen_bundle_header: missing input {path}")
        symbol = f"DSH_{suffix.upper()}"
        raw = path.read_bytes()
        data = raw + b"\x00"
        parts.append(f"/* {path.relative_to(REPO)} ({len(data) - 1} bytes) */\n{c_array(symbol, data, raw)}")
        decls.append(f"const char *dsh_runtime_res_{suffix}(size_t *len);")
        funcs.append(
            f"const char *dsh_runtime_res_{suffix}(size_t *len) {{\n"
            f"  if (len) *len = sizeof({symbol}) - 1;\n"
            f"  return (const char *){symbol};\n"
            f"}}\n"
        )


def emit() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    parts, decls, funcs = [], [], []
    emit_resources(parts, decls, funcs)
    tree = collect_tree_files()
    parts.append(trees.tree_c_source(tree, "DSH", "dsh_runtime_bundle_tree_file", REPO))
    decls.append(trees.SPINE_TREE_WALKER_DECL)
    total = sum(p.stat().st_size for _, p in tree)
    print(f"gen_bundle_header: tree = {len(tree)} files, {total} bytes "
          f"({total / 1024:.0f} KiB)")
    webclient_tree = collect_webclient_files()
    parts.append(trees.tree_c_source(
        webclient_tree, "DSH_WEBCLIENT", "dsh_runtime_webclient_tree_file", REPO))
    decls.append(trees.WEBCLIENT_TREE_WALKER_DECL)
    wtotal = sum(p.stat().st_size for _, p in webclient_tree)
    print(f"gen_bundle_header: webclient tree = {len(webclient_tree)} files, "
          f"{wtotal} bytes ({wtotal / 1024:.0f} KiB)")

    header = "\n".join([
        "/* Generated by hosts/ios/Tools/gen_bundle_header.py — do not edit.",
        " * Re-embeds the runtime/dsh JS bundle (byte arrays, NUL-terminated). */",
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
    # open()'s newline= predates write_text()'s (3.10; the runner's python is
    # older) — the generated C must be LF on every host.
    for name, text in (("SpikeBundle.h", header), ("SpikeBundle.c", source)):
        with open(OUT / name, "w", encoding="utf-8", newline=chr(10)) as fh:
            fh.write(text)
    print(f"gen_bundle_header: wrote {OUT / 'SpikeBundle.c'} + .h")


if __name__ == "__main__":
    emit()
