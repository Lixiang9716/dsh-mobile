// dsh:logging-exempt (shim layer; parser face, no logging surface)
/**
 * partial-json — the lenient-JSON face pi-ai's streaming tool-call parser
 * reaches (dist/utils/json-parse.js: `import { parse as partialParse } from
 * "partial-json"`). The package is NOT vendored (never fetched — the round-5
 * npm-bridges note), and before the openai face (openai-client.js) the lazy
 * api module never even loaded, so the specifier stayed unserved. Now every
 * pi-ai stream links json-parse.js and the specifier must resolve.
 *
 * Composed face: pi-ai's own chain is JSON.parse → repairJson → partialParse
 * → partialParse(repaired) → {}, so this only has to beat plain JSON.parse on
 * TRUNCATED structure — the classic completion walk: track the open
 * string/array/object stack, then append the missing closers (dropping
 * dangling `,`/`:`/escape fragments first). `Allow` is API-compat only; the
 * pinned usage calls parse(text) with the default (ALL) behavior.
 */

const stripTrailingFragment = (text) => {
  // A value position cut mid-token: dangling comma, dangling colon, or a
  // partial literal (`tru`, `fals`, `nul`) or number (`1.2e`). Only a bare
  // fragment AFTER a structural character is strippable — never inside a
  // string (string truncation is handled by the caller via re-quoting).
  return text.replace(/(,\s*)?\(?(:\s*)?([A-Za-z0-9._+eE-]*)$/, (full, comma, colon) => {
    // Keep a complete bare literal word (true/false/null) — JSON.parse
    // rejects it only when the STRUCTURE around it is broken, which the
    // closer-append below then fixes.
    if (!comma && !colon && /^(true|false|null)$/.test(full)) return full;
    return '';
  });
};

export function parse(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch { /* fall through to the completion walk */ }
  // Walk the structure: which containers are open, and is a string open?
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  const closers = [];
  for (let i = stack.length - 1; i >= 0; i--) closers.push(stack[i] === '{' ? '}' : ']');
  // Candidate ladder — the first JSON.parse win returns.
  const bases = [text];
  if (inString) {
    // A dangling escape (`...\`) swallows the appended quote; drop it first.
    bases.push(escape ? `${text.slice(0, -1)}"` : `${text}"`);
  }
  const attempts = [];
  for (const base of bases) {
    attempts.push(base);
    attempts.push(stripTrailingFragment(base));
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt + closers.join(''));
    } catch { /* next candidate */ }
  }
  throw new SyntaxError(`partial-json: unable to parse ${text.slice(0, 60)}`);
}

/** API compat: the pinned pi-ai usage never passes an Allow mask (the default
 * is ALL). Bit values mirror the package's documented flags. */
export const Allow = {
  STR: 1 << 0,
  NUM: 1 << 1,
  ARR: 1 << 2,
  OBJ: 1 << 3,
  ALL: (1 << 4) - 1,
};

export default { parse, Allow };
