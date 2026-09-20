// dsh:logging-exempt (shim layer)
/**
 * node:util shim — formatting subset.
 *
 * Covers (upstream usage → this module):
 *   - cordis/cosmokit diagnostics paths (`format`, `inspect`, `promisify`) on
 *     error reporting routes only. `inspect` renders JSON-with-quotes, NOT
 *     node's depth/ color machinery — honest rendering for log lines.
 *
 * Intentionally NOT supported: inspect custom depth/colors/options object
 * (ignored silently is NOT ok — options are rejected), util.types re-export
 * (import node:util/types directly), callbackify/promisify.custom.
 */
const formatValue = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const format = (template, ...args) => {
  if (typeof template !== 'string') return args.map(formatValue).join(' ');
  let at = 0;
  let out = template.replace(/%[sdjifoO%]/g, (spec) => {
    if (spec === '%%') return '%';
    if (at >= args.length) return spec;
    const value = args[at++];
    switch (spec) {
      case '%s': return String(value);
      case '%d':
      case '%i': {
        const n = Number(value);
        return spec === '%i' ? String(Math.trunc(n)) : String(n);
      }
      case '%f': return String(Number(value));
      case '%j': return JSON.stringify(value) ?? 'undefined';
      case '%o':
      case '%O': return formatValue(value);
      default: return spec;
    }
  });
  if (at < args.length) {
    out += ` ${args.slice(at).map(formatValue).join(' ')}`;
  }
  return out;
};

export const inspect = (value) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const promisify = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('promisify requires a function');
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
};

export const deprecate = (fn, message) => (
  (...args) => {
    globalThis.console?.warn?.(`(node:util deprecate) ${message}`);
    return fn(...args);
  }
);

export const noop = () => {};
export const types = {}; // loud redirect: import node:util/types instead — property access on {} yields undefined
