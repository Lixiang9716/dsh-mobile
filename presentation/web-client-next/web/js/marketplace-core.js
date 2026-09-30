// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * marketplace-core.js — the plugin marketplace panel's PURE logic (no DOM),
 * so the vitest suite imports it directly (the onboarding-core.js pattern).
 * Bilingual copy is EN-first data ({en, zh}); the panel renders both.
 *
 * The panel is a pure consumer of the runtime's marketplace face: the browse
 * view (marketplace/index), the install stream (marketplace/install — one
 * transaction's step events folded into one progress line), the installed
 * view (marketplace/installed) and removal (marketplace/remove). No gateway
 * primitive is touched; nothing here invents marketplace behavior.
 */

/** The install transaction's steps in wire order (the pipeline's own
 * `on(step)` vocabulary plus the face's index.verified/resolved/receipt).
 * A step outside this table still renders (its kind is shown verbatim) —
 * forward compatibility, never a crash. */
export const INSTALL_STEPS = [
  'index.verified', 'resolved',
  'fetch.start', 'fetch.status', 'fetch.body',
  'blob.stored', 'digest.verified', 'manifest.validated', 'integrity.computed',
  'negotiated', 'receipt.pending', 'staged.verified', 'promoted', 'committed',
  'receipt',
];

const STEP_LINES = {
  'index.verified': { en: 'Catalog verified (ed25519)', zh: '目录已验签(ed25519)' },
  resolved: { en: 'Resolved from the catalog', zh: '已从目录解析' },
  'fetch.start': { en: 'Downloading the package…', zh: '正在下载包…' },
  'fetch.status': { en: 'Connected (HTTP 200)', zh: '已连接(HTTP 200)' },
  'fetch.body': { en: 'Package bytes received', zh: '包字节已接收' },
  'blob.stored': { en: 'Stored content-addressed', zh: '已入内容寻址存储' },
  'digest.verified': { en: 'Digest matches the catalog', zh: '摘要与目录一致' },
  'manifest.validated': { en: 'Manifest validated', zh: '清单校验通过' },
  'integrity.computed': { en: 'Integrity ledger built', zh: '完整性台账已建立' },
  negotiated: { en: 'Capabilities negotiated', zh: '能力协商通过' },
  'receipt.pending': { en: 'Transaction journal opened', zh: '事务回执已登记' },
  'staged.verified': { en: 'Staged tree re-verified', zh: '暂存树逐字节复核' },
  promoted: { en: 'Promoted into place', zh: '已就位' },
  committed: { en: 'Committed', zh: '已提交' },
  receipt: { en: 'Receipt written', zh: '回执已写入' },
};

/** The fold: one transaction's step events → the panel's progress state.
 * Pure: takes the previous state ({steps, line, done, failed}) and one mux
 * item, returns the next. Unknown kinds render verbatim (forward compat);
 * the `receipt` kind closes the fold. */
export function installFold(state, item) {
  const kind = typeof item?.kind === 'string' ? item.kind : 'unknown';
  const steps = [...(state?.steps ?? []), kind];
  if (kind === 'receipt') {
    return {
      steps, done: true, failed: false,
      line: {
        en: `Installed ${item.id}@${item.version}`,
        zh: `已安装 ${item.id}@${item.version}`,
      },
    };
  }
  const known = STEP_LINES[kind];
  const line = known ?? {
    en: kind, zh: kind,
  };
  return { steps, done: false, failed: false, line };
}

/** The install button's gate: one install at a time, and an installed
 * version blocks a re-install (v0 has no upgrade path — the profile's
 * policy, the proposal's named non-goal). */
export function installEnabled(entry, runningId) {
  return runningId === null && entry.installed === null;
}

/** One browse row from the index view's entry: what the panel shows before
 * any download — name, version, capability summary, bilingual intro. */
export function entryRow(entry) {
  const caps = [
    ...(entry?.capabilities?.required ?? []),
    ...(entry?.capabilities?.optional ?? []),
  ];
  return {
    id: entry?.id ?? '',
    version: entry?.version ?? '',
    summary: entry?.summary ?? { en: '', zh: '' },
    capsLabel: caps.length > 0 ? caps.join(', ') : '',
    installed: entry?.installed ?? null,
  };
}

/** One installed row from the installed view. */
export function installedRow(item) {
  return {
    id: item?.id ?? '',
    version: item?.version ?? '',
    committedAt: typeof item?.committedAt === 'string' ? item.committedAt : '',
    dir: typeof item?.dir === 'string' ? item.dir : '',
  };
}

/** Map one install failure (the wire's {code, message}) to a readable
 * bilingual pair. The runtime keeps messages factual; the page owns the
 * human words — the onboarding readableProbeError pattern. */
export function readableInstallError(error) {
  const code = String(error?.code ?? '');
  if (code === 'marketplace/signature') {
    return { en: 'The catalog signature failed verification — nothing was installed',
      zh: '目录签名校验失败 — 未安装任何内容' };
  }
  if (code === 'marketplace/unknown-key') {
    return { en: 'The catalog signed with an unknown key — nothing was installed',
      zh: '目录签名密钥未知 — 未安装任何内容' };
  }
  if (code === 'marketplace/missing-entry') {
    return { en: 'That package is not in the catalog', zh: '该包不在目录中' };
  }
  if (code === 'install/integrity') {
    return { en: 'The package did not match its trust record — the install was aborted',
      zh: '包与信任记录不符 — 安装已中止' };
  }
  if (code === 'install/capability') {
    return { en: 'This device does not offer a required capability — the install was rejected',
      zh: '本机不提供所需能力 — 安装被拒绝' };
  }
  if (code === 'install/manifest' || code === 'install/package') {
    return { en: 'The package is malformed — the install was aborted',
      zh: '包格式无效 — 安装已中止' };
  }
  if (code === 'install/network' || code === 'gateway/unavailable') {
    return { en: 'Could not reach the package — check the network and retry',
      zh: '无法获取包 — 请检查网络后重试' };
  }
  const message = String(error?.message ?? 'install failed');
  return { en: message.slice(0, 200), zh: message.slice(0, 200) };
}

/** The remove confirmation copy for one installed row. */
export function removeConfirmLine(row) {
  return {
    en: `Remove ${row.id}@${row.version}? The plugin directory is deleted.`,
    zh: `移除 ${row.id}@${row.version}?插件目录将被删除。`,
  };
}

/** The removed feedback copy. */
export function removedLine(row) {
  return { en: `Removed ${row.id}@${row.version}`, zh: `已移除 ${row.id}@${row.version}` };
}
