// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/dsh-client-ui-renderer-client.js — the SlotRegistry face the
 * cordis-client-runner specs link (`import { SlotRegistry } from
 * "@deepseek-ai/dsh-client-ui-renderer/client"`). The vendored package's
 * ./client face is a BROWSER bundle (`window.__ModuleLoader__.load(...)`)
 * with no ESM exports to link — but SlotRegistry itself is a plain cordis
 * Service over the PURE SlotCore, and SlotCore's home package
 * (@deepseek-ai/dsh-client-ui-slots) IS a servable vendored ESM tree. The
 * registry class lives in slot-registry.js (mirrored from the vendored
 * bundle's registry region — same methods, same vendored core); this file
 * is the specifier's export face, served by shims/runtime-modules.js.
 */
export { SlotRegistry as default, SlotRegistry } from 'upstream/shims/slot-registry.js';
