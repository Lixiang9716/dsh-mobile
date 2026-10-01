// dsh:logging-exempt (adapter seam: all emission rides the caller's sink)
/**
 * upstream/wire-logger.js — the cordis logger bridge (split from boot.js at
 * the file-size gate, 2026-10-01; unchanged behavior).
 *
 * cordis logger records ride the unified sink as diagnostics (module prefix
 * distinguishes them from scenario events; they carry no scenario tag, so the
 * E2E checker's one-to-one match ignores them).
 *
 * These records are stripped under the logger's release policy, through the
 * SAME releaseKeeps() the forwarding console uses: a release build keeps the
 * critical set (mapped type → warn/error) and drops the debug/info stream.
 * Exported so the release-logging evidence can drive this route (the sink
 * probe wires it to a real cordis Context) without booting the whole spine.
 */
import { releaseKeeps } from 'logger.js';

/** Wire one context's logger exporter to the unified sink (boot.js calls
 * this right after the root Context exists). */
export const wireLogger = (ctx) => {
  ctx.logger.exporter({
    levels: { default: 4 },
    export: ({ name, type, args }) => {
      const level = type === 'success' || type === 'info' ? 'info' : type;
      if (!releaseKeeps(level)) return;
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
        level,
        module: `cordis:${name ?? 'root'}`,
        message: args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
        }).join(' '),
        data: [],
      }));
    },
  });
};
