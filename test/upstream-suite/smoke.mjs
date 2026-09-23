#!/usr/bin/env node
// dsh:logging-exempt (diagnostic: stdout is the verdict)
/** smoke.mjs — run ONE transpiled spec through the quickjs-shaped harness
 * under Node (both hosts share the pipeline; this isolates harness bugs
 * from runtime gaps). usage: node smoke.mjs <spec.mjs> */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const ROOT = pathResolve(new URL('../..', import.meta.url).pathname);
register('./smoke-hooks.mjs', import.meta.url);

const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String(reason?.message ?? reason).slice(0, 200));
});
const spec = process.argv[2];
if (typeof spec !== 'string') {
  console.error('usage: smoke.mjs <spec path under runtime/spike/upstream-tests/>');
  process.exit(2);
}

const { runCollected } = await import(pathToFileURL(pathResolve(ROOT, 'runtime/spike/scenario/upstream-test-harness.js')));
try {
  await import(pathToFileURL(pathResolve(ROOT, 'runtime/spike/upstream-tests', spec)));
} catch (error) {
  console.log('harness smoke: MODULE-LEVEL FAILURE |', String(error?.message ?? error).slice(0, 300));
  console.log('  at', String(error?.stack ?? '').split('\n')[1]?.trim()?.slice(0, 160));
  process.exit(1);
}
const report = await runCollected(() => {});
console.log('harness smoke:', JSON.stringify({ passed: report.passed, failed: report.failed, skipped: report.skipped, unhandled: unhandled.length }));
for (const u of unhandled.slice(0, 3)) console.log('  UNHANDLED:', u);
for (const failure of report.failures.slice(0, 5)) {
  console.log(`  FAIL ${failure.name} | ${String(failure.message).slice(0, 160)}`);
  if (failure.stack) console.log(`    ${failure.stack.slice(0, 300)}`);
}
process.exit(report.failed > 0 ? 1 : 0);
