// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/web-dom-parser.js — the small HTML parser, split out of web-dom.js
 * when that file crossed the code-size budget. The element/text/entity
 * primitives stay the single source of truth in web-dom.js (exported for
 * this module): an ESM cycle by construction, call-time access only —
 * neither module body touches the other's bindings at eval time, and
 * web-dom.js re-imports parseHTML for the innerHTML setter.
 */
import {
  DOMElement,
  TextNode,
  VOID_TAGS,
  decodeEntities,
} from 'upstream/shims/web-dom.js';

/** Apply one open tag's attribute glob to the element (module level for
 * size): bare attributes become '', quoted/unquoted values are unquoted and
 * entity-decoded, names lowercased — the HTML parser's attribute face. */
const applyAttributes = (el, attrText) => {
  const attrGlob = /([\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let am;
  attrGlob.lastIndex = 0;
  while ((am = attrGlob.exec(attrText)) !== null) {
    let value = am[2];
    if (value === undefined) {
      el.setAttribute(am[1].toLowerCase(), '');
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    el.setAttribute(am[1].toLowerCase(), decodeEntities(value));
  }
};

/** Tokenize a markup string into a root-level node list. Covers the corpus's
 * generated markup: open/close tags, bare and quoted attributes, void
 * elements, self-closing slashes, comments (skipped). No CDATA/doctype. */
export const parseHTML = (markup) => {
  const root = [];
  const stack = []; // innermost open element last
  const attach = (node) => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) root.push(node);
    else parent.append(node);
  };
  let rest = String(markup);
  const openTag = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
  while (rest.length > 0) {
    const lt = rest.indexOf('<');
    if (lt !== 0) {
      const text = lt === -1 ? rest : rest.slice(0, lt);
      attach(new TextNode(decodeEntities(text)));
      rest = lt === -1 ? '' : rest.slice(lt);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      rest = end === -1 ? '' : rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('</')) {
      const end = rest.indexOf('>');
      const name = rest.slice(2, end).trim().toUpperCase();
      // Pop to the nearest matching open tag (implicit close of unclosed ones).
      for (let at = stack.length - 1; at >= 0; at--) {
        if (stack[at].tagName === name) { stack.length = at; break; }
      }
      rest = rest.slice(end + 1);
      continue;
    }
    const m = openTag.exec(rest);
    if (m === null) {
      // A '<' that opens nothing is text (the parser stays total).
      attach(new TextNode('<'));
      rest = rest.slice(1);
      continue;
    }
    const el = new DOMElement(m[1]);
    applyAttributes(el, m[2]);
    attach(el);
    if (m[3] !== '/' && !VOID_TAGS.has(el.tagName)) stack.push(el);
    rest = rest.slice(m[0].length);
  }
  return root;
};
