// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * render-home.js — the workspace home: the deep-ocean glass hero, the
 * connection capsule, and the session list (status dot: pulsing green =
 * running, idle gray = settled; monospaced short id + relative time).
 * Session titles arrive per-session over the journal, which a list view
 * does not open — v1 shows the short id honestly instead of a guessed
 * title (a session/summaries title surface is the v2 ask).
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const shortId = (sessionId) => String(sessionId).slice(0, 8);

const relativeTime = (updatedAt) => {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const seconds = Date.now() / 1000 - updatedAt;
  if (seconds > 5 * 365 * 86400) return ''; // fixture/dev epochs are not wall-clock
  if (seconds < 0) return '刚刚';
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
};

/** The connection capsule: one dot + one word, per status. */
export function renderConnection(capsule, status) {
  const dot = capsule.querySelector('.dot');
  const label = capsule.querySelector('.capsule-text');
  const spec = {
    open: ['dot-green', '已连接'],
    connecting: ['dot-amber dot-pulse', '连接中'],
    closed: ['dot-red', '已断开'],
  }[status] ?? ['dot-amber dot-pulse', '连接中'];
  dot.className = `dot ${spec[0]}`;
  label.textContent = spec[1];
}

/** Rebuild the session list rows from a session/list value. */
export function renderSessionList(host, emptyNote, sessions, onOpen) {
  const rows = sessions.map((session) => {
    const row = el('button', 'session-row');
    row.type = 'button';
    row.setAttribute('role', 'listitem');
    const main = el('div', 'session-row-main');
    main.appendChild(el('div', 'session-row-title',
      session.blank ? '新会话' : `会话 ${shortId(session.sessionId)}`));
    const meta = [shortId(session.sessionId), relativeTime(session.updatedAt)]
      .filter((part) => part !== '').join(' · ');
    main.appendChild(el('div', 'session-row-meta', meta));
    row.appendChild(main);
    const dot = el('span', session.running
      ? 'dot dot-green dot-pulse' : 'dot dot-idle');
    row.appendChild(dot);
    row.addEventListener('click', () => onOpen(session.sessionId));
    return row;
  });
  host.replaceChildren(...rows);
  emptyNote.hidden = sessions.length > 0;
}
