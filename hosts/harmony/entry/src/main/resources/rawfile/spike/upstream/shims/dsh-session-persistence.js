// dsh:logging-exempt (shim layer)
/**
 * @deepseek-ai/dsh-session-persistence shim — ERRORS ONLY.
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent-loop (`SessionPersistenceNotFoundError`) — imported at module
 *     load; thrown only on the resume path, which requires a real persistence
 *     backend and is out of PR-A scope.
 *
 * This is NOT the persistence service: no create/open/append backend exists
 * here. A resume attempt fails with the plain "session persistence is not
 * configured" error upstream throws when the service is absent (the vendored
 * agent-loop checks `ctx.get("sessionPersistence")` first, so the shim error
 * class is linkage-only in PR-A).
 *
 * Staged: when W-LLM/W-PERSIST vendors the real package, delete the loader's
 * mapping row and add the package to ensure-dsh.sh — no other change.
 */

/** The requested Session identity has no durable log visible to this caller. */
export class SessionPersistenceNotFoundError extends Error {
  constructor(sessionId) {
    super(`session "${sessionId}" not found`);
    this.name = 'SessionPersistenceNotFoundError';
    this.sessionId = sessionId;
  }
}

/** `create` targeted a Session identity that already exists in this backend. */
export class SessionAlreadyExistsError extends Error {
  constructor(sessionId) {
    super(`session "${sessionId}" already exists`);
    this.name = 'SessionAlreadyExistsError';
    this.sessionId = sessionId;
  }
}

/** A write open found the session already bound to an active write handle. */
export class SessionAlreadyOwnedError extends Error {
  constructor(sessionId) {
    super(`session "${sessionId}" is already owned by an active write handle`);
    this.name = 'SessionAlreadyOwnedError';
    this.sessionId = sessionId;
  }
}

/** A mutation (append/flush) was called on a read handle. */
export class SessionReadOnlyError extends Error {
  constructor(sessionId, operation) {
    super(`session "${sessionId}": ${operation} is not available on a read handle`);
    this.name = 'SessionReadOnlyError';
    this.sessionId = sessionId;
  }
}
