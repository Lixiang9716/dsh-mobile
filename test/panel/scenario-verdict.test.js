import { describe, it, expect, vi } from 'vitest';
import { makeFailGate } from 'scenario/scenario-verdict.js';

// loop-x: #366 made the scenario's fail() first-only — the completed-fail
// verdict is sticky (js_complete keeps it in the host's error slot) and the
// embedder re-reports it on every later bus crossing, so a second emission
// only multiplied FAIL lines (the storm). The blind spot that gate bought:
// a suppressed fail whose message DIFFERS from the recorded verdict is a
// genuinely new failure class, invisible on every observable — the JS gate
// dropped it before __dshComplete, the seat's runtimeFailed gate would drop
// the re-report anyway, and the release strip (logging rule L4) removes
// debug/info. The gate now gives such a delta ONE release-visible line
// (log.warn — a level the strip keeps) while same-message repeats stay
// silent: the fail-then-throw double landing (demand's contract) carries ONE
// message and must stay one verdict.

const gate = () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const emit = vi.fn();
  const complete = vi.fn();
  return { log, emit, complete, fail: makeFailGate({ log, emit, complete }) };
};

describe('the fail gate records the first verdict unchanged (loop-x)', () => {
  it('an Error verdict rides the canonical record + complete(false) with the short stack', () => {
    const { log, emit, complete, fail } = gate();
    const boom = new Error('first failure');
    fail(boom);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]).toEqual([
      'scenario.failed',
      { reason: `first failure | ${boom.stack.split('\n').slice(0, 4).join(' / ')}` },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]).toEqual([false, emit.mock.calls[0][1].reason]);
  });

  it('a string verdict completes with the message verbatim (no stack to shorten)', () => {
    const { emit, complete, fail } = gate();
    fail('plain reason');
    expect(emit.mock.calls[0][1].reason).toBe('plain reason');
    expect(complete.mock.calls[0]).toEqual([false, 'plain reason']);
  });
});

describe('the fail gate keeps same-message repeats silent (loop-x)', () => {
  it('the demand double landing (string, then the thrown Error) stays one verdict', () => {
    const { log, emit, complete, fail } = gate();
    fail('demand reason');
    fail(new Error('demand reason')); // main().catch(fail) re-shape: SAME message
    fail('demand reason');
    expect(log.warn).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('the fail gate warns once for a NEW failure class (loop-x)', () => {
  it('a suppressed fail with a different message warns exactly once, completing nothing', () => {
    const { log, emit, complete, fail } = gate();
    fail('first failure');
    fail(new Error('a different, later defect'));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toBe('a suppressed fail names a new failure class');
    expect(log.warn.mock.calls[0][1]).toEqual({
      recorded: 'first failure',
      reason: 'a different, later defect',
    });
    // The verdict itself is terminal: no second completion, no second record.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('the same different message repeating stays silent (a warn, not a new storm)', () => {
    const { log, fail } = gate();
    fail('first failure');
    fail('later defect');
    fail('later defect');
    fail('later defect');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('each further distinct message warns once more', () => {
    const { log, fail } = gate();
    fail('first failure');
    fail('second class');
    fail('third class');
    fail('second class');
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls.map((c) => c[1].reason)).toEqual(['second class', 'third class']);
  });
});
