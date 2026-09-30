import { describe, it, expect } from 'vitest';
import {
  PROVIDERS, PROVIDER_IDS, validateDraft, shouldShowPanel, statusLine,
  readableProbeError, probeLine, saveEnabled, draftFingerprint,
} from '../../presentation/web-client-next/web/js/onboarding-core.js';

const validDraft = () => ({
  provider: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-test-0001',
  model: 'deepseek-chat',
});

describe('provider presets', () => {
  it('offers DeepSeek first with its first-party endpoint + default model', () => {
    expect(PROVIDER_IDS[0]).toBe('deepseek');
    expect(PROVIDERS.deepseek.baseURL).toBe('https://api.deepseek.com');
    expect(PROVIDERS.deepseek.model).toBe('deepseek-chat');
  });

  it('offers the OpenAI-compatible custom row with empty fill-ins', () => {
    expect(PROVIDER_IDS).toContain('openai-compatible');
    expect(PROVIDERS['openai-compatible'].baseURL).toBe('');
    expect(PROVIDERS['openai-compatible'].model).toBe('');
  });
});

describe('validateDraft — the same grammar the runtime save leg enforces', () => {
  it('accepts the happy draft', () => {
    expect(validateDraft(validDraft())).toBeNull();
  });

  it('rejects an unknown provider', () => {
    const draft = { ...validDraft(), provider: 'anthropic?' };
    expect(validateDraft(draft)?.field).toBe('provider');
  });

  it('rejects a non-http(s) baseURL', () => {
    expect(validateDraft({ ...validDraft(), baseURL: 'ftp://x' })?.field).toBe('baseURL');
    expect(validateDraft({ ...validDraft(), baseURL: 'not a url' })?.field).toBe('baseURL');
    expect(validateDraft({ ...validDraft(), baseURL: '' })?.field).toBe('baseURL');
  });

  it('rejects blank and oversized keys', () => {
    expect(validateDraft({ ...validDraft(), apiKey: '   ' })?.field).toBe('apiKey');
    expect(validateDraft({ ...validDraft(), apiKey: 'k'.repeat(513) })?.field).toBe('apiKey');
  });

  it('rejects a missing model id', () => {
    expect(validateDraft({ ...validDraft(), model: '' })?.field).toBe('model');
  });
});

describe('shouldShowPanel — only the no-credential boot onboards', () => {
  it('shows for the mock route', () => {
    expect(shouldShowPanel({ mode: 'mock' })).toBe(true);
  });

  it('configured users go straight in', () => {
    expect(shouldShowPanel({ mode: 'byok', provider: 'deepseek' })).toBe(false);
    expect(shouldShowPanel({ mode: 'staged' })).toBe(false);
  });

  it('answers false for a missing status (fail-open to the session UI)', () => {
    expect(shouldShowPanel(undefined)).toBe(false);
  });
});

describe('statusLine — bilingual', () => {
  it('speaks both languages on every mode', () => {
    for (const status of [{ mode: 'mock' }, { mode: 'staged' }, { mode: 'byok', provider: 'deepseek' }]) {
      const line = statusLine(status);
      expect(line.en.length).toBeGreaterThan(0);
      expect(line.zh.length).toBeGreaterThan(0);
    }
  });
});

describe('readableProbeError — the wire failure to human words', () => {
  it('reads an auth rejection out of the transport message', () => {
    const line = readableProbeError({
      code: 'gateway/unavailable',
      message: 'chat/completions status 401: Authentication Fails',
    });
    expect(line.zh).toContain('401');
    expect(line.en).toContain('rejected');
  });

  it('reads a 404 as endpoint-or-model', () => {
    const line = readableProbeError({
      code: 'gateway/unavailable', message: 'chat/completions status 404: not found',
    });
    expect(line.zh).toContain('404');
  });

  it('reads a 5xx as the provider having a bad day', () => {
    const line = readableProbeError({
      code: 'gateway/unavailable', message: 'chat/completions status 503: overloaded',
    });
    expect(line.en).toContain('server error');
  });

  it('reads the CLI loopback-only fact instead of dressing it as a network outage', () => {
    const line = readableProbeError({
      code: 'gateway/unavailable',
      message: 'only http://127.0.0.1:PORT URLs are served by the CLI backend',
    });
    expect(line.en).toContain('loopback');
    expect(line.zh).toContain('loopback');
  });

  it('falls through with the wire message for unknown shapes', () => {
    const line = readableProbeError({ code: 'gateway/unknown', message: 'weird' });
    expect(line.en).toBe('weird');
  });
});

describe('probeLine — the streamed feedback sequence', () => {
  it('walks open → delta → done', () => {
    expect(probeLine({ kind: 'probe.open', status: 200 }).en).toContain('200');
    expect(probeLine({ kind: 'probe.delta', index: 1 }).en).toContain('token');
    expect(probeLine({ kind: 'probe.done', deltas: 3, chars: 17 }).zh).toContain('17');
  });

  it('answers null for unknown events (the line stays put)', () => {
    expect(probeLine({ kind: 'mystery' })).toBeNull();
  });
});

describe('saveEnabled + draftFingerprint — a stale pass never saves a changed draft', () => {
  it('enables only on a passed probe with an unchanged draft', () => {
    const draft = validDraft();
    const fp = draftFingerprint(draft);
    expect(saveEnabled(fp, fp, 'passed')).toBe(true);
    expect(saveEnabled(fp, fp, 'running')).toBe(false);
    expect(saveEnabled(fp, fp, 'failed')).toBe(false);
    const edited = draftFingerprint({ ...draft, apiKey: 'sk-other' });
    expect(saveEnabled(edited, fp, 'passed')).toBe(false);
  });

  it('the fingerprint hides the key value from any display use', () => {
    const fp = draftFingerprint(validDraft());
    expect(fp.includes('sk-test-0001')).toBe(false);
  });
});
