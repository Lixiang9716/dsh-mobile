/**
 * Chrome.tsx — the top bar (neutral DSH wordmark + connection capsule +
 * drawer toggle) and the session drawer. Drawer open/close is UI-local
 * state and never crosses the seam; only select-session / new-session do.
 */
import type { FC } from '@lynx-js/react';
import {
  styles, CONNECTION_COLORS, CONNECTION_LABELS,
} from '../styles.js';
import type { SessionRow } from './types.js';

const shortId = (sessionId: string): string => String(sessionId).slice(0, 8);

const relativeTime = (updatedAt: number): string => {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const seconds = Date.now() / 1000 - updatedAt;
  if (seconds > 5 * 365 * 86400) return ''; // fixture/dev epochs are not wall-clock
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
};

export const TopBar: FC<{
  connection: string;
  onDrawer: () => void;
}> = ({ connection, onDrawer }) => (
  <view style={styles.topBar}>
    <view style={styles.topBarSide}>
      <view style={styles.iconBtn} bindtap={onDrawer}>
        <text style={styles.iconBtnText}>☰</text>
      </view>
    </view>
    <text style={styles.wordmark}>DSH</text>
    <view style={{ ...styles.topBarSide, justifyContent: 'flex-end' as const }}>
      <view
        style={{ ...styles.connDot, backgroundColor: CONNECTION_COLORS[connection] ?? CONNECTION_COLORS.connecting }}
        className='dot-pulse'
      />
      <text style={styles.iconBtnText}>{CONNECTION_LABELS[connection] ?? CONNECTION_LABELS.connecting}</text>
    </view>
  </view>
);

export const Drawer: FC<{
  sessions: SessionRow[];
  onClose: () => void;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}> = ({ sessions, onClose, onSelect, onNew }) => (
  <view style={styles.backdrop}>
    <view style={styles.drawerScrim} bindtap={onClose} />
    <view style={styles.drawer}>
      <text style={styles.drawerTitle}>会话抽屉</text>
      <view style={styles.newSessionBtn} bindtap={onNew}>
        <text style={styles.newSessionText}>＋ 新建会话</text>
      </view>
      <scroll-view scroll-orientation='vertical' style={{ flex: 1 }}>
        {sessions.length === 0 ? (
          <text style={styles.sessionMeta}>还没有会话 — 从上面开始</text>
        ) : null}
        {sessions.map((session) => (
          <view key={session.sessionId} style={styles.sessionRow} bindtap={() => onSelect(session.sessionId)}>
            <view style={styles.sessionMain}>
              <text style={styles.sessionTitle}>
                {session.blank ? '新会话' : `会话 ${shortId(session.sessionId)}`}
              </text>
              <text style={styles.sessionMeta}>
                {`${shortId(session.sessionId)}${relativeTime(session.updatedAt) === '' ? '' : ` · ${relativeTime(session.updatedAt)}`}`}
              </text>
            </view>
            <view
              style={{
                ...styles.connDot,
                backgroundColor: session.running ? CONNECTION_COLORS.open : CONNECTION_COLORS.connecting,
                marginRight: 0,
              }}
              className={session.running ? 'dot-pulse' : undefined}
            />
          </view>
        ))}
      </scroll-view>
    </view>
  </view>
);
