# Agent Note: The office plane: dsh-office-tools ported onto fflate and the gateway fs

Status: implemented
Related: D6, D9

## Problem

The host could not view or author Office documents: an agent asked to "read
this xlsx" or "draft a docx" had no surface at all. The upstream answers both
miss the mobile runtime's physical constraints. The official
`@deepseek-ai/dsh-skill-office` is a skill package whose workflows shell out
to python scripts — this runtime has no subprocess (thread rule), so its
check legs are dead here. The community `dsh-office-tools@1.0.4` (MIT) has
exactly the right model-facing surface (8 tools: word/excel/ppt create/read/
update) but its engine imports `node:zlib` (no zlib seam in QuickJS),
`node:path`, and the desktop `ctx.fs` service — none of which this runtime
serves. Meanwhile the frozen gateway has no inflate primitive, so OOXML
(zip+xml) containers were unopenable without new contract surface (D5 would
demand a proposal round).

## Decision

`system-plugins/dsh-office` — the dsh-office-tools surface ported in-house,
the D6 outboard-adaptation shape (verbatim upstream stays untouched; the
adaptation lives here). The eight tools keep the desktop package's argument
contract, caps, output schemas, and OOXML part templates byte-for-byte in
semantics; the engine seams swap:

- zip: vendored `fflate@0.8.2` (89 KB pure-ESM, sha256-pinned in
  ensure-dsh.sh, mounted through the npm-bridges seam) replaces node:zlib;
  the asciizip.ts decompression caps carry over onto the unzipSync result.
  boot.js imports the plugin DYNAMICALLY — its static graph reaches bare
  `fflate`, which only exists after the bridges shim's body registers it
  (the same measured link-order reason as the file-tools row).
- fs: the contract's fsRead/fsWrite/fsStat over the pinned profile workspace
  (the dsh-shell-wasm scopePathFor convention) replaces the desktop ctx.fs
  service; extension allowlist, the 50 MB file cap, and the
  create-overwrite guard are ported; the gateway's own scope enforcement
  backs the lexical escape check.
- One deliberate delta: word_update republishes through the BYTES channel,
  so binary parts (embedded images/fonts) survive where the desktop plugin's
  UTF-8 text channel had to refuse them.

boot.js mounts it unconditionally (no config gate — the tools need only the
fs trio every host grants) and the spine inventory gains the `office` row
(settings-surfaces/composer manifests pinned at 17/75 and moved with it).

Verification: E2E scenario `office` (test/e2e/scenarios/office.json, 19
events one-to-one, wired into `build.sh test core` via
run-office-e2e.sh) drives all eight tools through the REAL ToolRuntime —
create/read/update round-trips, REAL-library fixture legs (python-docx /
openpyxl / python-pptx bytes committed as base64 in scenario/
office-fixtures.js, so the view legs read files this plugin did not write),
and the no-overwrite refusal. Cross-validated both directions in dev:
python libraries open the plugin's writer output; the plugin reads
python-library output.

## Alternatives considered

- Vendor SheetJS (xlsx) + docx + pptxgenjs: the official npm faces of the
  three formats. Lost: ~1.4 MB of ESM per package committed three times
  (three hosts' embeds), CJS-heavy builds the loader cannot serve, and a
  far larger porting surface — versus dsh-office-tools' hand-rolled OOXML
  that already speaks the dsh tool dialect.
- Mount the official dsh-skill-office: its workflows shell to python —
  physically impossible here; mounting it would offer tools whose legs all
  fail (rule 5 says say no out loud, not fake it).
- Propose a gateway inflate primitive (D5) and keep everything else: a
  contract round plus three host implementations for what fflate already
  solves in-process; revisit only if zip needs to sink below the gateway
  (the bare-metal bring-up checklist's priority list).
- community dsh-univer-office: a UI-plane spreadsheet viewer, not a
  model-facing tool surface — wrong layer for the ask.
