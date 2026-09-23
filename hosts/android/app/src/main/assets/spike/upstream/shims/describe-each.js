// dsh:logging-exempt (test-harness surface)
/**
 * describe.each / it.each — the table-driven vitest forms, extracted from
 * the harness when its size crossed the file budget. Rows become suffixed
 * titles; the row value is the callback's argument.
 */
export function attachEachForms(describe, it) {
  const rowLabel = (row) => (
    typeof row === 'object' && row !== null ? JSON.stringify(row) : String(row)
  );
  describe.each = (rows) => (name, fn) => {
    for (const row of rows) {
      describe(`${name} (${rowLabel(row)})`, () => fn(row));
    }
  };
  it.each = (rows) => (name, fn) => {
    for (const row of rows) it(`${name} (${rowLabel(row)})`, () => fn(row));
  };
}
