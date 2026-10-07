// dsh:logging-exempt (web page: all E2E evidence flows through carrier/runtime logs)
/**
 * markdown.js — a bounded markdown subset (headings, hr, blockquote, one-
 * level lists, fenced code with language caption, paragraphs; inline code,
 * bold, italic, links) rendered by DOM construction only — user-facing
 * strings never ride innerHTML, so there is no injection surface. The
 * parsed block tree is cached by source string (the clarklevis
 * ParsedMarkdownCache pattern) so streaming re-renders and virtualized
 * reuse never re-parse long responses.
 */

const CACHE_LIMIT = 256;
const cache = new Map();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Split one line into inline-styled DOM nodes appended to `parent`. */
const renderInline = (parent, text) => {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/;
  let rest = text;
  while (rest !== '') {
    const match = rest.match(pattern);
    if (match === null || match.index === undefined) {
      parent.appendChild(el('span', undefined, rest));
      return;
    }
    if (match.index > 0) parent.appendChild(el('span', undefined, rest.slice(0, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      parent.appendChild(el('code', 'inline-code', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      parent.appendChild(el('strong', undefined, token.slice(2, -2)));
    } else if (token.startsWith('*')) {
      parent.appendChild(el('em', undefined, token.slice(1, -1)));
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const url = token.slice(token.indexOf('(') + 1, -1);
      const anchor = el('a', undefined, label);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      parent.appendChild(anchor);
    }
    rest = rest.slice(match.index + token.length);
  }
};

const headingLevel = (line) => {
  const match = line.match(/^(#{1,4})\s+(.*)$/);
  return match === null ? null : { level: match[1].length, text: match[2] };
};

const renderFence = (parent, info, lines) => {
  const block = el('div', 'code-block');
  if (info !== '') block.appendChild(el('span', 'code-lang', info));
  const pre = el('pre');
  const code = el('code');
  code.textContent = lines.join('\n');
  pre.appendChild(code);
  block.appendChild(pre);
  parent.appendChild(block);
};

/** Scan one line array into the plain-data block tree
 * ({kind, ...}) the renderer walks. */
const scanBlocks = (lines) => {
  const blocks = [];
  let index = 0;
  while (index < lines.length) index = scanOne(blocks, lines, index);
  return blocks;
};

/** Consume one block starting at `index`; returns the next index. */
const scanOne = (blocks, lines, index) => {
  const line = lines[index];
  const fence = line.match(/^```(.*)$/);
  if (fence !== null) return scanFence(blocks, lines, index + 1, fence[1].trim());
  if (line.trim() === '') return index + 1;
  const heading = line.match(/^(#{1,4})\s+(.*)$/);
  if (heading !== null) {
    blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
    return index + 1;
  }
  if (/^(---+|\*\*\*+)$/.test(line.trim())) {
    blocks.push({ kind: 'hr' });
    return index + 1;
  }
  if (line.startsWith('>')) return scanQuote(blocks, lines, index);
  const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (bullet !== null) return scanList(blocks, lines, index, /\d/.test(bullet[2]));
  return scanParagraph(blocks, lines, index);
};

const scanFence = (blocks, lines, index, info) => {
  const body = [];
  while (index < lines.length && !lines[index].startsWith('```')) {
    body.push(lines[index]);
    index += 1;
  }
  blocks.push({ kind: 'fence', info, body });
  return index + 1; // closing fence (or EOF)
};

const scanQuote = (blocks, lines, index) => {
  const body = [];
  while (index < lines.length && lines[index].startsWith('>')) {
    body.push(lines[index].replace(/^>\s?/, ''));
    index += 1;
  }
  blocks.push({ kind: 'quote', text: body.join('\n') });
  return index;
};

const scanList = (blocks, lines, index, ordered) => {
  const entries = [];
  while (index < lines.length) {
    const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item === null || /\d/.test(item[2]) !== ordered) break;
    entries.push(item[3]);
    index += 1;
  }
  blocks.push({ kind: 'list', ordered, entries });
  return index;
};

const scanParagraph = (blocks, lines, index) => {
  const paragraph = [];
  while (index < lines.length && isBodyLine(lines[index])) {
    paragraph.push(lines[index]);
    index += 1;
  }
  blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  return index;
};

const isBodyLine = (line) => line.trim() !== ''
  && !line.startsWith('```') && !line.startsWith('>')
  && !/^(#{1,4})\s+/.test(line)
  && !/^(\s*)([-*+]|\d+[.)])\s+/.test(line);

/** Parse once per source; the tree is cached by exact source string. */
const parse = (source) => {
  if (cache.has(source)) return cache.get(source);
  const blocks = scanBlocks(source.split('\n'));
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(source, blocks);
  return blocks;
};

/** Render markdown source into a div.md built of DOM nodes. */
export function renderMarkdown(source) {
  const root = el('div', 'md');
  for (const block of parse(source ?? '')) {
    if (block.kind === 'fence') {
      renderFence(root, block.info, block.body);
    } else if (block.kind === 'heading') {
      root.appendChild(renderInlineInto(`h${Math.min(block.level, 4)}`, block.text));
    } else if (block.kind === 'hr') {
      root.appendChild(el('hr'));
    } else if (block.kind === 'quote') {
      const quote = el('blockquote');
      renderInline(quote, block.text);
      root.appendChild(quote);
    } else if (block.kind === 'list') {
      const list = el(block.ordered ? 'ol' : 'ul');
      for (const entry of block.entries) {
        const item = el('li');
        renderInline(item, entry);
        list.appendChild(item);
      }
      root.appendChild(list);
    } else {
      const paragraph = el('p');
      renderInline(paragraph, block.text);
      root.appendChild(paragraph);
    }
  }
  return root;
}

const renderInlineInto = (tag, text) => {
  const node = el(tag);
  renderInline(node, text);
  return node;
};
