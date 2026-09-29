/**
 * Thread.tsx — the conversation thread: a scroll-view of rows built from
 * the fold snapshot (props only — no subscriptions below App). Structure
 * bumps rebuild the list; the streaming tail renders as its own block
 * under the items (the dedicated-streaming-row pattern).
 */
import type { FC, ReactNode } from '@lynx-js/react';
import { styles } from '../styles.js';
import type { SurfaceState } from '../bridge.js';
import type { FoldItem } from './types.js';
import { Markdown } from './Markdown.js';
import { ProcessGroup, ToolCard, TailToolRow } from './Cards.js';

const isProcess = (item: FoldItem): boolean =>
  item.kind === 'reasoning' || item.kind === 'tool';

const StatusRow: FC<{ item: FoldItem }> = ({ item }) => (
  <view style={styles.statusRow}>
    <text style={styles.statusDot}>·</text>
    <text style={{ ...styles.statusText, ...(item.label === 'warn' ? styles.statusWarn : {}) }}>
      {item.text}
    </text>
  </view>
);

const CreationCard: FC<{ item: FoldItem }> = ({ item }) => (
  <view>
    {(item.files ?? []).map((file, i) => (
      <view key={i} style={styles.creationCard}>
        <text style={styles.creationGlyph}>🎨</text>
        <view style={styles.sessionMain}>
          <text style={styles.creationTitle}>{file.description || file.path}</text>
          <text style={styles.creationPath}>{file.path}</text>
        </view>
        <text style={styles.mdLink}>查看</text>
      </view>
    ))}
  </view>
);

const UserBubble: FC<{ item: FoldItem }> = ({ item }) => (
  <view style={styles.bubbleUser}>
    <text style={styles.bubbleUserText}>{item.text}</text>
  </view>
);

const AssistantBlock: FC<{ item: FoldItem }> = ({ item }) => (
  <view style={styles.assistantBlock}>
    <view style={styles.assistantHeader}>
      <text style={styles.assistantAvatar}>◆</text>
      <text style={styles.assistantName}>DSH</text>
      {item.interrupted ? <text style={styles.assistantBadge}>已中断</text> : null}
    </view>
    <Markdown source={item.markdown ?? ''} />
  </view>
);

/** One item → its row; reasoning/tool runs are pulled out by the grouper. */
const renderSingle = (item: FoldItem, key: number): ReactNode => {
  if (item.kind === 'user') return <UserBubble key={key} item={item} />;
  if (item.kind === 'assistant') return <AssistantBlock key={key} item={item} />;
  if (item.kind === 'tool') return <ToolCard key={item.callId ?? key} item={item} />;
  if (item.kind === 'creation') return <CreationCard key={key} item={item} />;
  if (item.kind === 'status') return <StatusRow key={key} item={item} />;
  if (item.kind === 'notice' || item.kind === 'system') {
    return (
      <StatusRow key={key} item={{ ...item, text: `${item.label ?? 'system'}: ${(item.types ?? []).join(', ')}` }} />
    );
  }
  return <StatusRow key={key} item={{ ...item, text: item.kind }} />;
};

/** Group consecutive reasoning/tool items into one collapsible card. */
const renderRows = (items: FoldItem[]): ReactNode[] => {
  const rows: ReactNode[] = [];
  let index = 0;
  while (index < items.length) {
    if (!isProcess(items[index])) {
      rows.push(renderSingle(items[index], index));
      index += 1;
      continue;
    }
    let end = index;
    while (end < items.length && isProcess(items[end])) end += 1;
    rows.push(<ProcessGroup key={`g${index}`} run={items.slice(index, end)} />);
    index = end;
  }
  return rows;
};

/** The streaming tail block (never reconciles the item list). */
const TailBlock: FC<{ state: SurfaceState }> = ({ state }) => {
  const tail = state.tail;
  if (tail === null) return null;
  return (
    <view style={styles.tailWrap}>
      <text style={styles.tailState}>{tail.streaming ? '生成中…' : '正在思考…'}</text>
      {tail.reasoning !== '' ? (
        <text style={styles.tailReason}>{`◆ 思考：${tail.reasoning}`}</text>
      ) : null}
      {tail.text !== '' ? (
        <text style={styles.tailText}>
          {tail.text}
          <text style={styles.cursor} className='cursor-blink'>▍</text>
        </text>
      ) : null}
      {tail.tools.map((tool) => <TailToolRow key={tool.id} tool={tool} />)}
    </view>
  );
};

export const Thread: FC<{ state: SurfaceState }> = ({ state }) => (
  <scroll-view style={styles.thread} scroll-orientation='vertical'>
    {renderRows(state.items as FoldItem[])}
    <TailBlock state={state} />
  </scroll-view>
);
