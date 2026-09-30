// tools/publisher-token.mjs — the MOCK v1 publisher-token validator.
//
// Groundwork for the marketplace's v1 publisher API (design doc:
// docs/marketplace-publisher-auth.md §3/§7): validates the short-lived,
// PAT-shaped bearer envelope `dshpub-v1.<claims-b64url>.<sig-b64url>`.
// PURE and OFFLINE by construction — claims parsing and rule judgment only;
// signature verification is an injected callback (hmacVerifier supplies a
// node:crypto HMAC for the mock). v0 wires NOTHING: no service, no network,
// no gate calls this. It exists so the v1 token model is executable design,
// with every rule owning a counterexample in publisher-token.test.mjs.
//
// Rules (each names its rejection — fail loud, rules.md rule 5):
//   F1  envelope: string, exactly three dot parts, prefix `dshpub-v1`
//   F2  claims: the middle part base64url-decodes to a JSON object
//   C1  required claims present and typed: iss (non-empty string),
//       sub (`publisher:<name>`), aud (string), scope (string),
//       iat/exp (finite numbers), jti (non-empty string)
//   C2  audience matches the expected one (option, default
//       `dsh-marketplace-publish`)
//   C3  scope includes `publish`
//   T1  iat <= now and exp > now (now is injected — purity over clocks)
//   T2  lifetime exp-iat <= MAX_TTL_SECONDS (8 h): a long-lived token is
//       rejected even if unexpired — the short-lived discipline is the
//       design, not a suggestion
//   S1  verifySignature(claimsB64, sigB64) === true
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'dshpub-v1';
export const DEFAULT_AUDIENCE = 'dsh-marketplace-publish';
export const MAX_TTL_SECONDS = 8 * 3600;
export const PUBLISH_SCOPE = 'publish';
const SUB_PATTERN = /^publisher:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Mint a mock token (test/tooling convenience — the real issuer is the IdP).
 * `sign` is a SIGNER (payload → signature), not a verifier predicate. */
export function encodePublisherToken(claims, sign) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${TOKEN_PREFIX}.${payload}.${sign(payload)}`;
}

/** Mint-side signer: payload → signature string (the IdP/publish-API role;
 * the real issuer signs with the IdP's key, never a shared HMAC). */
export function hmacSigner(secret) {
  return (payload) => createHmac('sha256', secret).update(payload).digest('base64url');
}

/** An injected S1 verifier: HMAC-SHA256 over a shared mock secret. Returns
 * a strict BOOLEAN (the S1 contract is `=== true` — a digest string would
 * fail it, which is exactly the bug the suite caught on restore day). */
export function hmacVerifier(secret) {
  return (payload, signature) => {
    if (typeof signature !== 'string') return false;
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  };
}

function parseEnvelope(token) {
  if (typeof token !== 'string') return { fail: 'malformed: token is not a string' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { fail: 'malformed envelope' };
  return { parts };
}

function parseClaims(payload) {
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
      return { fail: 'malformed claims payload' };
    }
    return { claims };
  } catch {
    return { fail: 'malformed claims payload' };
  }
}

const REQUIRED_STRINGS = ['iss', 'aud', 'scope', 'jti'];

function claimDefect(claims) {
  for (const key of REQUIRED_STRINGS) {
    if (typeof claims[key] !== 'string' || claims[key].length === 0) return `missing claim ${key}`;
  }
  if (!SUB_PATTERN.test(claims.sub)) return 'claim sub is not a publisher subject';
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return 'missing claim iat';
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return 'missing claim exp';
  return null;
}

/**
 * Validate one publisher token. Options: { now, audience?, verifySignature }.
 * Returns { ok: true, claims } or { ok: false, reason } — never throws on
 * bad input; a validator that throws on attacker bytes is its own vuln.
 */
export function validatePublisherToken(token, options) {
  const opts = options ?? {};
  const now = opts.now ?? Date.now();
  const audience = opts.audience ?? DEFAULT_AUDIENCE;
  const envelope = parseEnvelope(token);
  if (envelope.fail) return { ok: false, reason: envelope.fail };
  const [, payload, signature] = envelope.parts;
  if (typeof opts.verifySignature !== 'function') {
    return { ok: false, reason: 'no signature verifier supplied' };
  }
  const parsed = parseClaims(payload);
  if (parsed.fail) return { ok: false, reason: parsed.fail };
  const claims = parsed.claims;
  const defect = claimDefect(claims);
  if (defect) return { ok: false, reason: defect };
  if (claims.aud !== audience) return { ok: false, reason: 'audience mismatch' };
  if (!claims.scope.split(' ').includes(PUBLISH_SCOPE)) {
    return { ok: false, reason: 'scope does not include publish' };
  }
  if (claims.iat > now) return { ok: false, reason: 'issued in the future' };
  if (claims.exp <= now) return { ok: false, reason: 'token expired' };
  if (claims.exp - claims.iat > MAX_TTL_SECONDS) {
    return { ok: false, reason: 'lifetime exceeds short-lived ceiling' };
  }
  if (opts.verifySignature(payload, signature) !== true) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true, claims };
}
