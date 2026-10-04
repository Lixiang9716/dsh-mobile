// dsh:logging-exempt (test double)
/**
 * toolface-gateway.js — the gateway double for the loop-v2 tool-face runner
 * (raw node loads the shim family natively, where a missing named export is
 * a link error — vite-node's SSR transform tolerates what this runner
 * cannot). Everything the panel suites know rides gateway-shim.js; the
 * socket faces node-socket-tcp imports answer inert (the tool-face scenario
 * never opens a socket).
 */
export * from './gateway-shim.js';

export const socketListen = async () => {
  throw new Error('toolface-gateway: socketListen is inert in the tool-face runner');
};
export const socketConnect = async () => {
  throw new Error('toolface-gateway: socketConnect is inert in the tool-face runner');
};
export const socketWrite = async () => {
  throw new Error('toolface-gateway: socketWrite is inert in the tool-face runner');
};
export const socketEnd = async () => {
  throw new Error('toolface-gateway: socketEnd is inert in the tool-face runner');
};
export const socketClose = async () => {};
