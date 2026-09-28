// dsh:logging-exempt (test-harness surface)
/**
 * The table-driven and conditional vitest collection forms, extracted from
 * the harness when its size crossed the file budget. describe.each/it.each
 * rows become suffixed titles; array rows spread into the callback as
 * positional args (vitest semantics — e.g. acp codec's
 * `it.each([[reason, expected]])` destructures both), non-array rows pass
 * as the single argument. Titles interpolate printf verbs (%s %d %i %f
 * %o %O %j, %% literal) positionally and `$key`/`${key}` against object
 * rows, then carry the raw row as a uniqueness suffix.
 * skipIf/runIf pick collection or no-op per a runtime condition (measured
 * 2026-09-23: resume.spec's platform-gated tests call it.skipIf — an absent
 * member is a collection-time "not a function").
 */
/** BigInt-safe stringify: quickjs's JSON.stringify throws on BigInt values
 * ("BigInt are forbidden in JSON.stringify"), and the suite's settings and
 * typert generator tables carry BigInt rows — rendered as `123n` (node's
 * inspect spelling) so the row titles stay readable and unique. */
const safeStringify = (value) => JSON.stringify(value, (_key, v) => (
  typeof v === 'bigint' ? `${v.toString()}n` : v
));

export function attachEachForms(describe, it) {
  const rowLabel = (row) => {
    if (typeof row === 'object' && row !== null) {
      try {
        return safeStringify(row);
      } catch {
        // A row JSON cannot represent at all (cycle): a stable fallback that
        // still keeps rows distinct.
        return `[row ${Object.keys(row).join(',')}]`;
      }
    }
    return String(row);
  };
  const rowArgs = (row) => (Array.isArray(row) ? row : [row]);
  const rowTitle = (name, row) => {
    const args = rowArgs(row);
    let i = 0;
    let out = name.replace(/%[sdifjoO%]/g, (verb) => {
      if (verb === '%%') return '%';
      const v = args[i++];
      if (verb === '%s' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        return String(v);
      }
      try {
        return safeStringify(v) ?? String(v);
      } catch {
        return String(v);
      }
    });
    const subbed = out.replace(/\$\{([^}]+)\}|\$([\w$]+)/g, (m, braced, plain) => {
      const key = braced ?? plain;
      let v;
      if (row !== null && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, key)) {
        v = row[key];
      } else if (Array.isArray(row) && /^\d+$/.test(key)) {
        v = row[Number(key)];
      } else {
        return m; // no such member: keep the literal text
      }
      if (v === undefined) return '';
      if (typeof v === 'string') return v;
      try {
        return safeStringify(v) ?? String(v);
      } catch {
        return String(v);
      }
    });
    out = subbed.replace(/\$\{[^}]+\}/g, '').trim(); // leftover ${expr}: strip like the in-file it.each
    return `${out} (${rowLabel(row)})`;
  };
  describe.each = (rows) => (name, fn) => {
    for (const row of rows) {
      describe(rowTitle(name, row), () => fn(...rowArgs(row)));
    }
  };
  it.each = (rows) => (name, fn) => {
    for (const row of rows) it(rowTitle(name, row), () => fn(...rowArgs(row)));
  };
  const pick = (collect, noOp) => (condition) => (condition ? noOp : collect);
  describe.skipIf = pick(describe, describe.skip);
  describe.runIf = pick(describe, describe.skip);
  it.skipIf = pick(it, it.skip);
  it.runIf = pick(it, it.skip);
}
