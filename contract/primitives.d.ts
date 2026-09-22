/**
 * dsh-mobile capability gateway — primitive contract v1.2.0 (FROZEN at M0, D5;
 * v1.1.0 is the additive filesystem revision of 2026-09-22, v1.2.0 the
 * in-process WebAssembly addition).
 *
 * Spec of record: contract/primitives.md. Shapes here are immutable for the
 * life of major version 1; additions require a minor bump of the contract.
 * Negotiation string: `gateway@1`.
 */

// ---- shared conventions -------------------------------------------------

/** Structured rejection of any primitive call. Unknown codes are fatal. */
export type GatewayErrorCode =
  | "denied"
  | "unavailable"
  | "invalid"
  | "io"
  | "network"
  | "timeout"
  | "cancelled";

export type GatewayError = {
  code: GatewayErrorCode;
  /** Primitive the error came from, e.g. "fsRead". */
  primitive: string;
  message?: string;
  detail?: unknown;
};

/** Opaque token for a user-granted or reserved filesystem scope. */
export type ScopeHandle = string;
/** Opaque, persistable token restoring a scope across launches. */
export type ScopeRef = string;
/** Opaque credential reference (persisted under profile state/). */
export type KeyRef = string;

// ---- 1-3 · filesystem ---------------------------------------------------

export declare function fsRead(
  scope: ScopeHandle,
  path: string,
): Promise<{ bytes: Uint8Array; mtime: string }>;

export declare function fsWrite(
  scope: ScopeHandle,
  path: string,
  bytes: Uint8Array,
  opts?: { append?: boolean; create?: boolean },
): Promise<{ written: number }>;

export declare namespace fsScope {
  export declare function persist(scope: ScopeHandle): Promise<{ ref: ScopeRef }>;
  export declare function resolve(ref: ScopeRef): Promise<{ scope: ScopeHandle }>;
}

// ---- 10-14 · filesystem additions (v1.1.0) ------------------------------
// The operations @deepseek-ai/dsh-fs-local performs on top of fsRead/fsWrite:
// resolve/stat/list before a read, mkdir + rename for the atomic-write path,
// remove for cleanup. Same scope-relative POSIX path rule as fsRead/fsWrite.

/** What a path is. `other` covers sockets, devices and anything else the
 * platform refuses to classify as a plain file or directory. */
export type FsEntryKind = "file" | "dir" | "other";

export declare function fsStat(
  scope: ScopeHandle,
  path: string,
): Promise<{ kind: FsEntryKind; size: number; mtime: string }>;

export declare function fsList(
  scope: ScopeHandle,
  path: string,
): Promise<{ entries: Array<{ name: string; kind: FsEntryKind }> }>;

export declare function fsMkdir(
  scope: ScopeHandle,
  path: string,
  opts?: { existing?: "ok" | "error" },
): Promise<Record<string, never>>;

export declare function fsRemove(
  scope: ScopeHandle,
  path: string,
  opts?: { recursive?: boolean; missing?: "ok" | "error" },
): Promise<Record<string, never>>;

export declare function fsRename(
  scope: ScopeHandle,
  from: string,
  to: string,
): Promise<Record<string, never>>;

// ---- 4 · network --------------------------------------------------------

export type HttpFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
};

export type HttpFetchResponse = {
  status: number;
  headers: Record<string, string>;
  /** Event sequence of byte chunks — never a blocking whole-result (D8). */
  body: AsyncIterable<Uint8Array>;
  abort(): void;
};

export declare function httpFetch(url: string, init?: HttpFetchInit): Promise<HttpFetchResponse>;

// ---- 5 · notifications --------------------------------------------------

export type NotifyPayload = {
  title: string;
  body?: string;
  threadId?: string;
  data?: Record<string, unknown>;
};

export declare function notify(payload: NotifyPayload): Promise<{ id: string }>;

// ---- 6-7 · native UI ----------------------------------------------------

export declare function presentApproval(req: {
  title: string;
  detail?: string;
  allowRemember?: boolean;
}): Promise<{ approved: boolean; remember?: boolean }>;

export type PickerRequest = { mode: "file" | "directory"; suggestedName?: string };
export type PickerResult = { scope: ScopeHandle; path: string | null };

/** Resolves null on user dismissal — a value, not an error. */
export declare function presentPicker(req: PickerRequest): Promise<PickerResult | null>;

// ---- 8-9 · credentials --------------------------------------------------

export declare function keychainGet(ref: KeyRef): Promise<{ secret: Uint8Array } | null>;

/** secret = null deletes the credential. */
export declare function keychainSet(ref: KeyRef, secret: Uint8Array | null): Promise<void>;

// ---- event channels (bridge-delivered, not calls) ------------------------

export type AppStateChanged = { state: "foreground" | "background" };
export type NotifyResponse = { id: string; action?: string };

// ---- 15 · wasm (v1.2.0) -------------------------------------------------
// One export of one module, executed IN-PROCESS: iOS forbids JIT and this
// architecture refuses subprocesses (D2), so the alternative is no WebAssembly
// at all rather than a child process. The module talks to the host through the
// imported function `dsh.emit(ptr, len)`; the host writes `input` into the last
// 4096 bytes of the module's current memory and passes (ptr, len) to `func`.
export declare function wasmRun(
  scope: ScopeHandle,
  path: string,
  func: string,
  input?: string,
): Promise<{ result: number; output: string }>;
