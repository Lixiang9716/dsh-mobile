// dsh:logging-exempt (hilog here is drive/progress evidence only; canonical
// E2E lines route through the HostPhase phase sink — ONE writer)
/**
 * The BLE face (the system capability plane, grant family `ble`) — ArkTS
 * sibling of hosts/ios Gateway/BLEPrimitives.swift and the Android
 * BlePrimitives.kt family: eight primitives over one radio. BleMockRadio is
 * the deterministic CI-verifiable mock layer (a closed two-device GATT db
 * behind the SAME dispatch); BleSystemRadio maps @ohos.bluetooth.ble for
 * hardware — the emulator image has no radio, and its APIs answer error 801
 * (capability not supported) / 2900003 (disabled): those are honest
 * `unavailable` answers, never faked.
 *
 * Consent is TWO layers: the gateway grant first (the caller manifest's
 * family flag; a caller without it gets the SAME presenter presentApproval
 * uses — this host's presenter is approve/decline, so the grant is
 * session-scoped here; no standing "remember" exists on this host), the OS
 * ACCESS_BLUETOOTH grant second. The refusing layer rides the settled
 * error; this host carries no audit stream (the harmony posture — the
 * settled value is the record).
 *
 * Threading: every settle happens on an async completion (promise callback)
 * of the ArkTS main thread event loop — the ONE serial JS runtime thread
 * (ARCHITECTURE.md §6); never inside the dispatch call itself.
 */
import { ble, constant } from '@kit.ConnectivityKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { SettleFn } from './PickerPrimitives';

const TAG: string = 'dsh.app';

/** The host-side clamp every radio honors (named, never a silent
 * truncation — rule 5). */
function bleScanTimeoutClamp(ms: number): number {
  return Math.min(Math.max(ms, 100), 30000);
}

/** A radio refusal: "os" maps to `denied`, "unsupported" to `unavailable`. */
export class BleRadioRefusal {
  kind: string;
  reason: string;

  constructor(kind: string, reason: string) {
    this.kind = kind;
    this.reason = reason;
  }
}

/** One advertisement batch record (proposal §7 `kind: "device"` shape). */
export class BleRadioDevice {
  deviceId: string;
  name: string;
  rssi: number;
  serviceUuids: Array<string>;

  constructor(deviceId: string, name: string, rssi: number,
    serviceUuids: Array<string>) {
    this.deviceId = deviceId;
    this.name = name;
    this.rssi = rssi;
    this.serviceUuids = serviceUuids;
  }
}

interface ScanOutcome {
  scanId: string | null;
  refusal: BleRadioRefusal | null;
}

interface ConnectOutcome {
  connectionId: string | null;
  refusal: BleRadioRefusal | null;
}

interface BytesOutcome {
  bytes: Uint8Array | null;
  written: boolean | null;
  armed: boolean | null;
  refusal: BleRadioRefusal | null;
}

/** The radio contract both faces implement. */
interface BleRadioLike {
  deviceSink: ((device: BleRadioDevice) => void) | null;
  scanEndSink: ((scanId: string) => void) | null;
  consent(): BleRadioRefusal | null;
  scanStart(filter: Array<string>, timeoutMs: number,
    completion: (outcome: ScanOutcome) => void): void;
  scanStop(scanId: string): boolean;
  connect(deviceId: string, onDisconnect: (connectionId: string) => void,
    completion: (outcome: ConnectOutcome) => void): void;
  disconnect(connectionId: string): boolean;
  read(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void;
  write(connectionId: string, service: string, characteristic: string,
    data: Uint8Array, response: boolean,
    completion: (outcome: BytesOutcome) => void): void;
  subscribe(connectionId: string, service: string, characteristic: string,
    onNotify: (data: Uint8Array) => void,
    completion: (outcome: BytesOutcome) => void): void;
  unsubscribe(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void;
}

/** The deterministic mock radio: battery-like 180f/2a19 (read answers one
 * byte, notify capable) and the unassigned vendor-test write space
 * fe00/fe01. Two devices advertise per scan, in order; the "DSH Mock BLE"
 * name prefix is what the mock manifests pin, so evidence can never pass
 * against a radio that is not the named mock. */
export class BleMockRadio implements BleRadioLike {
  static readonly TUPLE_READ_SERVICE: string = '180f';
  static readonly TUPLE_READ_CHAR: string = '2a19';
  static readonly TUPLE_WRITE_SERVICE: string = 'fe00';
  static readonly TUPLE_WRITE_CHAR: string = 'fe01';

  private scanCounter: number = 0;
  private liveScans: Map<string, number> = new Map();
  private connections: Set<string> = new Set();
  private notifying: Set<string> = new Set();

  deviceSink: ((device: BleRadioDevice) => void) | null = null;
  scanEndSink: ((scanId: string) => void) | null = null;

  consent(): BleRadioRefusal | null {
    return null;
  }

  scanStart(filter: Array<string>, timeoutMs: number,
    completion: (outcome: ScanOutcome) => void): void {
    this.scanCounter += 1;
    const scanId: string = 'scan:mock-' + this.scanCounter.toString();
    this.liveScans.set(scanId, Date.now() + bleScanTimeoutClamp(timeoutMs));
    completion({ scanId: scanId, refusal: null });
    this.deliverBatch(scanId, filter, timeoutMs);
    setTimeout((): void => {
      if (this.liveScans.has(scanId)) {
        this.scanEndSink?.(scanId);
      }
    }, bleScanTimeoutClamp(timeoutMs));
  }

  /** The two-device batch, one bridge hop per advertisement (the
   * proposal's "one advertisement batch per event"), honoring the filter. */
  private deliverBatch(scanId: string, filter: Array<string>, timeoutMs: number): void {
    const first: BleRadioDevice = new BleRadioDevice(
      'device:mock-1', 'DSH Mock BLE Sensor', -42,
      [BleMockRadio.TUPLE_READ_SERVICE]);
    const second: BleRadioDevice = new BleRadioDevice(
      'device:mock-2', 'DSH Mock BLE Beacon', -66, []);
    const batch: Array<BleRadioDevice> = [first, second];
    batch.forEach((device: BleRadioDevice, index: number): void => {
      if (filter.length > 0) {
        const hit = device.serviceUuids.some((u: string): boolean =>
          filter.includes(u));
        if (!hit) {
          return;
        }
      }
      setTimeout((): void => {
        const expiry = this.liveScans.get(scanId);
        if (expiry !== undefined && Date.now() < expiry) {
          this.deviceSink?.(device);
        }
      }, 20 * (index + 1));
    });
    setTimeout((): void => {
      this.liveScans.delete(scanId);
    }, bleScanTimeoutClamp(timeoutMs));
  }

  scanStop(scanId: string): boolean {
    return this.liveScans.delete(scanId);
  }

  connect(deviceId: string, onDisconnect: (connectionId: string) => void,
    completion: (outcome: ConnectOutcome) => void): void {
    if (!deviceId.startsWith('device:mock-')) {
      completion({ connectionId: null, refusal: null }); // walked away
      return;
    }
    const connectionId: string = 'conn:' + deviceId;
    this.connections.add(connectionId);
    completion({ connectionId: connectionId, refusal: null });
  }

  disconnect(connectionId: string): boolean {
    return this.connections.delete(connectionId);
  }

  read(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void {
    if (!this.connections.has(connectionId)) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    if (service === BleMockRadio.TUPLE_READ_SERVICE
      && characteristic === BleMockRadio.TUPLE_READ_CHAR) {
      completion({ bytes: new Uint8Array([0x5a]), written: null, armed: null,
        refusal: null });
      return;
    }
    completion({ bytes: null, written: null, armed: null,
      refusal: BleMockRadio.noSuchTuple(service, characteristic) });
  }

  write(connectionId: string, service: string, characteristic: string,
    data: Uint8Array, response: boolean,
    completion: (outcome: BytesOutcome) => void): void {
    if (!this.connections.has(connectionId)) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    if (service === BleMockRadio.TUPLE_WRITE_SERVICE
      && characteristic === BleMockRadio.TUPLE_WRITE_CHAR) {
      completion({ bytes: null, written: true, armed: null, refusal: null });
      return;
    }
    completion({ bytes: null, written: null, armed: null,
      refusal: BleMockRadio.noSuchTuple(service, characteristic) });
  }

  subscribe(connectionId: string, service: string, characteristic: string,
    onNotify: (data: Uint8Array) => void,
    completion: (outcome: BytesOutcome) => void): void {
    if (!this.connections.has(connectionId)) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    if (service !== BleMockRadio.TUPLE_READ_SERVICE
      || characteristic !== BleMockRadio.TUPLE_READ_CHAR) {
      completion({ bytes: null, written: null, armed: null,
        refusal: BleMockRadio.noSuchTuple(service, characteristic) });
      return;
    }
    const key: string = connectionId + '|' + service + '|' + characteristic;
    this.notifying.add(key);
    completion({ bytes: null, written: null, armed: true, refusal: null });
    for (let seq = 1; seq <= 2; seq++) {
      const payload: Uint8Array = new Uint8Array([0x5a, seq]);
      setTimeout((): void => {
        if (this.notifying.has(key)) {
          onNotify(payload);
        }
      }, 30 * seq);
    }
  }

  unsubscribe(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void {
    this.notifying.delete(connectionId + '|' + service + '|' + characteristic);
    // the POST state (disarmed) — idempotent, never a lie about what changed
    completion({ bytes: null, written: null, armed: false, refusal: null });
  }

  private static noSuchTuple(service: string, characteristic: string):
    BleRadioRefusal {
    return new BleRadioRefusal('unsupported',
      'tuple (' + service + ',' + characteristic + ') is not in the mock GATT db');
  }
}

/** The @ohos.bluetooth.ble radio for hardware. The emulator image answers
 * error 801 (capability not supported) from the kit itself: mapped to the
 * honest `unavailable`. The OS consent check is the prompt-free
 * verifyAccessToken read; the runtime request fires on the first scan. */
export class BleSystemRadio implements BleRadioLike {
  private ctx: common.UIAbilityContext;
  private scanCounter: number = 0;
  private scanner: ble.BleScanner | null = null;
  private liveScan: string | null = null;
  private idsByOsDevice: Map<string, string> = new Map();
  private clients: Map<string, ble.GattClientDevice> = new Map();
  private connectionIds: Map<ble.GattClientDevice, string> = new Map();

  deviceSink: ((device: BleRadioDevice) => void) | null = null;
  scanEndSink: ((scanId: string) => void) | null = null;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  /** Prompt-free OS consent read. This SDK image exposes no synchronous
   * token check this host can call without a tokenId fetch round-trip, so
   * the verdict is granted-through and the OS layer surfaces from the kit's
   * own permission error (201) on the real call — mapError names it. */
  consent(): BleRadioRefusal | null {
    return null;
  }

  scanStart(filter: Array<string>, timeoutMs: number,
    completion: (outcome: ScanOutcome) => void): void {
    try {
      if (this.scanner === null) {
        this.scanner = ble.createBleScanner();
        ble.on('BLEDeviceFind', (results: Array<ble.ScanResult>) => {
          this.onDeviceFound(results);
        });
      }
    } catch (e) {
      const be = e as BusinessError;
      completion({ scanId: null, refusal: BleSystemRadio.mapError(be) });
      return;
    }
    this.scanCounter += 1;
    const scanId: string = 'scan:ble-' + this.scanCounter.toString();
    this.liveScan = scanId;
    const filters: Array<ble.ScanFilter> = filter.map((uuid: string): ble.ScanFilter => {
      const f: ble.ScanFilter = { serviceUuid: uuid };
      return f;
    });
    // @SuppressWarnings syscap
    this.scanner.startScan(filters).then((): void => {
      completion({ scanId: scanId, refusal: null });
      setTimeout((): void => {
        if (this.liveScan === scanId) {
          this.scanEndSink?.(scanId);
          this.scanStop(scanId);
        }
      }, bleScanTimeoutClamp(timeoutMs));
    }).catch((err: BusinessError): void => {
      this.liveScan = null;
      completion({ scanId: null, refusal: BleSystemRadio.mapError(err) });
    });
  }

  private onDeviceFound(results: Array<ble.ScanResult>): void {
    if (this.liveScan === null || this.deviceSink === null) {
      return;
    }
    results.forEach((r: ble.ScanResult): void => {
      const osId: string = r.deviceId;
      let id = this.idsByOsDevice.get(osId);
      if (id === undefined) {
        this.scanCounter += 1;
        id = 'device:ble-' + this.scanCounter.toString();
        this.idsByOsDevice.set(osId, id);
      }
      const uuids: Array<string> = r.serviceUuids ?? [];
      this.deviceSink?.(new BleRadioDevice(id, r.deviceName ?? '', r.rssi, uuids));
    });
  }

  scanStop(scanId: string): boolean {
    if (this.liveScan !== scanId) {
      return false;
    }
    this.liveScan = null;
    try {
      // @SuppressWarnings syscap
      this.scanner?.stopScan();
    } catch (e) {
      // the scan is over either way; the stop record says what it says
    }
    return true;
  }

  connect(deviceId: string, onDisconnect: (connectionId: string) => void,
    completion: (outcome: ConnectOutcome) => void): void {
    let osId: string | undefined;
    this.idsByOsDevice.forEach((token: string, os: string): void => {
      if (token === deviceId) {
        osId = os;
      }
    });
    if (osId === undefined) {
      completion({ connectionId: null, refusal: null }); // walked away
      return;
    }
    try {
      // @SuppressWarnings syscap
      const client: ble.GattClientDevice = ble.createGattClientDevice(osId!);
      const connectionId: string = 'conn:' + deviceId;
      // the contract's connect posture (proposal §6): the completion fires
      // once the GATT LINK is up AND the tuple space is readable — never on
      // the local request (the iOS/Android siblings settle the same way).
      // The parked map is static: the callback needs a type-stable home.
      client.on('BLEConnectionStateChange', (state: ble.BLEConnectionChangeState) => {
        const bound = this.connectionIds.get(client);
        if (bound === undefined) {
          return;
        }
        if (state.state === constant.ProfileConnectionState.STATE_CONNECTED) {
          // @SuppressWarnings syscap
          client.getServices().then((_services: Array<ble.GattService>): void => {
            BleSystemRadio.settleParked(client, connectionId);
          }).catch((_err: BusinessError): void => {
            BleSystemRadio.settleParked(client, null);
          });
        } else {
          this.clients.delete(bound);
          this.connectionIds.delete(client);
          BleSystemRadio.settleParked(client, null);
          onDisconnect(bound);
        }
      });
      client.connect();
      this.clients.set(connectionId, client);
      this.connectionIds.set(client, connectionId);
      BleSystemRadio.parkConnect(client, completion);
    } catch (e) {
      const be = e as BusinessError;
      completion({ connectionId: null, refusal: BleSystemRadio.mapError(be) });
    }
  }

  /** The connect completions parked until the link settles — static so the
   * connectionStateChange callback has a type-stable home. */
  static parkedConnects: Map<ble.GattClientDevice,
    (outcome: ConnectOutcome) => void> = new Map();

  static parkConnect(client: ble.GattClientDevice,
    completion: (outcome: ConnectOutcome) => void): void {
    BleSystemRadio.parkedConnects.set(client, completion);
  }

  static settleParked(client: ble.GattClientDevice, connectionId: string | null): void {
    const parked = BleSystemRadio.parkedConnects.get(client);
    if (parked === undefined) {
      return;
    }
    BleSystemRadio.parkedConnects.delete(client);
    if (connectionId !== null) {
      parked({ connectionId: connectionId, refusal: null });
    } else {
      parked({ connectionId: null,
        refusal: new BleRadioRefusal('unsupported', 'the GATT link did not come up') });
    }
  }

  disconnect(connectionId: string): boolean {
    const client = this.clients.get(connectionId);
    if (client === undefined) {
      return false;
    }
    this.clients.delete(connectionId);
    this.connectionIds.delete(client);
    try {
      client.disconnect();
      client.close();
    } catch (e) {
      // the link is gone either way
    }
    return true;
  }

  private clientOf(connectionId: string): ble.GattClientDevice | null {
    return this.clients.get(connectionId) ?? null;
  }

  read(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void {
    const client = this.clientOf(connectionId);
    if (client === null) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    BleSystemRadio.findChar(client, service, characteristic,
      (target: GattTarget): void => {
        // @SuppressWarnings syscap
        client.readCharacteristicValue(target.char)
          .then((value: ble.BLECharacteristic): void => {
            completion({ bytes: new Uint8Array(value.characteristicValue),
              written: null, armed: null, refusal: null });
          }).catch((err: BusinessError): void => {
            completion({ bytes: null, written: null, armed: null,
              refusal: BleSystemRadio.mapError(err) });
          });
      },
      (): void => {
        completion({ bytes: null, written: null, armed: null,
          refusal: BleSystemRadio.missingTuple(service, characteristic) });
      });
  }

  write(connectionId: string, service: string, characteristic: string,
    data: Uint8Array, response: boolean,
    completion: (outcome: BytesOutcome) => void): void {
    const client = this.clientOf(connectionId);
    if (client === null) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    BleSystemRadio.findChar(client, service, characteristic,
      (target: GattTarget): void => {
        const frame: ble.BLECharacteristic = {
          serviceUuid: target.char.serviceUuid,
          characteristicUuid: target.char.characteristicUuid,
          characteristicValue: data.buffer as ArrayBuffer,
          descriptors: target.char.descriptors,
        };
        // @SuppressWarnings syscap
        client.writeCharacteristicValue(frame,
          response ? ble.GattWriteType.WRITE : ble.GattWriteType.WRITE_NO_RESPONSE)
          .then((): void => {
            completion({ bytes: null, written: true, armed: null, refusal: null });
          }).catch((err: BusinessError): void => {
            completion({ bytes: null, written: null, armed: null,
              refusal: BleSystemRadio.mapError(err) });
          });
      },
      (): void => {
        completion({ bytes: null, written: null, armed: null,
          refusal: BleSystemRadio.missingTuple(service, characteristic) });
      });
  }

  subscribe(connectionId: string, service: string, characteristic: string,
    onNotify: (data: Uint8Array) => void,
    completion: (outcome: BytesOutcome) => void): void {
    const client = this.clientOf(connectionId);
    if (client === null) {
      completion({ bytes: null, written: null, armed: null,
        refusal: new BleRadioRefusal('unsupported', 'connection is not live') });
      return;
    }
    BleSystemRadio.findChar(client, service, characteristic,
      (target: GattTarget): void => {
        // @SuppressWarnings syscap
        client.on('BLECharacteristicChange', (value: ble.BLECharacteristic) => {
          onNotify(new Uint8Array(value.characteristicValue));
        });
        client.setCharacteristicChangeNotification(target.char, true)
          .then((): void => {
            completion({ bytes: null, written: null, armed: true, refusal: null });
          }).catch((err: BusinessError): void => {
            completion({ bytes: null, written: null, armed: null,
              refusal: BleSystemRadio.mapError(err) });
          });
      },
      (): void => {
        completion({ bytes: null, written: null, armed: null,
          refusal: BleSystemRadio.missingTuple(service, characteristic) });
      });
  }

  unsubscribe(connectionId: string, service: string, characteristic: string,
    completion: (outcome: BytesOutcome) => void): void {
    const client = this.clientOf(connectionId);
    if (client === undefined || client === null) {
      completion({ bytes: null, written: null, armed: false, refusal: null });
      return;
    }
    BleSystemRadio.findChar(client, service, characteristic,
      (target: GattTarget): void => {
        // @SuppressWarnings syscap
        client.setCharacteristicChangeNotification(target.char, false)
          .then((): void => {
            client.off('BLECharacteristicChange');
            completion({ bytes: null, written: null, armed: false, refusal: null });
          }).catch((err: BusinessError): void => {
            completion({ bytes: null, written: null, armed: false,
              refusal: BleSystemRadio.mapError(err) });
          });
      },
      (): void => {
        completion({ bytes: null, written: null, armed: false, refusal: null });
      });
  }

  /** Resolves the GATT tuple through the promise getServices and runs
   * exactly one of the callbacks (never hangs on a missing tuple). */
  private static findChar(client: ble.GattClientDevice, service: string,
    characteristic: string, onFound: (target: GattTarget) => void,
    onMissing: () => void): void {
    // @SuppressWarnings syscap
    client.getServices().then((services: Array<ble.GattService>): void => {
      for (const svc of services) {
        if (svc.serviceUuid.toLowerCase() !== service.toLowerCase()) {
          continue;
        }
        for (const ch of svc.characteristics) {
          if (ch.characteristicUuid.toLowerCase() === characteristic.toLowerCase()) {
            const target: GattTarget = { char: ch };
            onFound(target);
            return;
          }
        }
      }
      onMissing();
    }).catch((_e: BusinessError): void => {
      onMissing();
    });
  }

  private static missingTuple(service: string, characteristic: string):
    BleRadioRefusal {
    return new BleRadioRefusal('unsupported',
      'tuple (' + service + ',' + characteristic + ') was not discovered on this peer');
  }

  /** Kit errors → the honest refusal: 801 (capability) / 2900003 (disabled)
   * / 2900099-family are capability gaps; 201 is the OS layer refusing. */
  private static mapError(be: BusinessError): BleRadioRefusal {
    if (be.code === 201) {
      return new BleRadioRefusal('os',
        'bluetooth authorization refused by system policy (' + be.code + ')');
    }
    if (be.code === 801 || be.code === 2900003 || be.code === 2900001) {
      return new BleRadioRefusal('unsupported',
        'this device has no usable Bluetooth radio (' + be.code + ')');
    }
    return new BleRadioRefusal('unsupported',
      'the BLE call failed (' + be.code + ' ' + (be.message ?? '') + ')');
  }
}

interface GattTarget {
  char: ble.BLECharacteristic;
}

/** The gateway face: the eight BLE primitives, one dispatch method each,
 * two consent layers, emits for the ble.event channel. */
export class BlePrimitives {
  private ctx: common.UIAbilityContext;
  private radio: BleRadioLike;
  /** The staged caller manifest's required grants — the harmony gateway's
   * enforcement point is THIS layer (the C forward has no grant table), so
   * rule 1's "the gateway checks before dispatch" reads the manifest here:
   * the same staged manifest.json the iOS/Android cores parse. */
  private required: Set<string> = new Set<string>();
  /** The session-scoped gateway grant (dies with the session). */
  private sessionGrant: boolean = false;
  private presenter: ((title: string, onResult: (approved: boolean) => void) => void)
    | null = null;
  /** Wired by HostPhase: the event delivery seam (runtime queue hop). */
  emitFn: ((eventJson: string) => void) | null = null;
  private armedScans: Map<string, boolean> = new Map();

  constructor(ctx: common.UIAbilityContext, bundleRoot: string, mockRadio: boolean) {
    this.ctx = ctx;
    this.radio = mockRadio ? new BleMockRadio() : new BleSystemRadio(ctx);
    this.loadCallerGrants(bundleRoot);
    this.radio.deviceSink = (device: BleRadioDevice): void => this.deviceArrived(device);
    this.radio.scanEndSink = (scanId: string): void => this.scanEnded(scanId);
  }

  /** The caller manifest's required grants (family-flag grammar, the same
   * table the iOS/Android cores parse). A missing manifest fails LOUD
   * (rule 5) — a bundle without its permission record has no business
   * reaching the BLE rows. */
  private loadCallerGrants(bundleRoot: string): void {
    try {
      // @SuppressWarnings syscap
      const text: string = fileIo.readTextSync(bundleRoot + '/manifest.json');
      const parsed: Record<string, Object> =
        JSON.parse(text) as Record<string, Object>;
      const caps = parsed['capabilities'] as Record<string, Object>;
      const raw = caps['required'] as Array<string>;
      const familyFlags: Array<Array<string>> = [
        ['bleScanStart', 'ble'], ['bleScanStop', 'ble'],
        ['bleConnect', 'ble'], ['bleDisconnect', 'ble'],
        ['bleRead', 'ble'], ['bleWrite', 'ble'],
        ['bleSubscribe', 'ble'], ['bleUnsubscribe', 'ble'],
      ];
      raw.forEach((entry: string): void => {
        this.required.add(entry);
      });
      familyFlags.forEach((pair: Array<string>): void => {
        if (this.required.has(pair[1])) {
          this.required.add(pair[0]);
        }
      });
      hilog.info(0x0000, TAG, 'ble: caller grants loaded (%{public}d rows)',
        this.required.size.toString());
    } catch (e) {
      const be = e as BusinessError;
      hilog.error(0x0000, TAG, 'ble: caller manifest unreadable: %{public}s',
        be.message ?? 'unknown');
      throw new Error('ble: bundle_root/manifest.json missing or unparseable');
    }
  }

  setPresenter(presenter: (title: string, onResult: (approved: boolean) => void) => void):
    void {
    this.presenter = presenter;
  }

  private static reject(callId: number, settle: SettleFn, code: string,
    primitive: string, message: string): void {
    settle(callId,
      '{"code":"' + code + '","primitive":"' + primitive + '","message":"' +
      message + '"}', false);
  }

  /** The gateway consent layer, rule 1 first: the caller manifest's grant
   * (enforced HERE — the harmony gateway's ArkTS layer; the C forward has
   * no grant table), then the session grant from a prior prompt approval,
   * then the presenter prompt. Refusal settles `denied` (layer: gateway). */
  private ensureGrant(primitive: string, callId: number, settle: SettleFn,
    body: () => void): void {
    if (this.required.has(primitive)) {
      body();
      return;
    }
    if (this.sessionGrant) {
      body();
      return;
    }
    if (this.presenter === null) {
      BlePrimitives.reject(callId, settle, 'unavailable', primitive, 'no presenter');
      return;
    }
    hilog.info(0x0000, TAG, 'ui-wait ble-consent');
    const presenter = this.presenter;
    presenter('Allow Bluetooth access?', (approved: boolean): void => {
      hilog.info(0x0000, TAG, 'ui-done ble-consent approved=%{public}s',
        String(approved));
      if (!approved) {
        BlePrimitives.reject(callId, settle, 'denied', primitive,
          'the gateway consent layer refused');
        return;
      }
      this.sessionGrant = true;
      body();
    });
  }

  /** The OS consent + capability gate before every radio-touching call. */
  private ensureRadio(primitive: string, callId: number, settle: SettleFn,
    body: () => void): void {
    const refusal = this.radio.consent();
    if (refusal === null) {
      body();
      return;
    }
    if (refusal.kind === 'os') {
      BlePrimitives.reject(callId, settle, 'denied', primitive, refusal.reason);
      return;
    }
    BlePrimitives.reject(callId, settle, 'unavailable', primitive, refusal.reason);
  }

  /** The refusal tail shared by the three settles: the audit-free posture
   * still names the layer that refused, in the settled error itself. */
  private static refuseSettle(callId: number, settle: SettleFn, primitive: string,
    refusal: BleRadioRefusal): void {
    if (refusal.kind === 'os') {
      BlePrimitives.reject(callId, settle, 'denied', primitive, refusal.reason);
      return;
    }
    BlePrimitives.reject(callId, settle, 'unavailable', primitive, refusal.reason);
  }

  private settleScan(callId: number, settle: SettleFn, primitive: string,
    outcome: ScanOutcome): void {
    if (outcome.refusal !== null) {
      BlePrimitives.refuseSettle(callId, settle, primitive, outcome.refusal);
      return;
    }
    if (outcome.scanId === null) {
      BlePrimitives.reject(callId, settle, 'unavailable', primitive,
        'the scan never armed');
      return;
    }
    this.armedScans.set(outcome.scanId, true);
    settle(callId, '{"scanId":' + JSON.stringify(outcome.scanId) + '}', true);
  }

  private settleConnect(callId: number, settle: SettleFn, primitive: string,
    outcome: ConnectOutcome): void {
    if (outcome.refusal !== null) {
      BlePrimitives.refuseSettle(callId, settle, primitive, outcome.refusal);
      return;
    }
    if (outcome.connectionId === null) {
      settle(callId, 'null', true); // walked away: a value, not an error
      return;
    }
    settle(callId,
      '{"connectionId":' + JSON.stringify(outcome.connectionId) + '}', true);
  }

  private settleBytes(callId: number, settle: SettleFn, primitive: string,
    outcome: BytesOutcome): void {
    if (outcome.refusal !== null) {
      BlePrimitives.refuseSettle(callId, settle, primitive, outcome.refusal);
      return;
    }
    if (outcome.bytes !== null) {
      settle(callId,
        '{"bytesB64":' + JSON.stringify(BlePrimitives.toB64(outcome.bytes)) + '}',
        true);
      return;
    }
    if (outcome.written !== null) {
      settle(callId, '{"written":true}', true);
      return;
    }
    settle(callId, '{"subscribed":' + String(outcome.armed === true) + '}', true);
  }

  private static toB64(bytes: Uint8Array): string {
    const helper = new util.Base64Helper();
    return helper.encodeToStringSync(bytes);
  }

  scanStart(callId: number, argsText: string, settle: SettleFn): void {
    let filter: Array<string> = [];
    let timeoutMs = 5000;
    try {
      const args = JSON.parse(argsText) as Record<string, Object>;
      const raw = args['serviceUuids'];
      if (raw !== undefined && raw !== null) {
        filter = raw as Array<string>;
      }
      const t = args['timeoutMs'];
      if (typeof t === 'number') {
        timeoutMs = t;
      }
    } catch (e) {
      // defaults stand
    }
    this.ensureGrant('bleScanStart', callId, settle, (): void => {
      this.ensureRadio('bleScanStart', callId, settle, (): void => {
        this.radio.scanStart(filter, timeoutMs, (outcome: ScanOutcome): void => {
          this.settleScan(callId, settle, 'bleScanStart', outcome);
        });
      });
    });
  }

  scanStop(callId: number, argsText: string, settle: SettleFn): void {
    let scanId = '';
    try {
      const args = JSON.parse(argsText) as Record<string, string>;
      scanId = args['scanId'] ?? '';
    } catch (e) {
      scanId = '';
    }
    if (scanId.length === 0) {
      BlePrimitives.reject(callId, settle, 'invalid', 'bleScanStop', 'scanId missing');
      return;
    }
    const stopped = this.radio.scanStop(scanId);
    this.armedScans.delete(scanId);
    settle(callId, '{"stopped":' + String(stopped) + '}', true);
  }

  connect(callId: number, argsText: string, settle: SettleFn): void {
    let deviceId = '';
    try {
      const args = JSON.parse(argsText) as Record<string, string>;
      deviceId = args['deviceId'] ?? '';
    } catch (e) {
      deviceId = '';
    }
    if (deviceId.length === 0) {
      BlePrimitives.reject(callId, settle, 'invalid', 'bleConnect', 'deviceId missing');
      return;
    }
    this.ensureGrant('bleConnect', callId, settle, (): void => {
      this.ensureRadio('bleConnect', callId, settle, (): void => {
        this.radio.connect(deviceId, (dropped: string): void => {
          this.emitFn?.('{"event":"ble.event","kind":"disconnect","connectionId":'
            + JSON.stringify(dropped) + ',"reason":"link-lost"}');
        }, (outcome: ConnectOutcome): void => {
          this.settleConnect(callId, settle, 'bleConnect', outcome);
        });
      });
    });
  }

  disconnect(callId: number, argsText: string, settle: SettleFn): void {
    let connectionId = '';
    try {
      const args = JSON.parse(argsText) as Record<string, string>;
      connectionId = args['connectionId'] ?? '';
    } catch (e) {
      connectionId = '';
    }
    if (connectionId.length === 0) {
      BlePrimitives.reject(callId, settle, 'invalid', 'bleDisconnect',
        'connectionId missing');
      return;
    }
    const closed = this.radio.disconnect(connectionId);
    settle(callId, '{"closed":' + String(closed) + '}', true);
  }

  read(callId: number, argsText: string, settle: SettleFn): void {
    this.tupleCall('bleRead', callId, argsText, settle,
      (connectionId: string, service: string, characteristic: string): void => {
        this.radio.read(connectionId, service, characteristic,
          (outcome: BytesOutcome): void => {
            this.settleBytes(callId, settle, 'bleRead', outcome);
          });
      });
  }

  write(callId: number, argsText: string, settle: SettleFn): void {
    let data: Uint8Array | null = null;
    let response = true;
    try {
      const args = JSON.parse(argsText) as Record<string, Object>;
      const b64 = args['bytesB64'];
      if (typeof b64 === 'string' && b64.length > 0) {
        data = BlePrimitives.fromB64(b64);
      }
      const r = args['response'];
      if (typeof r === 'boolean') {
        response = r;
      }
    } catch (e) {
      data = null;
    }
    if (data === null) {
      BlePrimitives.reject(callId, settle, 'invalid', 'bleWrite',
        'bytesB64 missing or malformed');
      return;
    }
    const payload = data;
    this.tupleCall('bleWrite', callId, argsText, settle,
      (connectionId: string, service: string, characteristic: string): void => {
        this.radio.write(connectionId, service, characteristic, payload, response,
          (outcome: BytesOutcome): void => {
            this.settleBytes(callId, settle, 'bleWrite', outcome);
          });
      });
  }

  subscribe(callId: number, argsText: string, settle: SettleFn): void {
    this.tupleCall('bleSubscribe', callId, argsText, settle,
      (connectionId: string, service: string, characteristic: string): void => {
        this.radio.subscribe(connectionId, service, characteristic,
          (data: Uint8Array): void => {
            this.emitFn?.('{"event":"ble.event","kind":"notify","connectionId":'
              + JSON.stringify(connectionId) + ',"service":'
              + JSON.stringify(service) + ',"characteristic":'
              + JSON.stringify(characteristic) + ',"bytesB64":"'
              + BlePrimitives.toB64(data) + '"}');
          }, (outcome: BytesOutcome): void => {
            this.settleBytes(callId, settle, 'bleSubscribe', outcome);
          });
      });
  }

  unsubscribe(callId: number, argsText: string, settle: SettleFn): void {
    this.tupleCall('bleUnsubscribe', callId, argsText, settle,
      (connectionId: string, service: string, characteristic: string): void => {
        this.radio.unsubscribe(connectionId, service, characteristic,
          (outcome: BytesOutcome): void => {
            this.settleBytes(callId, settle, 'bleUnsubscribe', outcome);
          });
      });
  }

  /** The shared shape of the four GATT calls: validate the tuple, ride the
   * consent ladder, then run body with the parsed parts. */
  private tupleCall(primitive: string, callId: number, argsText: string,
    settle: SettleFn, body: (connectionId: string, service: string,
      characteristic: string) => void): void {
    let connectionId = '';
    let service = '';
    let characteristic = '';
    try {
      const args = JSON.parse(argsText) as Record<string, string>;
      connectionId = args['connectionId'] ?? '';
      service = args['service'] ?? '';
      characteristic = args['characteristic'] ?? '';
    } catch (e) {
      connectionId = '';
    }
    if (connectionId.length === 0 || service.length === 0
      || characteristic.length === 0) {
      BlePrimitives.reject(callId, settle, 'invalid', primitive,
        'connectionId, service and characteristic are required');
      return;
    }
    this.ensureGrant(primitive, callId, settle, (): void => {
      this.ensureRadio(primitive, callId, settle, (): void => {
        body(connectionId, service, characteristic);
      });
    });
  }

  private scanEnded(scanId: string): void {
    this.armedScans.delete(scanId);
    this.emitFn?.('{"event":"ble.event","kind":"scan-end","scanId":'
      + JSON.stringify(scanId) + '}');
  }

  private deviceArrived(device: BleRadioDevice): void {
    this.armedScans.forEach((_: boolean, scanId: string): void => {
      this.emitFn?.('{"event":"ble.event","scanId":' + JSON.stringify(scanId)
        + ',"kind":"device","deviceId":' + JSON.stringify(device.deviceId)
        + ',"name":' + JSON.stringify(device.name)
        + ',"rssi":' + device.rssi.toString()
        + ',"serviceUuids":' + JSON.stringify(device.serviceUuids) + '}');
    });
  }

  private static fromB64(text: string): Uint8Array {
    const helper = new util.Base64Helper();
    return helper.decodeSync(text);
  }
}
