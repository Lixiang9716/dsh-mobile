import { describe, expect, it } from 'vitest';
import {
  assertIntent, assertViewEvent, makeDelta, makeSettled, makeToolPhase,
} from '../shared/view-events.js';
import { createSurfaceCore } from '../shared/surface-core.js';
import { defineRenderSurfaceClient, dispatchIntent } from '../driver/render-surface-client.js';

describe('RenderSurfaceClient seam', () => {
  const full = () => ({
    mount: async () => {}, pushViewEvent: () => {},
    onIntent: () => {}, teardown: async () => {},
  });

  it('accepts a complete skin', () => {
    expect(defineRenderSurfaceClient(full())).toBeTruthy();
  });

  it.each(['mount', 'pushViewEvent', 'onIntent', 'teardown'])(
    'fails loud naming the missing %s', (method) => {
      const skin = full();
      delete skin[method];
      expect(() => defineRenderSurfaceClient(skin)).toThrow(method);
    },
  );

  it('dispatchIntent validates before crossing', () => {
    const seen = [];
    expect(() => dispatchIntent((i) => seen.push(i), { type: 'explode' })).toThrow(/intent type/);
    dispatchIntent((i) => seen.push(i), { type: 'cancel' });
    expect(seen).toEqual([{ type: 'cancel' }]);
  });
});

describe('view-event closed set', () => {
  it('throws on unknown types and kinds, naming the offender', () => {
    expect(() => assertViewEvent({ type: 'alien' })).toThrow(/view event type/);
    expect(() => makeDelta('sideways', { attemptId: 'a', turn: 1, step: 1 })).toThrow(/kind/);
    expect(() => makeToolPhase('sideways', { callId: 'c' })).toThrow(/phase/);
    expect(() => makeSettled('sideways', {})).toThrow(/kind/);
  });

  it('throws on payloads missing their kind-required fields', () => {
    expect(() => makeDelta('text', { attemptId: 'a', turn: 1, step: 1 })).toThrow(/text/);
    expect(() => makeToolPhase('waiting', { callId: 'c' })).toThrow(/name/);
    expect(() => makeSettled('user-message', {})).toThrow(/text/);
    expect(() => makeSettled('connection', { status: 'sideways' })).toThrow(/status/);
  });

  it('accepts the canonical vocabulary', () => {
    expect(makeDelta('text', { attemptId: 'a', turn: 1, step: 1, text: 'x' }).type)
      .toBe('message-delta');
    expect(makeToolPhase('ok', { callId: 'c', output: 'out' }).phase).toBe('ok');
    expect(makeSettled('seed-end', {}).kind).toBe('seed-end');
    expect(assertIntent({ type: 'select-session', sessionId: 's1' }).type)
      .toBe('select-session');
    expect(() => assertIntent({ type: 'submit', text: '   ' })).toThrow(/submit text/);
  });
});

describe('surface core (the bundle seam half)', () => {
  it('validates, folds, publishes, and notifies subscribers', () => {
    const core = createSurfaceCore();
    const seen = [];
    const unsubscribe = core.subscribe(() => seen.push(core.state()));
    core.pushViewEvent(makeSettled('seed-start', {}));
    core.pushViewEvent(makeSettled('user-message', { text: 'hello' }));
    expect(seen.length).toBe(2);
    expect(seen[1].items[0]).toMatchObject({ kind: 'user', text: 'hello' });
    unsubscribe();
    core.pushViewEvent(makeSettled('title', { title: 't' }));
    expect(seen.length).toBe(2); // no notification after unsubscribe
  });

  it('fails loud on unknown events and unset intent targets', () => {
    const core = createSurfaceCore();
    expect(() => core.pushViewEvent({ type: 'alien' })).toThrow(/view event type/);
    expect(() => core.emitIntent({ type: 'cancel' })).toThrow(/no intent target/);
    const crossed = [];
    core.setIntentTarget((intent) => crossed.push(intent));
    core.emitIntent({ type: 'submit', text: 'hi' });
    expect(crossed).toEqual([{ type: 'submit', text: 'hi' }]);
    expect(() => core.emitIntent({ type: 'alien' })).toThrow(/intent type/);
  });
});
