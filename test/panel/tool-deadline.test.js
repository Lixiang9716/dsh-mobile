import { describe, it, expect } from 'vitest';
import {
  makeToolsExecuteListener, deadlineResult, parseBudgetMs,
  DEFAULT_BUDGET_MS, TIMEOUT_CODE,
} from '../../runtime/dsh/upstream/tool-deadline.js';

/** The #323 spinner, modeled in JS: a tool body that NEVER resolves and
 * chews the event loop in synchronous slices (the JS-observable shape of the
 * device hang — CPU pinned, no settle). It honours the fused exec signal
 * (abandoning the loop when the deadline aborts it) and then stays pending
 * forever, exactly like a wedged body the runtime can no longer observe. */
let bodySawSignal;
const spinNext = async (exec) => {
  bodySawSignal = exec.signal; // what the body actually dispatches under
  while (!exec.signal.aborted) {
    const sliceEnd = Date.now() + 10; // one synchronous spin slice
    while (Date.now() < sliceEnd) { /* spin */ }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise(() => {}); // never resolves — the wedge
};

/** One spin-tool dispatch through the guard: `{ result, elapsed, exec }`. */
const runSpinTool = async (budgetMs) => {
  const listener = makeToolsExecuteListener(budgetMs);
  const exec = { name: 'spin', signal: new AbortController().signal };
  const started = Date.now();
  const result = await listener(exec, () => spinNext(exec));
  return { result, elapsed: Date.now() - started, exec };
};

describe('tool deadline: the #323 spin fails in-band', () => {
  it('a never-resolving, synchronously-spinning tool fails in-band, never wedges', async () => {
    const { result } = await runSpinTool(150);
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error: tool "spin"');
  }, 20_000);

  it('the failure names the budget, the tool, and the timeout code', async () => {
    const { result } = await runSpinTool(150);
    expect(result.error.info).toEqual({
      code: TIMEOUT_CODE, tool: 'spin', timeoutMs: 150,
    });
  }, 20_000);

  it('the deadline, not the spin, decides when the call returns', async () => {
    const { elapsed } = await runSpinTool(150);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);
});

describe('tool deadline: signal fusion and pass-through', () => {
  it('the body dispatched under the fused abort signal; the wrapper signal is restored', async () => {
    const { exec } = await runSpinTool(150);
    expect(bodySawSignal).not.toBe(exec.signal); // the budget rode a new signal
    expect(bodySawSignal.aborted).toBe(true);    // the body was told to stop
    expect(exec.signal.aborted).toBe(false);     // the wrapper signal restored
  }, 20_000);

  it('passes a fast tool result through untouched and restores the wrapper signal', async () => {
    const listener = makeToolsExecuteListener(1_000);
    const wrapperSignal = new AbortController().signal;
    const exec = { name: 'fast', signal: wrapperSignal };
    const payload = { content: [{ type: 'text', text: 'ok' }], isError: false };
    const result = await listener(exec, async () => {
      expect(exec.signal).not.toBe(wrapperSignal); // the budget is fused in
      expect(exec.signal.aborted).toBe(false);
      return payload;
    });
    expect(result).toBe(payload);
    expect(exec.signal).toBe(wrapperSignal); // restored in the listener's finally
  });

  it('lets a body rejection propagate (the registry owns tool-error shaping)', async () => {
    const listener = makeToolsExecuteListener(1_000);
    const exec = { name: 'throws', signal: new AbortController().signal };
    await expect(listener(exec, async () => {
      throw new Error('body failed honestly');
    })).rejects.toThrow('body failed honestly');
  });

  it('does not treat an upstream cancellation as a deadline', async () => {
    const listener = makeToolsExecuteListener(5_000);
    const upstream = new AbortController();
    const exec = { name: 'cancelled', signal: upstream.signal };
    // the wrapper signal aborts with a NON-timeout reason: the listener must
    // keep waiting on the body (the registry's own cancellation semantics),
    // never mint a fake timeout result
    const pending = listener(exec, async () => {
      while (!upstream.signal.aborted) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { isError: true, error: { message: 'aborted body' } };
    });
    upstream.abort(new Error('caller gave up'));
    expect(await pending).toEqual({ isError: true, error: { message: 'aborted body' } });
    expect(exec.signal).toBe(upstream.signal); // restored, still the wrapper's
  });
});

describe('tool deadline: shapes and validation', () => {
  it('shapes the deadline result for the model and the journal', () => {
    const result = deadlineResult('str_replace_editor', 120_000);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('str_replace_editor');
    expect(result.content[0].text).toContain(TIMEOUT_CODE);
    expect(result.error.info).toEqual({
      code: TIMEOUT_CODE, tool: 'str_replace_editor', timeoutMs: 120_000,
    });
  });

  it('validates the budget fail-loud and defaults sanely (rule 5)', () => {
    expect(DEFAULT_BUDGET_MS).toBe(120_000);
    expect(parseBudgetMs(undefined)).toBe(DEFAULT_BUDGET_MS);
    expect(parseBudgetMs(500)).toBe(500);
    for (const bad of [0, -1, NaN, Infinity, '120000', null, {}]) {
      expect(() => parseBudgetMs(bad)).toThrow('budgetMs must be a positive finite number');
    }
  });
});
