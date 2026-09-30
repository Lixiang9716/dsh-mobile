package com.dshmobile.spike

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid

/**
 * The android.bluetooth.le radio behind the BLE primitives (API 31+ runtime
 * permissions per the proposal's appendix; the legacy ≤30 rows stay in the
 * manifest for the deployment floor). The adapter is read lazily — an
 * emulator without a radio answers `unavailable` honestly; a permission the
 * OS refused surfaces as `OsDenied` (the audit names the layer).
 *
 * Device and connection ids are opaque host-minted tokens keyed to the
 * framework objects — a caller never sees a MAC address. GATT waits are one
 * in-flight call per connection (the JS caller is serial, D2).
 */
class SystemBleRadio(private val context: Context) : BleRadio {

    companion object {
        private fun stateFailure(state: Int): BleRadioFailure = when (state) {
            BluetoothProfile.STATE_DISCONNECTED ->
                BleRadioFailure.Unsupported("the GATT link is not connected")
            else -> BleRadioFailure.Unsupported("the GATT link is not ready ($state)")
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val manager: BluetoothManager? by lazy {
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    }
    private val adapter: BluetoothAdapter? get() = manager?.adapter

    override var deviceSink: ((BleRadioDevice) -> Unit)? = null

    override var scanEndSink: ((String) -> Unit)? = null

    private val liveScans = HashMap<String, Runnable>()
    private val devicesById = HashMap<String, android.bluetooth.BluetoothDevice>()
    private val idsByDevice = HashMap<android.bluetooth.BluetoothDevice, String>()
    private val connections = HashMap<String, BluetoothGatt>()
    private val idsByGatt = HashMap<BluetoothGatt, String>()
    private val connectWaiters = HashMap<BluetoothGatt, (BleResult<String?>) -> Unit>()
    private val dropHandlers = HashMap<BluetoothGatt, (String) -> Unit>()
    private val readWaiters = HashMap<String, (BleResult<ByteArray>) -> Unit>()
    private val writeWaiters = HashMap<String, (BleResult<Boolean>) -> Unit>()
    private val subscribeWaiters = HashMap<String, (BleResult<Boolean>) -> Unit>()
    private val unsubscribeWaiters = HashMap<String, (BleResult<Boolean>) -> Unit>()
    private val notifyHandlers = HashMap<String, (ByteArray) -> Unit>()
    private var nextId = 0

    /** The OS consent verdict — a PROMPT-FREE check in the proposal's own
     * order: a missing radio is `unavailable` FIRST (a capability gap the
     * emulator honestly answers — prompting for what cannot be served is
     * bad UX), the OS permission layer second (the runtime request itself
     * fires on the first radio-touching call of the D-g leg). */
    override fun consent(): BleRadioFailure? {
        val bluetooth = adapter ?: return BleRadioFailure.Unsupported(
            "this device has no Bluetooth radio (an emulator)")
        val powered = try {
            bluetooth.isEnabled
        } catch (e: SecurityException) {
            false
        }
        if (!powered) {
            return BleRadioFailure.Unsupported(
                "the Bluetooth radio is absent or powered off on this device")
        }
        val needed = if (Build.VERSION.SDK_INT >= 31) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            arrayOf(Manifest.permission.BLUETOOTH)
        }
        val missing = needed.count {
            context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        return if (missing > 0) {
            BleRadioFailure.OsDenied("bluetooth runtime permissions not granted ($missing)")
        } else {
            null
        }
    }

    private fun mint(prefix: String): String {
        nextId += 1
        return "$prefix:ble-$nextId"
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val deviceId = idsByDevice[device] ?: mint("device").also {
                idsByDevice[device] = it
                devicesById[it] = device
            }
            val uuids = result.scanRecord?.serviceUuids
                ?.mapNotNull { it?.uuid?.toString()?.lowercase() } ?: emptyList()
            deviceSink?.invoke(BleRadioDevice(
                deviceId,
                result.scanRecord?.deviceName ?: device.name,
                result.rssi,
                uuids,
            ))
        }

        override fun onScanFailed(errorCode: Int) {
            // the scan dies on its own: drop every armed scanId (the stop
            // record then honestly reports stopped=false)
            liveScans.clear()
        }
    }

    override fun scanStart(
        filter: List<String>, timeoutMs: Int,
        completion: (BleResult<String>) -> Unit,
    ) {
        val refusal = consent()
        if (refusal != null) {
            completion(BleResult.err(refusal))
            return
        }
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) {
            completion(BleResult.err(BleRadioFailure.Unsupported(
                "the BLE scanner is unavailable on this radio")))
            return
        }
        val scanId = mint("scan")
        val end = Runnable { liveScans.remove(scanId) }
        liveScans[scanId] = end
        val scanFilters = filter.map { uuid ->
            ScanFilter.Builder()
                .setServiceUuid(ParcelUuid.fromString(uuid))
                .build()
        }
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            scanner.startScan(scanFilters, settings, scanCallback)
            completion(BleResult.ok(scanId))
            handler.postDelayed({
                if (liveScans.containsKey(scanId)) scanEndSink?.invoke(scanId)
            }, bleScanTimeoutClamp(timeoutMs).toLong())
            handler.postDelayed(end, bleScanTimeoutClamp(timeoutMs).toLong())
        } catch (e: SecurityException) {
            liveScans.remove(scanId)
            completion(BleResult.err(BleRadioFailure.OsDenied(
                "bluetooth runtime permissions not granted (${e.message})")))
        }
    }

    override fun scanStop(scanId: String): Boolean {
        val end = liveScans.remove(scanId) ?: return false
        handler.removeCallbacks(end)
        val scanner = adapter?.bluetoothLeScanner ?: return true
        return try {
            scanner.stopScan(scanCallback)
            true
        } catch (e: SecurityException) {
            true // the scan is over either way; the stop record says stopped
        }
    }

    override fun connect(
        deviceId: String,
        onDisconnect: (String) -> Unit,
        completion: (BleResult<String?>) -> Unit,
    ) {
        val refusal = consent()
        if (refusal != null) {
            completion(BleResult.err(refusal))
            return
        }
        val device = devicesById[deviceId]
        if (device == null) {
            completion(BleResult.ok(null)) // walked away: a value, not an error
            return
        }
        val connectionId = mint("conn")
        try {
            val gatt = device.connectGatt(
                context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            if (gatt == null) {
                completion(BleResult.ok(null))
                return
            }
            connections[connectionId] = gatt
            idsByGatt[gatt] = connectionId
            connectWaiters[gatt] = completion
            dropHandlers[gatt] = onDisconnect
        } catch (e: SecurityException) {
            completion(BleResult.err(BleRadioFailure.OsDenied(
                "bluetooth runtime permissions not granted (${e.message})")))
        }
    }

    override fun disconnect(connectionId: String): Boolean {
        val gatt = connections.remove(connectionId) ?: return false
        idsByGatt.remove(gatt)
        return try {
            gatt.disconnect()
            gatt.close()
            true
        } catch (e: SecurityException) {
            true
        }
    }

    private fun gattOf(
        connectionId: String,
    ): BluetoothGatt? = connections[connectionId]

    private fun failAll(connectionId: String, failure: BleRadioFailure) {
        readWaiters.remove(connectionId)?.invoke(BleResult.err(failure))
        writeWaiters.remove(connectionId)?.invoke(BleResult.err(failure))
        subscribeWaiters.remove(connectionId)?.invoke(BleResult.err(failure))
        unsubscribeWaiters.remove(connectionId)?.invoke(BleResult.err(failure))
    }

    /** Resolves the GATT tuple on a LIVE connection and runs body, or fails
     * the connection's in-flight waiters (never hangs on a missing tuple). */
    private fun withCharacteristic(
        connectionId: String, service: String, characteristic: String,
        body: (BluetoothGatt, BluetoothGattCharacteristic) -> Unit,
    ) {
        handler.post {
            val gatt = gattOf(connectionId)
            if (gatt == null) {
                failAll(connectionId, BleRadioFailure.Unsupported("connection is not live"))
                return@post
            }
            val svc = gatt.services.firstOrNull {
                it.uuid.toString().lowercase() == service.lowercase()
            }
            val ch = svc?.characteristics?.firstOrNull {
                it.uuid.toString().lowercase() == characteristic.lowercase()
            }
            if (svc == null || ch == null) {
                failAll(connectionId, BleRadioFailure.Unsupported(
                    "tuple ($service,$characteristic) was not discovered on this peer"))
                return@post
            }
            body(gatt, ch)
        }
    }

    override fun read(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<ByteArray>) -> Unit,
    ) {
        withCharacteristic(connectionId, service, characteristic) { gatt, ch ->
            readWaiters[connectionId] = completion
            try {
                gatt.readCharacteristic(ch)
            } catch (e: SecurityException) {
                readWaiters.remove(connectionId)?.invoke(BleResult.err(
                    BleRadioFailure.OsDenied("permissions revoked (${e.message})")))
            }
        }
    }

    override fun write(
        connectionId: String, service: String, characteristic: String,
        data: ByteArray, response: Boolean,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        withCharacteristic(connectionId, service, characteristic) { gatt, ch ->
            writeWaiters[connectionId] = completion
            try {
                @Suppress("DEPRECATION")
                ch.writeType = if (response) {
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                } else {
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                }
                gatt.writeCharacteristic(ch)
            } catch (e: SecurityException) {
                writeWaiters.remove(connectionId)?.invoke(BleResult.err(
                    BleRadioFailure.OsDenied("permissions revoked (${e.message})")))
            }
        }
    }

    override fun subscribe(
        connectionId: String, service: String, characteristic: String,
        onNotify: (ByteArray) -> Unit,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        withCharacteristic(connectionId, service, characteristic) { gatt, ch ->
            subscribeWaiters[connectionId] = completion
            notifyHandlers["$connectionId|$service|$characteristic"] = onNotify
            try {
                gatt.setCharacteristicNotification(ch, true)
                ch.descriptors.forEach { gatt.writeDescriptor(it) }
            } catch (e: SecurityException) {
                subscribeWaiters.remove(connectionId)?.invoke(BleResult.err(
                    BleRadioFailure.OsDenied("permissions revoked (${e.message})")))
            }
        }
    }

    override fun unsubscribe(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        withCharacteristic(connectionId, service, characteristic) { gatt, ch ->
            try {
                // the local disable is synchronous and self-describing —
                // settle the POST state here (no CCCD write rides this
                // path, so nothing else would ever consume the waiter)
                unsubscribeDirect(gatt, ch, completion)
            } catch (e: SecurityException) {
                completion(BleResult.err(
                    BleRadioFailure.OsDenied("permissions revoked (${e.message})")))
            }
        }
    }

    /** The local disable is synchronous and self-describing — settle the
     * POST state here (no CCCD write rides this path). */
    private fun unsubscribeDirect(
        gatt: BluetoothGatt, ch: BluetoothGattCharacteristic,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        try {
            val ok = gatt.setCharacteristicNotification(ch, false)
            if (ok) {
                completion(BleResult.ok(false))
            } else {
                completion(BleResult.err(BleRadioFailure.Unsupported(
                    "unsubscribe failed (the peer refused the local disable)")))
            }
        } catch (e: SecurityException) {
            completion(BleResult.err(
                BleRadioFailure.OsDenied("permissions revoked (${e.message})")))
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val connectionId = idsByGatt[gatt]
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                try {
                    gatt.discoverServices()
                } catch (e: SecurityException) {
                    settleConnect(gatt, null)
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val id = connectionId
                if (id != null) {
                    connections.remove(id)
                    idsByGatt.remove(gatt)
                    failAll(id, BleRadioFailure.Unsupported("the link dropped"))
                    settleConnect(gatt, null)
                    dropHandlers.remove(gatt)?.invoke(id)
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                settleConnect(gatt, null)
            }
            // characteristics resolve lazily per tuple (withCharacteristic);
            // the connect settles once the service list exists
            if (gatt.services.isNotEmpty()) {
                val id = idsByGatt[gatt]
                settleConnect(gatt, id)
            }
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            val connectionId = idsByGatt[gatt] ?: return
            @Suppress("DEPRECATION")
            val value = characteristic.value
            if (status == BluetoothGatt.GATT_SUCCESS && value != null) {
                readWaiters.remove(connectionId)?.invoke(BleResult.ok(value))
            } else {
                readWaiters.remove(connectionId)?.invoke(BleResult.err(
                    BleRadioFailure.Unsupported("read failed (GATT $status)")))
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            val connectionId = idsByGatt[gatt] ?: return
            writeWaiters.remove(connectionId)?.invoke(
                if (status == BluetoothGatt.GATT_SUCCESS) BleResult.ok(true)
                else BleResult.err(BleRadioFailure.Unsupported("write failed (GATT $status)")))
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            val connectionId = idsByGatt[gatt] ?: return
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            val svc = characteristic.service?.uuid?.toString()?.lowercase() ?: return
            val ch = characteristic.uuid.toString().lowercase()
            notifyHandlers["$connectionId|$svc|$ch"]?.invoke(value)
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int,
        ) {
            val connectionId = idsByGatt[gatt] ?: return
            // the CCCD write completes the subscribe arm
            subscribeWaiters.remove(connectionId)?.invoke(
                if (status == BluetoothGatt.GATT_SUCCESS) BleResult.ok(true)
                else BleResult.err(BleRadioFailure.Unsupported(
                    "subscribe failed (descriptor GATT $status)")))
        }
    }

    private fun settleConnect(gatt: BluetoothGatt, connectionId: String?) {
        connectWaiters.remove(gatt)?.invoke(
            connectionId?.let { BleResult.ok(it) }
                ?: BleResult.err(BleRadioFailure.Unsupported("the GATT link did not come up")))
    }
}
