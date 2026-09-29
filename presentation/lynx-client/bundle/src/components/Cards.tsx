/**
 * Cards.tsx — the tool card's THREE states and the collapsible process
 * group. A card is pure props: it renders whatever the fold says and
 * never subscribes to anything (iron law #1, bundle side).
 *   streaming / waiting → spinner dot + chip (准备中 / 等待结果) + live args
 *   ok / fail           → chip (完成 / 失败) + output collapsed in-card,
 *                         tap toggles the full text
 */
import { useState } from '@lynx-js/react';
import type { FC } from '@lynx-js/react';
import { styles } from '../styles.js';
import type { FoldItem, TailTool } from './types.js';

const toolGlyph = (name: string): string => {
  if (/^(write|edit|apply)/.test(name)) return '✎';
  if (/^(bash|shell|ish|wasm)/.test(name)) return '❯';
  if (/^(read|list|glob|grep)/.test(name)) return '☰';
  return '⚙';
};

const CHIP_STYLE = {
  waiting: ['chipRun', 'chipTextRun', '等待结果'],
  ok: ['chipDone', 'chipTextDone', '完成'],
  fail: ['chipFail', 'chipTextFail', '失败'],
} as const;

const OutBlock: FC<{ item: FoldItem }> = ({ item }) => {
  const [expanded, setExpanded] = useState(false);
  const isError = item.status === 'fail';
  const raw = item.output ?? '';
  const text = expanded || raw.length <= 160
    ? raw
    : `${raw.slice(0, 160)}…`;
  return (
    <view style={{ ...styles.cardOut, ...(isError ? styles.cardOutError : {}) }}
      bindtap={() => setExpanded(!expanded)}>
      <text style={styles.cardOutLabel}>{expanded ? 'OUT ▴' : 'OUT ▾'}</text>
      <text style={styles.cardOutText}>{text}</text>
    </view>
  );
};

/** One durable tool card: waiting (running) or settled (ok/fail). */
export const ToolCard: FC<{ item: FoldItem }> = ({ item }) => {
  const name = item.name ?? 'tool';
  const [which, tone, label] = CHIP_STYLE[(item.status ?? 'waiting') as 'waiting'] ?? CHIP_STYLE.waiting;
  return (
    <view style={styles.card}>
      <view style={styles.cardHead}>
        <text style={styles.cardGlyph}>{toolGlyph(name)}</text>
        <text style={styles.cardName}>{name}</text>
        <view style={{ ...styles.chip, ...styles[which] }}>
          <text style={{ ...styles.chipText, ...styles[tone] }}>{label}</text>
        </view>
      </view>
      {item.args ? <text style={styles.cardArgs}>{item.args}</text> : null}
      {item.output ? <OutBlock item={item} /> : null}
    </view>
  );
};

/** A tool still building inside the streaming tail (准备中). */
export const TailToolRow: FC<{ tool: TailTool }> = ({ tool }) => (
  <view style={styles.card}>
      <view style={styles.cardHead}>
        <text style={styles.cardGlyph}>{toolGlyph(tool.name || 'tool')}</text>
        <text style={styles.cardName}>{tool.name || 'tool'}</text>
        <view style={{ ...styles.chip, ...styles.chipRun }}>
          <text style={{ ...styles.chipText, ...styles.chipTextRun }}>准备中</text>
        </view>
      </view>
    {tool.args ? <text style={styles.cardArgs}>{tool.args}</text> : null}
  </view>
);

/** The collapsible group over a consecutive run of reasoning/tool rows. */
export const ProcessGroup: FC<{ run: FoldItem[] }> = ({ run }) => {
  const [open, setOpen] = useState(false);
  const tools = run.filter((item) => item.kind === 'tool');
  const preview = tools.length > 0
    ? `使用了 ${tools.map((t) => t.name ?? 'tool').slice(0, 3).join('、')}${tools.length > 3 ? ' 等' : ''} 工具`
    : '思考过程';
  return (
    <view style={styles.group}>
      <view style={styles.groupHead} bindtap={() => setOpen(!open)}>
        <text style={styles.cardGlyph}>⚙</text>
        <text style={styles.groupPreview}>{`${preview} · ${run.length}`}</text>
        <text style={styles.groupChevron}>{open ? '▼' : '▶'}</text>
      </view>
      {open ? (
        <view style={styles.groupBody}>
          {run.map((item, i) => (item.kind === 'tool'
            ? <ToolCard key={item.callId ?? i} item={item} />
            : (
              <view key={i} style={styles.row}>
                <text style={styles.tailReason}>{`◆ 思考：${item.text ?? ''}`}</text>
              </view>
            )))}
        </view>
      ) : null}
    </view>
  );
};
