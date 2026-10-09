// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/preset-mobile-rows.js — the mobile composition choice for the
 * staged preset documents (the 设置 → 内置插件 会话插件 plane). The pinned
 * preset compositions declare the DESKTOP tool set; a handful of those rows
 * name packages the mobile closure deliberately does not carry (each named
 * in the vendor header: ripgrep/subprocess engines, desktop plugin
 * management, the PTC host runner). The vendored AgentPresets health check
 * marks every composition with an unresolvable row `broken`, which is the
 * 加载失败 card on the panel.
 *
 * The fix is upstream's OWN row semantics: a `disabled: true` row is not
 * part of the composition (the shipped cordis.yml disables its codex and
 * claude-code provider rows exactly this way), and the health check skips
 * disabled rows. The host stages the pinned preset docs; this module marks
 * the deliberately-absent rows disabled in the STAGED copy before the VFS
 * seeds — the shipped files stay untouched (D6), the choice lives in OUR
 * adaptation layer, and every patch is fail-loud: a row id that no longer
 * matches the pinned shape aborts the seed rather than passing silently.
 *
 * Verification leg: the b4 settings probe asserts the roster carries no
 * `broken` entry after the seed (measured 2026-09-24: the 创造模式 card
 * showed 5 unresolvable rows before this).
 */
import { encodeUtf8, decodeUtf8 } from 'node:buffer';

/** The row ids the mobile closure deliberately does not carry, per package
 * (the vendor header names each exclusion's reason). Row ids are stable in
 * the pinned 0.1.6-alpha.2 documents; a rename fails the seed loud.
 *
 * 2026-10-03: `tool-plugin-manager` and `tool-web` left this set —
 * `@deepseek-ai/dsh-plugin-manager` / `@deepseek-ai/dsh-tool-web` (+ the
 * turndown/domino/@joplin link chain)
 * is staged and embedded (its list/inspect legs answer read-only from the
 * inventory; the write legs still refuse honestly). `tool-cordis` stays
 * absent: even with the runtime-side `dynamicCordisRunner/{inventory,
 * syncInspectManifest}` legs answered (#335 B3), the tool's own wire needs
 * the `cordisInspect` HOST service — which only the vendored
 * cordis-host-runner provides (its HostInspectRegistry), plus the
 * `resolveInspectQuery` leg and the cordis/inspect-query event loop the
 * runner owns. Mounting that machinery is the #335 B carrier work; until
 * it lands the row's inject would park forever. */
const MOBILE_ABSENT_ROW_IDS = new Set([
  'tool-fs-search', // @vscode/ripgrep packaged binary over OS subprocesses
  'workflow-ptc', // the PTC workflow engine needs the desktop host runner
  'tool-presentation', // the registry presenter rides the PTC host runner
  'tool-cordis', // needs the cordis-host-runner inspect service, not just the two B3 legs
  'tool-workflow', // tool-workflow injects `workflowEngine` — its only engine (workflow-ptc) rides the same walled PTC host runner; no stub would be honest (measured 2026-10-08: the mobile standing mount parks the row without it)
]);

/** The one YAML row block carrying `- id: <id>` at any indent, as an array
 * of {index, indent} or null when the pinned shape drifted. */
const findRowBlock = (lines, rowId) => {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)-\s+id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/);
    if (match && match[2] === rowId) {
      return { start: i, indent: match[1] };
    }
  }
  return null;
};

/** Whether the row block opening at `start` already carries a `disabled:`
 * key at the row's own level (the keys sit two spaces past the dash:
 * `    - id:` → `      disabled:`). The block runs to the next sibling row
 * or any dedent; comments and nested `config:` lines pass through (the ptc
 * preset disables workflow-ptc several comment lines below its name — a
 * next-line check would miss it). */
const rowHasDisabled = (lines, start, dashIndent) => {
  const keyIndent = `${dashIndent}  `;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(keyIndent)) return false; // next row or dedent
    if (line.startsWith(`${keyIndent}disabled:`)) return true;
  }
  return false;
};

/** Patch one document: for every MOBILE_ABSENT_ROW_IDS row, insert
 * `disabled: true` right after the row's `- id:` line (same indent —
 * mapping keys are order-free, so this cannot reorder row config).
 * Already-disabled rows pass untouched; documents that declare none of the
 * rows (极简模式) patch zero and pass through; a row block that drifted
 * from the pinned shape (no readable name line) throws (rule 5). */
export const disableMobileAbsentRows = (text, docName) => {
  const lines = text.split('\n');
  let patched = 0;
  for (const rowId of MOBILE_ABSENT_ROW_IDS) {
    const block = findRowBlock(lines, rowId);
    if (block === null) continue; // this document does not declare the row
    if (rowHasDisabled(lines, block.start, block.indent)) continue;
    const nameAt = lines.findIndex((line, i) => i > block.start
      && line.startsWith(`${block.indent}  name:`));
    if (nameAt < 0) {
      throw new Error(`preset-mobile-rows: ${docName} row "${rowId}" has no name line`);
    }
    lines.splice(block.start + 1, 0, `${block.indent}  disabled: true`);
    patched++;
  }
  return lines.join('\n');
};

/** The create-approve-hotmount loop's row (PR-2/3): the composition gains
 * `tool-plugin-create` — the session agent's tool surface must list the
 * tool for the model's tool_calls to dispatch (the spine's ctx.tools
 * registration alone serves the inventory, not the per-session list). Same
 * seam as the disabler: the STAGED copy is patched, the pinned documents
 * stay untouched (D6); idempotent on re-seed.
 *
 * The insertion point is the row block's END — the next same-indent row
 * start, the first dedenting line (the list ended), or EOF — never right
 * after the `- id:` line: a row block carries more keys after its id
 * (name/disable/...), and splicing there severs them onto the new row.
 * Measured 2026-10-10: the id-adjacent splice produced "duplicated
 * mapping key (252:3)" on every preset with a plugin plane (mobile,
 * standard, cordis, ptc — minimal survived) and session/create died
 * everywhere; the panel replica mirrored only the disabler, so CI could
 * not see it.
 *
 * The row lands DISABLED: the vendored mount health resolves every enabled
 * row's plugin name, and `system-plugins/...` has no resolvable face in
 * the preset resolver's world (no package, not preset-relative) — an
 * enabled row refused EVERY session/create ("names a plugin that cannot
 * be resolved", measured right after the splice-point fix). The creation
 * tool itself is served by the spine's own boot mount
 * (boot.js tool('tool-plugin-create', 'system-plugins/dsh-create', ...)),
 * which is how every creation round to date has dispatched; this row
 * graduates to enabled only when the plugin gains a face the resolver
 * answers (a package face, or a preset-relative delivery). */
const spliceCreateRow = (text) => {
  if (text.includes('id: tool-plugin-create')) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes('- id: tool-plugin-manager'));
  if (at < 0) return text; // no plugin plane in this document; skip
  const indent = lines[at].slice(0, lines[at].indexOf('-'));
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith(`${indent}-`)) { end = i; break; } // the next row
    if (line.trim() === '') continue; // blank: still inside the block
    if (!line.startsWith(`${indent} `)) { end = i; break; } // dedent: list ended
  }
  lines.splice(end, 0,
    `${indent}- id: tool-plugin-create`,
    `${indent}  name: 'system-plugins/dsh-create/index.js'`,
    `${indent}  disabled: true`);
  return lines.join('\n');
};

/** The seed transform: patch every presets/**`*.yml` document in the
 * delivery's file map (keyed by VFS path) in place. Non-preset files pass
 * through byte-identical. */
export const patchPresetSeedFiles = (files) => {
  for (const [path, file] of Object.entries(files)) {
    if (!path.includes('/presets/') || !path.endsWith('.yml')) continue;
    const text = decodeUtf8(file.bytes);
    const patched = spliceCreateRow(disableMobileAbsentRows(text, path.split('/').pop()));
    file.bytes = encodeUtf8(patched);
  }
  return files;
};
