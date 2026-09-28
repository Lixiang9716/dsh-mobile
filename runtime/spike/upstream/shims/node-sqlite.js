// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:sqlite — DatabaseSync over the host's real sqlite3 (already linked
 * for the iSH userland; see dsh_spike_host.c's node:sqlite seam, W5-R,
 * 2026-09-28). The subset the session-query/storage schemas drive: exec,
 * prepare → StatementSync {run, get, all, iterate}, close, plus open
 * (re-open) and the function-valued member faces the corpus touches.
 * Databases are REAL files under the profile container — the SQL engine is
 * a desktop host capability, honestly served rather than faked.
 */
const openIntrinsic = globalThis.__dshSqliteOpen;
const closeIntrinsic = globalThis.__dshSqliteClose;
const execIntrinsic = globalThis.__dshSqliteExec;
const prepareIntrinsic = globalThis.__dshSqlitePrepare;
const runIntrinsic = globalThis.__dshSqliteRun;
const getIntrinsic = globalThis.__dshSqliteGet;
const allIntrinsic = globalThis.__dshSqliteAll;

const needSeam = () => {
  throw new Error('node:sqlite: the host sqlite3 seam is absent (__dshSqlite* intrinsics missing)');
};

class StatementSync {
  #stmt = 0;
  constructor(stmt) { this.#stmt = stmt; }
  run(...params) {
    const res = runIntrinsic(this.#stmt, params);
    return { changes: Number(res.changes ?? 0), lastInsertRowid: Number(res.lastInsertRowid ?? 0) };
  }
  get(...params) {
    return getIntrinsic(this.#stmt, params);
  }
  all(...params) {
    return allIntrinsic(this.#stmt, params);
  }
  *iterate(...params) {
    for (;;) {
      const row = getIntrinsic(this.#stmt, params);
      if (row === null || row === undefined) return;
      yield row;
    }
  }
  sourceSQL() { return this.#sourceSQL ?? ''; }
  setReadBigInts(enabled) { this.#readBigInts = enabled === true; return this; }
  #sourceSQL = '';
  #readBigInts = false;
}

export class DatabaseSync {
  #db = -1;
  #open = false;
  constructor(path, options = {}) {
    const res = openIntrinsic(String(path));
    this.#db = res.handle;
    this.#open = true;
    if (options?.open !== false) { /* node:sqlite opens eagerly; nothing else to do */ }
  }
  get isOpen() { return this.#open; }
  open(path) {
    const res = openIntrinsic(String(path));
    this.#db = res.handle;
    this.#open = true;
  }
  close() {
    if (this.#open) closeIntrinsic(this.#db);
    this.#open = false;
  }
  exec(sql) {
    return execIntrinsic(this.#db, String(sql));
  }
  prepare(sql) {
    const res = prepareIntrinsic(this.#db, String(sql));
    const stmt = new StatementSync(res.stmt);
    return stmt;
  }
  /** node's function-valued members (aggregate/scalar registration) are not
   * part of the exercised surface; createFunction fails loud (rule 5). */
  createFunction() { throw new Error('node:sqlite: createFunction is not served in this runtime'); }
  createAggregate() { throw new Error('node:sqlite: createAggregate is not served in this runtime'); }
}

export default { DatabaseSync, constant: {} };
export const constants = {};
