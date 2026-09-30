// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * marketplace.js — the plugin marketplace panel (DOM wiring). main.js calls
 * setupMarketplace({mux, rpc, toast}); the home screen's 插件市场 button
 * presents the overlay (the onboarding overlay pattern):
 *
 *   浏览 tab  → marketplace/index: the SIGNED catalog's rows (name, version,
 *               capability summary, bilingual intro); an install button per
 *               row opens the marketplace/install STREAM and folds its step
 *               events into one progress line (fetch.start → … → receipt).
 *   已装 tab  → marketplace/installed: the receipts journal's committed
 *               installs, each with a remove entry (confirm →
 *               marketplace/remove → refresh).
 *
 * A boot without the marketplace face answers gateway/unimplemented — a
 * capability gap, not an error: the panel opens with an honest note and no
 * rows. Bilingual copy throughout (EN + ZH). All state resets are local to
 * this module; the page's session UI is untouched.
 */
import {
  installFold, installEnabled, entryRow, installedRow,
  readableInstallError, removeConfirmLine, removedLine,
} from './marketplace-core.js';

const $ = (id) => document.getElementById(id);

let installStreamId = null;
let runningId = null;

const setLine = (node, line) => {
  if (line === null) return;
  node.textContent = `${line.zh} · ${line.en}`;
};

/** One browse row: name + version + capability summary + bilingual intro +
 * the install button (disabled while installing or already installed). */
const renderEntryRow = (parent, row, { onInstall }) => {
  const card = document.createElement('div');
  card.className = 'market-entry glass';
  const title = document.createElement('div');
  title.className = 'market-entry-title';
  title.textContent = row.summary.zh || row.id;
  const titleEn = document.createElement('span');
  titleEn.className = 'market-entry-title-en';
  titleEn.textContent = row.summary.en || row.id;
  title.appendChild(titleEn);
  const meta = document.createElement('div');
  meta.className = 'market-entry-meta';
  meta.textContent = `${row.id} · v${row.version}`
    + (row.capsLabel !== '' ? ` · ${row.capsLabel}` : '');
  const intro = document.createElement('div');
  intro.className = 'market-entry-intro';
  intro.textContent = `${row.summary.zh} — ${row.summary.en}`;
  const actions = document.createElement('div');
  actions.className = 'market-entry-actions';
  const button = document.createElement('button');
  button.className = 'onboarding-btn onboarding-primary market-install-btn';
  button.type = 'button';
  button.dataset.install = row.id;
  if (row.installed !== null) {
    button.textContent = `已安装 · Installed (v${row.installed})`;
    button.disabled = true;
  } else {
    button.textContent = '安装 · Install';
    button.disabled = runningId !== null;
  }
  button.addEventListener('click', () => onInstall(row));
  actions.appendChild(button);
  card.append(title, meta, intro, actions);
  parent.appendChild(card);
};

/** One installed row: id@version + committed time + the remove entry. */
const renderInstalledRow = (parent, row, { onRemove }) => {
  const card = document.createElement('div');
  card.className = 'market-entry glass';
  const title = document.createElement('div');
  title.className = 'market-entry-title';
  title.textContent = `${row.id} v${row.version}`;
  const meta = document.createElement('div');
  meta.className = 'market-entry-meta';
  meta.textContent = row.dir;
  const actions = document.createElement('div');
  actions.className = 'market-entry-actions';
  const button = document.createElement('button');
  button.className = 'onboarding-btn onboarding-secondary market-remove-btn';
  button.type = 'button';
  button.dataset.remove = row.id;
  button.textContent = '移除 · Remove';
  button.addEventListener('click', () => onRemove(row));
  actions.appendChild(button);
  card.append(title, meta, actions);
  parent.appendChild(card);
};

let onReady = () => {};

const browse = async (rpc, toast, force = false) => {
  const list = $('market-list');
  list.textContent = '';
  $('market-line').textContent = '';
  let value;
  try {
    value = await rpc('marketplace/index', { args: { force } });
  } catch (error) {
    if (error?.code === 'gateway/unimplemented') {
      $('market-empty').textContent = '此宿主未启用插件市场 · This host does not enable the marketplace';
      $('market-empty').hidden = false;
      return;
    }
    toast(isWire(error) ? `市场不可用（${error.code}）` : '市场不可用');
    return;
  }
  const rows = (Array.isArray(value?.entries) ? value.entries : []).map(entryRow);
  $('market-empty').hidden = rows.length > 0;
  $('market-catalog-line').textContent
    = `目录已验签(${value?.signature?.key ?? ''}) · Catalog verified`;
  for (const row of rows) {
    renderEntryRow(list, row, { onInstall: (r) => install(muxOf, rpc, toast, r) });
  }
};

const installed = async (rpc, toast) => {
  const list = $('market-installed-list');
  list.textContent = '';
  let value;
  try {
    value = await rpc('marketplace/installed');
  } catch (error) {
    toast(isWire(error) ? `已装列表不可用（${error.code}）` : '已装列表不可用');
    return;
  }
  const rows = (Array.isArray(value?.items) ? value.items : []).map(installedRow);
  $('market-installed-empty').hidden = rows.length > 0;
  for (const row of rows) {
    renderInstalledRow(list, row, { onRemove: (r) => remove(rpc, toast, r) });
  }
};

const isWire = (error) => error !== null && typeof error === 'object' && 'code' in error;

/** The install: one marketplace/install stream, event-rendered (D8). The
 * fold's terminal states: the receipt item closes the stream (mux.end);
 * one readable error fails it. */
const install = (mux, rpc, toast, row) => {
  if (runningId !== null || !installEnabled(row, runningId)) return;
  runningId = row.id;
  const line = $('market-line');
  line.textContent = '安装中… · Installing…';
  for (const button of document.querySelectorAll('.market-install-btn')) {
    button.disabled = true;
  }
  const finish = async (ok, error) => {
    installStreamId = null;
    runningId = null;
    if (ok) {
      setLine(line, { en: `Installed ${row.id}`, zh: `已安装 ${row.id}` });
    } else {
      const readable = readableInstallError(error);
      line.textContent = `✕ ${readable.zh} · ${readable.en}`;
    }
    await installed(rpc, toast).catch(() => {});
    onReady();
  };
  installStreamId = mux.open('marketplace/install', { args: { id: row.id } }, {
    onItem: (value) => {
      const state = installFold(
        { steps: foldSteps, line: null, done: false, failed: false }, value);
      foldSteps = state.steps;
      setLine(line, state.line);
      if (state.done) finish(true, null);
    },
    onError: (error) => {
      foldSteps = [];
      finish(false, error);
    },
    onEnd: () => {
      if (runningId === row.id) {
        // An end with no receipt and no error: the stream closed under us.
        foldSteps = [];
        finish(false, { code: 'gateway/unavailable', message: 'install stream ended early' });
      }
    },
  });
};

let foldSteps = [];
let muxOf = null;

/** The remove: confirm (bilingual), then the runtime's remove leg, then a
 * refresh of both views. */
const remove = async (rpc, toast, row) => {
  const confirmLine = removeConfirmLine(row);
  // eslint-disable-next-line no-alert
  if (!globalThis.confirm(`${confirmLine.zh}\n${confirmLine.en}`)) return;
  try {
    await rpc('marketplace/remove', { args: { id: row.id } });
  } catch (error) {
    const readable = readableInstallError(error);
    toast(`✕ ${readable.zh} · ${readable.en}`);
    return;
  }
  toast(`${removedLine(row).zh} · ${removedLine(row).en}`);
  await Promise.all([installed(rpc, toast), browse(rpc, toast, true)]).catch(() => {});
  onReady();
};

const showTab = (name) => {
  $('market-tab-browse').classList.toggle('active', name === 'browse');
  $('market-tab-installed').classList.toggle('active', name === 'installed');
  $('market-browse-pane').hidden = name !== 'browse';
  $('market-installed-pane').hidden = name !== 'installed';
};

/** The panel's entry: called once from main.js after the mux exists. */
export function setupMarketplace({ mux, rpc, toast, onReady: ready }) {
  onReady = ready ?? onReady;
  muxOf = mux;
  $('market-open').addEventListener('click', () => {
    $('marketplace').hidden = false;
    showTab('browse');
    browse(rpc, toast);
  });
  $('market-close').addEventListener('click', () => {
    if (installStreamId !== null) {
      mux.cancel(installStreamId);
      installStreamId = null;
      runningId = null;
      foldSteps = [];
    }
    $('marketplace').hidden = true;
  });
  $('market-tab-browse').addEventListener('click', () => {
    showTab('browse');
    browse(rpc, toast);
  });
  $('market-tab-installed').addEventListener('click', () => {
    showTab('installed');
    installed(rpc, toast);
  });
  $('market-refresh').addEventListener('click', () => browse(rpc, toast, true));
}
