import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, createPrivateKey, createHash } from 'node:crypto';
import { ed25519Verify, sha512Bytes, b64ToBytes, ed25519BaseEncoded } from 'ed25519.js';

// The oracle discipline (rule 6, IN THE TREE): the pure-JS verifier must
// agree with node:crypto/OpenSSL — an INDEPENDENT implementation — on valid
// signatures, and refuse every tamper class. The RFC 8032 §7.1 vectors are
// fixed data; the cross-check cases are freshly generated each run.

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const pkcs8 = (seed) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});

/** RFC 8032 §7.1 test 1 and test 2 — fixed vectors (their signatures were
 * reconfirmed against node:crypto/OpenSSL when this suite landed; OpenSSL is
 * the independent implementation, and the seed→sig leg is re-proven live in
 * the keygen-agreement test below). */
const RFC_VECTORS = [
  {
    name: 'test 1 (empty message)',
    pk: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    msg: '',
    sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
      + '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'test 2 (one byte 0x72)',
    pk: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    msg: '72',
    sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
      + '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
];

describe('RFC 8032 §7.1 vectors — fixed data', () => {
  for (const vector of RFC_VECTORS) {
    it(`${vector.name}: the signature verifies`, () => {
      expect(ed25519Verify(b64(vector.pk), Buffer.from(vector.msg, 'hex'), b64(vector.sig)))
        .toBe(true);
    });
    it(`${vector.name}: a flipped content bit refuses`, () => {
      const msg = Buffer.from(vector.msg === '' ? '00' : vector.msg, 'hex');
      msg[0] ^= 1;
      expect(ed25519Verify(b64(vector.pk), new Uint8Array(msg), b64(vector.sig))).toBe(false);
    });
    it(`${vector.name}: a flipped signature bit refuses`, () => {
      const sig = Buffer.from(vector.sig, 'hex');
      sig[10] ^= 0x08;
      expect(ed25519Verify(b64(vector.pk), Buffer.from(vector.msg, 'hex'), sig.toString('base64')))
        .toBe(false);
    });
    it(`${vector.name}: a flipped public-key bit refuses`, () => {
      const pk = Buffer.from(vector.pk, 'hex');
      pk[5] ^= 0x40;
      expect(ed25519Verify(pk.toString('base64'), Buffer.from(vector.msg, 'hex'), b64(vector.sig)))
        .toBe(false);
    });
  }
});

/** One cross-check case: node signs; the pure-JS verifier must accept the
 * honest signature and refuse the message/signature/key tamper. Returns the
 * four booleans; the caller asserts them. */
const crossCheckCase = (i) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const msg = Buffer.from(Array.from(
    { length: 1 + (i % 500) }, (_, j) => (i * 7 + j) % 251));
  const sig = sign(null, msg, privateKey);
  const jwk = publicKey.export({ type: 'spki', format: 'jwk' });
  const pkB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
  const good = ed25519Verify(pkB64, new Uint8Array(msg), sig.toString('base64'));
  const tamperedMsg = new Uint8Array(msg);
  tamperedMsg[i % tamperedMsg.length] ^= 1 << (i % 7);
  const refusedMsg = ed25519Verify(
    pkB64, tamperedMsg, sig.toString('base64')) === false;
  const sigBad = Buffer.from(sig);
  sigBad[i % 64] ^= 1 << (i % 7);
  const refusedSig = ed25519Verify(
    pkB64, new Uint8Array(msg), sigBad.toString('base64')) === false;
  const pkBad = Buffer.from(jwk.x, 'base64url');
  pkBad[9] ^= 0x10;
  const refusedPk = ed25519Verify(
    pkBad.toString('base64'), new Uint8Array(msg), sig.toString('base64')) === false;
  return { good, refusedMsg, refusedSig, refusedPk };
};

describe('cross-check vs node:crypto/OpenSSL — fresh signatures each run', () => {
  it('128 generated keypairs: valid accepts, every tamper class refuses', () => {
    let ok = 0;
    for (let i = 0; i < 128; i++) {
      const r = crossCheckCase(i);
      if (r.good && r.refusedMsg && r.refusedSig && r.refusedPk) ok++;
      else throw new Error(`case ${i}: ${JSON.stringify(r)}`);
    }
    expect(ok).toBe(128);
  });

  it('keygen agreement: OpenSSL signs under the RFC seed exactly as the vector records', () => {
    // The seed of RFC §7.1 test 2 (committed vector data) through OpenSSL's
    // signer must produce the committed signature — the two implementations
    // agree on the seed→(pk, sig) map end to end.
    const seed = Buffer.from('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex');
    const sig = sign(null, Buffer.from('72', 'hex'), pkcs8(seed));
    expect(sig.toString('hex')).toBe(RFC_VECTORS[1].sig);
    expect(ed25519Verify(b64(RFC_VECTORS[1].pk), Buffer.from('72', 'hex'), sig.toString('base64')))
      .toBe(true);
  });
});

describe('canonicality and malleability refusals', () => {
  it('s ≥ L (the malleability class) refuses — an all-ones scalar is far above L', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const msg = Buffer.from('malleability');
    const sig = Buffer.from(sign(null, msg, privateKey));
    const malleated = Buffer.concat([sig.subarray(0, 32), Buffer.alloc(32, 0xff)]);
    const jwk = publicKey.export({ type: 'spki', format: 'jwk' });
    const pkB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
    expect(ed25519Verify(pkB64, new Uint8Array(msg), malleated.toString('base64'))).toBe(false);
  });

  it('a signature scalar of exactly L refuses (s must be < L)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const msg = Buffer.from('scalar-is-the-order');
    const sig = Buffer.from(sign(null, msg, privateKey));
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const sL = Buffer.alloc(32);
    let v = L;
    for (let i = 0; i < 32; i++) { sL[i] = Number(v & 0xffn); v >>= 8n; }
    const malleated = Buffer.concat([sig.subarray(0, 32), sL]);
    const jwk = publicKey.export({ type: 'spki', format: 'jwk' });
    const pkB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
    expect(ed25519Verify(pkB64, new Uint8Array(msg), malleated.toString('base64'))).toBe(false);
  });
});

describe('encoding canonicality refusals', () => {
  it('non-canonical base64 (non-zero pad bits) refuses, never throws', () => {
    // The last data char of '…URo=' is 'o' (alphabet index 40): a 3-char
    // final group carries 18 bits for 2 bytes, so its low 2 bits are the
    // canonical zero pad. 'o'→'p' (index 41) makes the pad bits 01 —
    // RFC 4648 non-canonical, and a phantom byte the decoder must refuse.
    const flipped = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURp=';
    expect(() => b64ToBytes(flipped)).toThrow(/non-canonical/);
    expect(ed25519Verify(flipped, new Uint8Array(0), b64(RFC_VECTORS[0].sig))).toBe(false);
  });

  it('a y ≥ p encoding (non-canonical point) refuses', () => {
    const pk = Buffer.alloc(32, 0xff);
    pk[31] = 0x7f; // y = 2^255-1 ≥ p, sign bit 0
    expect(ed25519Verify(pk.toString('base64'), new Uint8Array([1]),
      b64(RFC_VECTORS[0].sig))).toBe(false);
  });

  it('sha512 matches node:crypto on a fixed input', () => {
    const abc = Buffer.from(sha512Bytes(new TextEncoder().encode('abc'))).toString('hex');
    expect(abc).toBe(createHash('sha512').update('abc').digest('hex'));
  });

  it('the base point encodes to the standard 5866…66 bytes', () => {
    const gy = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
    const enc = Buffer.from(ed25519BaseEncoded());
    const expected = Buffer.alloc(32);
    let v = gy;
    for (let i = 0; i < 32; i++) { expected[i] = Number(v & 0xffn); v >>= 8n; }
    expect(enc.equals(expected)).toBe(true);
  });
});
