// dsh:logging-exempt (test-harness surface)
/**
 * The table-driven and conditional vitest collection forms, extracted from
 * the harness when its size crossed the file budget. describe.each/it.each
 * rows become suffixed titles; the row value is the callback's argument.
 * skipIf/runIf pick collection or no-op per a runtime condition (measured
 * 2026-09-23: resume.spec's platform-gated tests call it.skipIf — an absent
 * member is a collection-time "not a function").
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
  const pick = (collect, noOp) => (condition) => (condition ? noOp : collect);
  describe.skipIf = pick(describe, describe.skip);
  describe.runIf = pick(describe, describe.skip);
  it.skipIf = pick(it, it.skip);
  it.runIf = pick(it, it.skip);
}
