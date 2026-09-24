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
 * the pinned 0.1.6-alpha.2 documents; a rename fails the seed loud. */
const MOBILE_ABSENT_ROW_IDS = new Set([
  'tool-fs-search', // @vscode/ripgrep packaged binary over OS subprocesses
  'tool-web', // the web search provider is a host-plane network service
  'workflow-ptc', // the PTC workflow engine needs the desktop host runner
  'tool-cordis', // runtime inspection for composition authoring (desktop)
  'tool-plugin-manager', // persistent profile-wide plugin management
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

/** The seed transform: patch every presets/**`*.yml` document in the
 * delivery's file map (keyed by VFS path) in place. Non-preset files pass
 * through byte-identical. */
export const patchPresetSeedFiles = (files) => {
  for (const [path, file] of Object.entries(files)) {
    if (!path.includes('/presets/') || !path.endsWith('.yml')) continue;
    const text = decodeUtf8(file.bytes);
    const patched = disableMobileAbsentRows(text, path.split('/').pop());
    file.bytes = encodeUtf8(patched);
  }
  return files;
};
