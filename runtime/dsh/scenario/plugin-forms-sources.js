/**
 * The workspace-plugin SOURCES the plugin.forms leg authors and mounts —
 * one module so the scenario file stays under the code-size cap and the
 * tutorial-verbatim shapes stay readable. NOTE the vendored cordis@4.0.2
 * effect semantics (lib/index.js _execute): the ctx.effect callback runs
 * IMMEDIATELY as setup and its RETURN VALUE is the disposer, so cleanups
 * are written `ctx.effect(() => () => …)`.
 */

export const HELLO_SOURCE = `
export const name = 'forms-hello';
export const inject = ['tools'];
export const apply = (ctx) => {
  globalThis.__formsProbe = { loaded: (globalThis.__formsProbe?.loaded ?? 0) + 1 };
  ctx.effect(() => () => {
    globalThis.__formsProbe = {
      ...globalThis.__formsProbe,
      disposed: (globalThis.__formsProbe?.disposed ?? 0) + 1,
    };
  });
};
`;

export const HELLO_EDITED = HELLO_SOURCE.replace("name = 'forms-hello'",
  "name = 'forms-hello-edited'");

export const FN_SOURCE = `
export default (ctx) => {
  globalThis.__formsFn = { loaded: true };
  ctx.effect(() => () => { globalThis.__formsFn = { loaded: false }; });
};
`;

export const BOOT_SOURCE = `
export const name = 'forms-boot';
export const apply = (ctx) => {
  globalThis.__formsBoot = { loaded: true };
};
`;

export const SERVICE_SOURCE = `
import { Service } from '@deepseek-ai/cordis';
export class FormsService extends Service {
  static inject = ['tools'];
  constructor(ctx) {
    super(ctx, 'formsService');
    globalThis.__formsService = { constructed: true };
  }
  beat() { return 'forms-service-beat'; }
}
`;

// ch.5 config: an exported Config schema (Schemastery — a Standard Schema
// validator) is applied by ctx.plugin itself; apply receives the validated
// config with defaults filled.
export const CONFIG_SOURCE = `
import Schema from '@deepseek-ai/schemastery';
export const name = 'forms-config';
export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
});
export const apply = (ctx, config) => {
  globalThis.__formsConfig = { greeting: config.greeting };
};
`;

// ch.4 events: broadcast, bail, serial, waterfall, parallel dispatch plus
// the prepend option; every ctx.on is an effect — unmount removes them.
export const EVENTS_SOURCE = `
export const name = 'forms-events';
export const apply = (ctx) => {
  globalThis.__formsEvents = { on: 0, bail: 0, wf: 0, par: 0 };
  ctx.on('forms/ping', () => { globalThis.__formsEvents.on += 1; });
  ctx.on('forms/check', (input) => (input === 'bad' ? 'blocked' : undefined));
  ctx.on('forms/transform', async (input, next) => (await next()) + '!');
  ctx.on('forms/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'serial-answer';
  });
  ctx.on('forms/parallel', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    globalThis.__formsEvents.par += 1;
  });
  ctx.on('forms/order', (_input, next) => next().then((v) => v + '-tail'));
  ctx.on('forms/order', (_input, next) => next().then((v) => 'head:' + v),
    { prepend: true });
};
`;

// basic/tool + ch.7: the tutorial's greet tool verbatim (defineTool from
// '@deepseek-ai/dsh-tools') + an INDEPENDENT observer over tools/result.
export const GREET_SOURCE = `
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'forms-greet';
export const inject = ['tools'];
export const apply = (ctx) => {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    async execute(args) { return \`Hello, \${args.name}!\`; },
  }));
  globalThis.__formsGreet = { registered: true };
};
`;

export const LOGGER_SOURCE = `
export const name = 'forms-logger';
export const inject = ['tools'];
export const apply = (ctx) => {
  globalThis.__formsLogger = { seen: [] };
  ctx.on('tools/result', (exec, result) => {
    globalThis.__formsLogger.seen.push({
      name: exec.name,
      text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    });
  });
};
`;

// cookbook/policy: the two policy faces — the extensible tools/pre-execute
// waterfall (a plugin MAY deny) and ctx.tools.guard (monotonic, cannot be
// force-allowed). Both are effects: unmount lifts the policy.
export const POLICY_SOURCE = `
export const name = 'forms-policy';
export const inject = ['tools'];
export const apply = (ctx) => {
  globalThis.__formsPolicy = { denied: 0, blocked: 0, rewritten: 0 };
  ctx.on('tools/pre-execute', (exec) => {
    if (exec.name === 'greet' && exec.arguments?.name === 'Villain') {
      globalThis.__formsPolicy.denied += 1;
      return { kind: 'deny', reason: 'the policy plugin refuses to greet Villain' };
    }
    return { kind: 'allow' };
  });
  // The THIRD waterfall (reference/tool-execution-pipeline): post-execute
  // may accept (replacing content), block with corrective feedback, or
  // attach additionalContexts.
  ctx.on('tools/post-execute', (exec, result) => {
    if (exec.name !== 'greet') return { kind: 'accept' };
    if (exec.arguments?.name === 'Blocked') {
      globalThis.__formsPolicy.blocked += 1;
      return { kind: 'block', feedback: [{ type: 'text', text: 'the policy blocks this greeting' }] };
    }
    if (exec.arguments?.name === 'Rewritten') {
      globalThis.__formsPolicy.rewritten += 1;
      // VALUE is authoritative: finalization re-renders content from the
      // canonical value, so a rewrite replaces the VALUE (content
      // replacement only survives on tools without a canonical value).
      return { kind: 'accept', value: '[redacted]' };
    }
    return { kind: 'accept' };
  });
};
`;

// ch.3 nested fibers + the provide face: the parent mounts a CHILD plugin
// through ctx.plugin (cordis disposes the child recursively with the
// parent) and exposes a plain value through ctx.provide.
export const NESTED_SOURCE = `
export const name = 'forms-nested';
export const apply = (ctx) => {
  globalThis.__formsNested = { parent: true, child: false };
  ctx.provide('formsProvided', { hello: () => 'provided' });
  const child = (childCtx) => {
    globalThis.__formsNested.child = true;
    childCtx.effect(() => () => { globalThis.__formsNested.child = false; });
  };
  ctx.plugin(child);
};
`;

// ch.3 dependency cascade: a consumer whose REQUIRED service is the
// Service-form provider. Unload the provider — cordis disposes the
// dependent; bring the provider back — the dependent reloads.
export const CUSTOMER_SOURCE = `
export const name = 'forms-customer';
export const inject = ['formsService'];
export const apply = (ctx) => {
  globalThis.__formsCustomer = { alive: true };
  ctx.effect(() => () => { globalThis.__formsCustomer = { alive: false }; });
};
`;

// ch.6 diagnosis: a required service NOBODY provides — the mount must
// refuse with the PENDING diagnosis instead of reporting a phantom mount.
export const PENDING_SOURCE = `
export const name = 'forms-pending';
export const inject = ['nonexistentService'];
export const apply = (ctx) => {
  globalThis.__formsPending = { loaded: true };
};
`;

// practice/llm-adapter: a workspace-authored LLM adapter — the tutorial's
// minimal stream() over the StreamChunk protocol, registered for its own
// provider through ctx.llm.registerAdapter (the registration is an effect:
// unmounting the plugin retires the provider).
export const LLM_SOURCE = `
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'forms-llm';
export const inject = ['llm'];
class FormsAdapter extends LlmAdapter {
  // The tutorial's minimal adapter: override stream() only — the base
  // class owns providerInfo/providerRetryPolicy/resolveModel/prepareCall.
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, delta: 'forms-llm-echo' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'forms-llm-echo' } };
    yield { type: 'usage', inputTokens: 1, outputTokens: 3 };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const apply = (ctx) => {
  ctx.llm.registerAdapter(['forms-provider'], new FormsAdapter());
  globalThis.__formsLlm = { registered: true };
};
`;

export const MANIFEST = (id) => ({
  schemaVersion: 1, type: 'service', id, version: '1.0.0',
  entry: 'index.js', capabilities: { required: [] },
});
