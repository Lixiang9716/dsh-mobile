# Agent Note: the dsh-desktop file tools row mounts in the product boot

Status: implemented
Related: none

## Problem

"完全接入所有的 dsh-desktop 插件（除 Electron 外）" needs the highest-value
vendored gap closed: the desktop shell's FILE-TOOLS row — upstream's fs
tool family (`tool-fs`, `tool-str-replace-editor`) over a real fs backend.
No backend was vendored, fs-local is built on the full node:fs promise
surface the spike runtime does not have, and quickjs links a static import
graph before any module body runs, so the npm packages the tools import
cannot be registered by static import order.

## Decision

Vendored sha256-pinned: `fs-local`, `tool-fs`, `tool-str-replace-editor`,
`attachment` (0.1.6-alpha.2) and npm `diff@9.0.0`. The shim layer gained a
writable in-memory workspace VFS (`mountWorkspace` in shims/fs.js) serving
the exact fs/promises + bigint-stat face fs-local drives, a `TextDecoder`
on `node:util`, and a runtime-module bridge (shims/npm-bridges.js over the
M3 `__dshModuleDefine` seam) that puts the verbatim vendored diff tree
behind the bare `diff` specifier. boot.js's mountSpine mounts the row in
the product boot: one in-memory world pinned to the container cwd, the
fs-local backend as the `fs` service, the file tools into the REAL
ToolRuntime. The tool packages are imported DYNAMICALLY after the static
bridge import — static ordering cannot sequence runtime registration
(measured). tool-fs-search is NOT vendored: its engine is the
`@vscode/ripgrep` packaged binary driven through OS subprocesses, the same
staged class as the native rows. Proven by scenario/tool-fs-probe.js
(scenario `tool.fs`) and the settings-surfaces inventory
(spineEntries 16).

## Alternatives considered

- Implement the fs backend in-house over the gateway fs scopes now —
  rejected: it would fork the upstream service vocabulary this row exists
  to adopt; the gateway-backed disk world stays the follow-up.
- Add a `diff` bare-map row in the C host — rejected: the host loader bare
  map names upstream dsh packages, and the M3 runtime-module seam already
  ships for exactly this shape without host-file edits.
- Vendor tool-fs-search without the ripgrep binary — rejected: an engine
  that can only fail loud at call time is not a capability.

## Consequences

The row's world is one pinned in-memory root: no durability, no symlinks,
no permissions; read_image registers only where an attachments service
exists. Disk-backed workspace over the gateway fs scopes and grep/glob
(tools row PR-B) remain staged. The model-facing tool surface grows by
read/write/edit + str_replace_editor — every manifest that pinned the tool
count or the spine inventory was re-pinned in this change.
