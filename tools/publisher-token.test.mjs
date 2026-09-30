// dsh:logging-exempt (test file: assertions ARE the product)
/**
 * publisher-token.test.mjs — the mock v1 publisher-token validator's own
 * net (tools/publisher-token.mjs, design doc: docs/marketplace-publisher-auth.md).
 *
 * Falsify-then-restore: this suite was written and run FIRST against a
 * deliberately rule-less stub (always `{ ok: true }`) — it went RED — and
 * only then against the real validator, which restored it to GREEN. The
 * counterexamples below are that falsification's permanent record: each
 * rule names the violation it catches, so a future edit that drops a rule
 * reopens a named failure instead of a silent pass (rules.md rule 6).
 *
 * Offline by construction: tokens are minted in-process with an HMAC
 * signer over a test secret; no network, no IdP, no publish API. Nothing
 * calls the validator (v1 groundwork only) — but the suite itself runs
 * continuously as a CI step (tools/test/run-tools-tests.sh in the gates
 * workflow), so a validator regression turns CI red (PR #285 review).
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  encodePublisherToken,
  hmacSigner,
  hmacVerifier,
  MAX_TTL_SECONDS,
  validatePublisherToken,
} from './publisher-token.mjs';

const SECRET = 'test-secret-never-a-real-credential';
const NOW = 1_800_000_000; // fixed instant: purity — no Date.now() in assertions
const verifier = hmacVerifier(SECRET);

/** A valid sample publisher token: every claim inside the rules. */
function sampleToken(overrides = {}, sign = hmacSigner(SECRET)) {
  const claims = {
    iss: 'https://idp.dsh.example',
    sub: 'publisher:acme',
    aud: 'dsh-marketplace-publish',
    scope: 'publish',
    iat: NOW - 60,
    exp: NOW + 3_600,
    jti: 'tok-sample-1',
    ...overrides,
  };
  return encodePublisherToken(claims, sign);
}

describe('validatePublisherToken — happy path', () => {
  it('accepts a well-formed, in-window, correctly signed token', () => {
    const r = validatePublisherToken(sampleToken(), { now: NOW, verifySignature: verifier });
    expect(r.ok).toBe(true);
    expect(r.claims.sub).toBe('publisher:acme');
    expect(r.claims.scope).toBe('publish');
  });
});

describe('validatePublisherToken — time rules (each rejects its named violation)', () => {
  it('rejects an expired token', () => {
    const t = sampleToken({ exp: NOW - 1 });
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'token expired' });
  });
  it('rejects a token issued in the future', () => {
    const t = sampleToken({ iat: NOW + 120 });
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'issued in the future' });
  });
  it('rejects a lifetime over the short-lived ceiling', () => {
    const t = sampleToken({ iat: NOW - 60, exp: NOW - 60 + MAX_TTL_SECONDS + 1 });
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'lifetime exceeds short-lived ceiling' });
  });
});

describe('validatePublisherToken — audience and scope rules', () => {
  it('rejects a token bound to another audience', () => {
    const t = sampleToken({ aud: 'some-other-service' });
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'audience mismatch' });
  });
  it('rejects a token without the publish scope', () => {
    const t = sampleToken({ scope: 'read' });
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'scope does not include publish' });
  });
  it('honors an explicit audience option', () => {
    const t = sampleToken({ aud: 'staging-publish' });
    const r = validatePublisherToken(t, {
      now: NOW,
      audience: 'staging-publish',
      verifySignature: verifier,
    });
    expect(r.ok).toBe(true);
  });
});

describe('validatePublisherToken — signature rule', () => {
  it('rejects a token signed under another secret', () => {
    const t = sampleToken({}, hmacSigner('attacker-secret'));
    const r = validatePublisherToken(t, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'bad signature' });
  });
  it('rejects tampered claims that keep the original signature', () => {
    const t = sampleToken();
    const [, payload, sig] = t.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.sub = 'publisher:evil';
    const forged = `dshpub-v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    const r = validatePublisherToken(forged, { now: NOW, verifySignature: verifier });
    expect(r).toEqual({ ok: false, reason: 'bad signature' });
  });
});

describe('validatePublisherToken — malformed envelopes and claims (fail loud, rule 5)', () => {
  const run = (t) => validatePublisherToken(t, { now: NOW, verifySignature: verifier });

  it('rejects non-string input', () => {
    expect(run(undefined)).toEqual({ ok: false, reason: 'malformed: token is not a string' });
  });
  it('rejects a wrong prefix', () => {
    expect(run('bearer-v9.a.b')).toEqual({ ok: false, reason: 'malformed envelope' });
  });
  it('rejects the wrong part count', () => {
    expect(run('dshpub-v1.a')).toEqual({ ok: false, reason: 'malformed envelope' });
    expect(run('dshpub-v1.a.b.c')).toEqual({ ok: false, reason: 'malformed envelope' });
  });
  it('rejects claims that are not JSON', () => {
    const bad = Buffer.from('not json').toString('base64url');
    expect(run(`dshpub-v1.${bad}.sig`)).toEqual({ ok: false, reason: 'malformed claims payload' });
  });
  it('rejects missing or wrongly-typed required claims', () => {
    for (const [key, value] of [
      ['iss', ''],
      ['sub', 'acme'], // wrong shape: must be publisher:<name>
      ['scope', ''],
      ['jti', ''],
      ['iat', 'yesterday'],
      ['exp', null],
    ]) {
      const claims = {
        iss: 'https://idp.dsh.example',
        sub: 'publisher:acme',
        aud: 'dsh-marketplace-publish',
        scope: 'publish',
        iat: NOW - 60,
        exp: NOW + 60,
        jti: 'tok-1',
        [key]: value,
      };
      const t = encodePublisherToken(claims, verifier);
      expect(run(t).ok).toBe(false);
    }
  });
  it('rejects a claims payload whose sub names no publisher', () => {
    const t = sampleToken({ sub: 'user:someone' });
    expect(run(t).ok).toBe(false);
  });
});
