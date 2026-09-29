/**
 * Markdown.tsx — the minimal markdown face for Lynx: block parse (fenced
 * code, headings, list items, paragraphs) + inline parse (bold, italic,
 * inline code, links) into native <text> trees. Pure presentation; the
 * web client's markdown.js coverage narrows to what a chat transcript
 * actually shows. Links render styled but do not navigate (v0 surface).
 */
import type { FC, ReactNode } from '@lynx-js/react';
import { styles } from '../styles.js';

type Seg = { text: string; style: 'plain' | 'bold' | 'italic' | 'code' | 'link' };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

/** One line → styled segments. */
export const parseInline = (line: string): Seg[] => {
  const segments: Seg[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: line.slice(cursor, start), style: 'plain' });
    if (token.startsWith('**')) segments.push({ text: token.slice(2, -2), style: 'bold' });
    else if (token.startsWith('`')) segments.push({ text: token.slice(1, -1), style: 'code' });
    else if (token.startsWith('*')) segments.push({ text: token.slice(1, -1), style: 'italic' });
    else segments.push({ text: token.slice(1, token.indexOf(']')), style: 'link' });
    cursor = start + token.length;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), style: 'plain' });
  return segments;
};

const segStyle = (style: Seg['style']) => {
  if (style === 'bold') return styles.mdBold;
  if (style === 'italic') return styles.mdItalic;
  if (style === 'code') return styles.mdCode;
  if (style === 'link') return styles.mdLink;
  return undefined;
};

/** One styled line of inline segments. */
export const InlineText = ({ line, base }: { line: string; base: Record<string, unknown> }) => (
  <text style={base}>
    {parseInline(line).map((seg, i) => (
      <text key={i} style={segStyle(seg.style)}>{seg.text}</text>
    ))}
  </text>
);

/** The block face: one markdown source → native rows. */
export const Markdown: FC<{ source: string }> = ({ source }) => {
  const rows: Array<{ key: number; node: ReactNode }> = [];
  let inFence = false;
  let fence: string[] = [];
  source.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      if (inFence) {
        rows.push({ key: index, node: (
          <view key={index} style={styles.codeBlock}>
            <text style={styles.codeBlockText}>{fence.join('\n')}</text>
          </view>
        ) });
        fence = [];
      }
      inFence = !inFence;
      return;
    }
    if (inFence) { fence.push(line); return; }
    if (line.startsWith('#')) {
      rows.push({ key: index, node: (
        <InlineText key={index} base={styles.mdHeading} line={line.replace(/^#+\s*/, '')} />
      ) });
    } else if (/^\s*[-*]\s/.test(line)) {
      rows.push({ key: index, node: (
        <InlineText key={index} base={styles.mdListItem} line={`· ${line.replace(/^\s*[-*]\s*/, '')}`} />
      ) });
    } else if (line.trim() !== '') {
      rows.push({ key: index, node: <InlineText key={index} base={styles.mdText} line={line} /> });
    }
  });
  if (inFence && fence.length > 0) {
    rows.push({ key: -1, node: (
      <view key={-1} style={styles.codeBlock}>
        <text style={styles.codeBlockText}>{fence.join('\n')}</text>
      </view>
    ) });
  }
  return <view>{rows.map((row) => row.node)}</view>;
};
