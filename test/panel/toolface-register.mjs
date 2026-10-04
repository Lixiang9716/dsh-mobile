// dsh:logging-exempt (test provisioning module)
/**
 * toolface-register.mjs — the `node --import` entry that registers the
 * loop-v2 tool-face loader hooks (see toolface-loader-hooks.mjs).
 */
import { register } from 'node:module';

register('./toolface-loader-hooks.mjs', import.meta.url);
