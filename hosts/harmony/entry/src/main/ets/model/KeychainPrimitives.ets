// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * KeychainPrimitives — keychainGet / keychainSet (contract/primitives.md §4)
 * over @ohos.security.huks. Platform sibling of hosts/android
 * .../KeychainPrimitives.kt (Android Keystore) and hosts/iOS
 * KeychainPrimitives.swift (SecItem): HUKS stores KEYS, not blobs, so a
 * secret is sealed with an AES-256-GCM key under the fixed alias
 * (generate-on-set on first use, load-on-get afterwards, never extractable)
 * and the sealed blob — 12-byte random nonce + ciphertext (the GCM tag
 * travels appended) — persists app-private at `<filesDir>/keychain/<sha256(ref)>`.
 * The opaque KeyRef never becomes a filename directly; an unset ref reads
 * null; `keychainSet(ref, null)` deletes; set on a missing ref adds, on an
 * existing ref overwrites (fresh nonce per set). Errors map to GatewayError
 * codes: malformed ref -> `invalid`, HUKS or file failures -> `io`.
 *
 * Threading: HUKS/Md promises complete on the ArkTS main thread event loop —
 * the ONE serial JS runtime thread (ARCHITECTURE.md §6); the call settles
 * from a later tick, never inside the dispatch callback.
 */
import { huks } from '@kit.UniversalKeystoreKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'dsh.app';
const MASTER_ALIAS: string = 'dsh-keychain-master';
const NONCE_LEN: number = 12;

/** (callId, payloadJson, ok) — HostPhase.settleCall's shape. */
export type SettleFn = (callId: number, payloadJson: string, ok: boolean) => void;

interface RefArgs {
  ref?: string;
  secretB64?: string | null;
}

function reject(callId: number, settle: SettleFn, code: string, primitive: string,
  message: string): void {
  settle(callId,
    '{"code":"' + code + '","primitive":"' + primitive + '","message":"' +
    message + '"}', false);
}

export class KeychainPrimitives {
  private dir: string;

  constructor(filesDir: string) {
    this.dir = filesDir + '/keychain';
    if (!fs.accessSync(this.dir)) {
      fs.mkdirSync(this.dir, true);
    }
  }

  /** keychainGet: unset ref -> null (a value); sealed blob -> decrypted bytes. */
  get(callId: number, argsText: string, settle: SettleFn): void {
    hilog.info(0x0000, TAG, 'keychainGet: call %{public}d', callId);
    let args: RefArgs = {};
    try {
      args = JSON.parse(argsText) as RefArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'keychainGet', 'malformed args');
      return;
    }
    if (args.ref === undefined || args.ref.length === 0) {
      reject(callId, settle, 'invalid', 'keychainGet', 'empty ref');
      return;
    }
    const file = this.fileFor(args.ref);
    const run = async (): Promise<void> => {
      hilog.info(0x0000, TAG, 'keychainGet: step fileFor');
      if (!fs.accessSync(file)) {
        settle(callId, 'null', true); // unset ref reads null
        return;
      }
      const blob = this.readBytes(file);
      hilog.info(0x0000, TAG, 'keychainGet: step read %{public}d', blob.length);
      const plain = await this.crypt(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT,
        blob.slice(0, NONCE_LEN), blob.slice(NONCE_LEN));
      hilog.info(0x0000, TAG, 'keychainGet: step crypt %{public}d', plain.length);
      const b64 = new util.Base64Helper().encodeToStringSync(plain);
      settle(callId, '{"secretB64":"' + b64 + '"}', true);
    };
    run().catch((err: Error): void => {
      const be = err as BusinessError;
      hilog.error(0x0000, TAG, 'keychainGet: failed code=%{public}d: %{public}s',
        be.code ?? -1, be.message ?? 'unknown');
      reject(callId, settle, 'io', 'keychainGet', be.message ?? 'decrypt failed');
    });
  }

  /** keychainSet: secret null deletes; otherwise seal-and-persist. */
  set(callId: number, argsText: string, settle: SettleFn): void {
    hilog.info(0x0000, TAG, 'keychainSet: call %{public}d', callId);
    let args: RefArgs = {};
    try {
      args = JSON.parse(argsText) as RefArgs;
    } catch (e) {
      reject(callId, settle, 'invalid', 'keychainSet', 'malformed args');
      return;
    }
    if (args.ref === undefined || args.ref.length === 0) {
      reject(callId, settle, 'invalid', 'keychainSet', 'empty ref');
      return;
    }
    const file = this.fileFor(args.ref);
    const run = async (): Promise<void> => {
      hilog.info(0x0000, TAG, 'keychainSet: step fileFor');
      if (args.secretB64 === null || args.secretB64 === undefined) {
        if (fs.accessSync(file)) {
          fs.unlinkSync(file); // keychainSet(ref, null) deletes
        }
        settle(callId, '{}', true);
        return;
      }
      const decoder = new util.Base64Helper();
      const secret = decoder.decodeSync(args.secretB64);
      hilog.info(0x0000, TAG, 'keychainSet: step secret %{public}d', secret.length);
      const nonce = cryptoFramework.createRandom()
        .generateRandomSync(NONCE_LEN).data as Uint8Array;
      hilog.info(0x0000, TAG, 'keychainSet: step nonce');
      const cipher = await this.crypt(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT,
        nonce, secret);
      hilog.info(0x0000, TAG, 'keychainSet: step cipher %{public}d', cipher.length);
      const blob = new Uint8Array(NONCE_LEN + cipher.length);
      blob.set(nonce, 0);
      blob.set(cipher, NONCE_LEN);
      const out = fs.openSync(file,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(out.fd, blob.buffer as object as ArrayBuffer);
      fs.closeSync(out.fd);
      hilog.info(0x0000, TAG, 'keychainSet: step stored');
      settle(callId, '{}', true);
    };
    run().catch((err: Error): void => {
      const be = err as BusinessError;
      hilog.error(0x0000, TAG, 'keychainSet: failed code=%{public}d: %{public}s',
        be.code ?? -1, be.message ?? 'unknown');
      reject(callId, settle, 'io', 'keychainSet', be.message ?? 'encrypt failed');
    });
  }

  /** Opaque ref -> app-private filename: sha256 hex, never the ref itself. */
  private fileFor(ref: string): string {
    return this.dir + '/' + this.sha256HexSync(ref);
  }

  private readBytes(path: string): Uint8Array {
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      const size = fs.statSync(file.fd).size;
      const buf = new ArrayBuffer(size);
      fs.readSync(file.fd, buf);
      return new Uint8Array(buf);
    } finally {
      fs.closeSync(file.fd);
    }
  }

  /** sha256 of a UTF-8 string, hex — via cryptoFramework Md (sync-free wrapper
   * over the promise API; runs on the main event loop). */
  private sha256HexSync(text: string): string {
    hilog.info(0x0000, TAG, 'keychainSet: step md create');
    const md = cryptoFramework.createMd('SHA256');
    const encoder = util.TextEncoder.create('utf-8');
    // updateSync/digestSync exist on API 12+; fall back to nothing — the sync
    // surface is the documented one for small inputs.
    md.updateSync({ data: encoder.encodeInto(text) });
    const digest = md.digestSync().data as Uint8Array;
    hilog.info(0x0000, TAG, 'keychainSet: step md done');
    let hex = '';
    for (let i = 0; i < digest.length; i++) {
      hex += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
    }
    return hex;
  }

  /** One HUKS AES-256-GCM session: ensure the fixed-alias key (generate on
   * set, plain load on get), init with purpose+nonce, finish over inData.
   * ENCRYPT takes the plaintext and yields ciphertext with the 128-bit GCM
   * tag appended (HUKS convention); DECRYPT takes that blob back and splits
   * the tag off — HUKS wants it via HUKS_TAG_AE_TAG, the body as inData. */
  private async crypt(purpose: huks.HuksKeyPurpose, nonce: Uint8Array,
    inData: Uint8Array): Promise<Uint8Array> {
    await this.ensureMasterKey();
    const properties: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
        value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
        value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE,
        value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_PADDING,
        value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_NONCE, value: nonce },
    ];
    let body = inData;
    const TAG_LEN = 16;
    if (purpose === huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT) {
      if (inData.length <= TAG_LEN) {
        throw new Error('sealed blob too short');
      }
      body = inData.slice(0, inData.length - TAG_LEN);
      properties.push({ tag: huks.HuksTag.HUKS_TAG_AE_TAG,
        value: inData.slice(inData.length - TAG_LEN) });
    }
    const initOpts: huks.HuksOptions = { properties: properties };
    const session = await huks.initSession(MASTER_ALIAS, initOpts);
    hilog.info(0x0000, TAG, 'keychainSet: step init ok');
    const finishOpts: huks.HuksOptions = { inData: body };
    const result = await huks.finishSession(session.handle, finishOpts);
    hilog.info(0x0000, TAG, 'keychainSet: step finish ok');
    const out = result.outData;
    if (out === undefined) {
      throw new Error('huks produced no output');
    }
    return out;
  }

  private async ensureMasterKey(): Promise<void> {
    // on this image isKeyItemExist THROWS "The entity does not exist." for
    // a not-yet-generated key instead of resolving false — treat that as
    // the false answer, and let anything else fail loud
    let exists = false;
    try {
      exists = await huks.isKeyItemExist(MASTER_ALIAS, { properties: [] });
      hilog.info(0x0000, TAG, 'keychainSet: step isKey exist=%{public}s', String(exists));
    } catch (e) {
      const be = e as BusinessError;
      hilog.error(0x0000, TAG, 'keychainSet: isKey threw code=%{public}d: %{public}s',
        be.code, be.message ?? '');
      if (be.code !== 12000011) {
        throw e as Error;
      }
    }
    if (exists) {
      return;
    }
    const genOpts: huks.HuksOptions = {
      properties: [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
          value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
          value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE,
          value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT |
            huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE,
          value: huks.HuksCipherMode.HUKS_MODE_GCM },
        { tag: huks.HuksTag.HUKS_TAG_PADDING,
          value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      ],
    };
    await huks.generateKeyItem(MASTER_ALIAS, genOpts);
    hilog.info(0x0000, TAG, 'keychainSet: step generate ok');
  }
}
