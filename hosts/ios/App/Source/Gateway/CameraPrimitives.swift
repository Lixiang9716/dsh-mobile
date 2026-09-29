import AVFoundation
import Foundation
import ImageIO

/// The system capability plane's camera family (proposal v1.10.0): the
/// capture BURST (`cameraCapture`) is the v1 implementation face — each frame
/// lands in the host's capture scope (the v1.5.0 media-picker read-through
/// posture: pixels are ordinary files the fs primitives read back) and the
/// whole burst is one call, one audit record (count, total bytes, flash).
/// The recording rows (`cameraRecordStart`/`Stop`) are registered to answer
/// `unavailable` — their shape is contract, their implementation is phased.
/// Two consent layers, gateway first: the manifest's `camera` family grant
/// reaches this handler only after the gateway's own check; the OS prompt
/// (NSCameraUsageDescription) is the second layer, and an OS refusal resolves
/// null — never a silent substitute. A device without a camera (every iOS
/// simulator) rejects `unavailable`.
final class CameraPrimitives: NSObject, AVCapturePhotoCaptureDelegate {
    /// Host-declared burst range (the proposal's "host clamps to a declared
    /// range"); the audit carries the requested count and the honored count.
    static let maxBurst = 8
    /// The burst deadline (rule 8: a wait on a condition carries a deadline).
    /// A burst the camera never completes settles `unavailable` at expiry —
    /// the caller's promise answers, it never hangs.
    static let burstDeadlineSeconds = 20.0
    private weak var core: GatewayCore?
    private let fs: FSPrimitives
    private var mediaDir: URL?

    init(core: GatewayCore, fs: FSPrimitives) {
        self.core = core
        self.fs = fs
        super.init()
        core.register(name: "cameraCapture") { call, done in self.capture(call, done) }
        core.register(name: "cameraRecordStart") { _, done in self.phased("cameraRecordStart", done) }
        core.register(name: "cameraRecordStop") { _, done in self.phased("cameraRecordStop", done) }
    }

    // ---- cameraCapture -------------------------------------------------------

    private func capture(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let requested = call.args["count"] as? Int ?? 1
        let count = min(max(requested, 1), Self.maxBurst)
        let flash = call.string("flash") ?? "auto"
        guard ["off", "auto", "on"].contains(flash) else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "cameraCapture",
                message: "flash must be off | auto | on: \(flash)")))
        }
        guard let device = AVCaptureDevice.default(for: .video) else {
            return done(.failure(GatewayError(
                code: "unavailable", primitive: "cameraCapture",
                message: "no camera on this device")))
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startBurst(device, call, count, flash, requested, done)
        case .notDetermined:
            requestThenBurst(device, call, count, flash, requested, done)
        default:
            settleRefusal(done) // OS-layer refusal is a value (resolves null)
        }
    }

    /// The OS prompt is the second consent layer; the burst starts (or the
    /// refusal settles) from the user's answer, off this thread. The marker
    /// is the device driver's hook (the simulator leg never reaches it — no
    /// camera, `unavailable` before any prompt).
    private func requestThenBurst(
        _ device: AVCaptureDevice, _ call: GatewayCall, _ count: Int,
        _ flash: String, _ requested: Int, _ done: @escaping GatewayDone
    ) {
        DispatchQueue.main.async { GatewayCore.uiMarker("camera-permission", "wait") }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            self?.resumeBurst(granted, device, call, count, flash, requested, done)
        }
    }

    /// The request's answer: granted → the burst; refused → the OS refusal
    /// value. The done marker rides the main queue like the wait marker.
    private func resumeBurst(
        _ granted: Bool, _ device: AVCaptureDevice, _ call: GatewayCall,
        _ count: Int, _ flash: String, _ requested: Int, _ done: @escaping GatewayDone
    ) {
        DispatchQueue.main.async { GatewayCore.uiMarker("camera-permission", "done") }
        if granted {
            startBurst(device, call, count, flash, requested, done)
        } else {
            settleRefusal(done)
        }
    }

    private func settleRefusal(_ done: @escaping GatewayDone) {
        core?.stageAuditDetail(["count": 0, "refused": "os"])
        done(.success(NSNull()))
    }

    /// The burst: one session, `count` sequential photo captures, one audit
    /// record and one settle at the end. The session runs on this work-queue
    /// thread (never the runtime thread, §6). Bursts are PER-CALL state keyed
    /// by the settings' uniqueID — the async tail runs on the AVCapture
    /// delegate queue where nothing serializes, so overlapping calls must
    /// never share a slot (the single-slot first draft hung the first
    /// caller's promise and mis-billed its frames to the second call).
    private func startBurst(
        _ device: AVCaptureDevice, _ call: GatewayCall, _ count: Int,
        _ flash: String, _ requested: Int, _ done: @escaping GatewayDone
    ) {
        let session = AVCaptureSession()
        let output = AVCapturePhotoOutput()
        guard let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input), session.canAddOutput(output)
        else {
            return done(.failure(GatewayError(
                code: "unavailable", primitive: "cameraCapture",
                message: "camera capture session unavailable")))
        }
        session.beginConfiguration()
        session.sessionPreset = .photo
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        let mode = Self.flashMode(flash)
        let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        if output.supportedFlashModes.contains(mode) {
            settings.flashMode = mode
        }
        let maxBytes = call.args["maxBytes"] as? Int
        let burst = BurstState(
            remaining: count, flash: mode, maxBytes: maxBytes, requested: requested,
            settingsID: settings.uniqueID, session: session, output: output,
            settings: settings, done: done, dir: mediaDirectory())
        burst.armDeadline { [weak self] in
            self?.expireBurst(settings.uniqueID)
        }
        burstLock.lock()
        bursts[settings.uniqueID] = burst
        burstLock.unlock()
        output.capturePhoto(with: settings, delegate: self)
    }

    // ---- the burst collector ---------------------------------------------------

    private let burstLock = NSLock()
    /// Per-call bursts keyed by AVCapturePhotoSettings.uniqueID (delegate
    /// callbacks carry it back on photo.resolvedSettings).
    private var bursts: [Int64: BurstState] = [:]

    private func takeBurst(_ settingsID: Int64) -> BurstState? {
        burstLock.lock()
        defer { burstLock.unlock() }
        return bursts.removeValue(forKey: settingsID)
    }

    /// The deadline's expiry path: settle the burst unavailable and tear the
    /// session down — the promise answers, it never hangs.
    private func expireBurst(_ settingsID: Int64) {
        guard let burst = takeBurst(settingsID) else { return }
        burst.session.stopRunning()
        let elapsed = Int(Date().timeIntervalSince(burst.startedAt) * 1000)
        core?.stageAuditDetail([
            "count": burst.photos.count, "requested": burst.requested,
            "totalBytes": burst.totalBytes, "dropped": burst.dropped,
            "flash": Self.flashName(burst.flash), "durationMs": elapsed,
            "expired": true,
        ])
        burst.done(.failure(GatewayError(
            code: "unavailable", primitive: "cameraCapture",
            message: "camera burst did not complete (deadline)")))
    }

    /// One burst's accumulator: the frames, the audit facts, the request,
    /// its own session, its settle and its own deadline.
    private final class BurstState {
        let flash: AVCaptureDevice.FlashMode
        let maxBytes: Int?
        let requested: Int
        let settingsID: Int64
        let session: AVCaptureSession
        let output: AVCapturePhotoOutput
        let settings: AVCapturePhotoSettings
        let done: GatewayDone
        let dir: URL?
        let startedAt = Date()
        private let lock = NSLock()
        private var remaining: Int
        private(set) var photos: [[String: Any]] = []
        private(set) var totalBytes = 0
        private(set) var dropped = 0
        private var deadline: DispatchWorkItem?

        init(remaining: Int, flash: AVCaptureDevice.FlashMode, maxBytes: Int?,
             requested: Int, settingsID: Int64, session: AVCaptureSession,
             output: AVCapturePhotoOutput, settings: AVCapturePhotoSettings,
             done: @escaping GatewayDone, dir: URL?) {
            self.remaining = remaining
            self.flash = flash
            self.maxBytes = maxBytes
            self.requested = requested
            self.settingsID = settingsID
            self.session = session
            self.output = output
            self.settings = settings
            self.done = done
            self.dir = dir
        }

        /// Rule 8: the wait carries its deadline — armed once, disarmed by
        /// the settle path.
        func armDeadline(_ onExpire: @escaping () -> Void) {
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.isSettled() else { return }
                onExpire()
            }
            deadline = work
            DispatchQueue.global().asyncAfter(
                deadline: .now() + CameraPrimitives.burstDeadlineSeconds, execute: work)
        }

        func cancelDeadline() {
            deadline?.cancel()
            deadline = nil
        }

        private func isSettled() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return remaining <= 0
        }

        func accept(_ photo: [String: Any], bytes: Int) {
            lock.lock()
            photos.append(photo)
            totalBytes += bytes
            remaining -= 1
            lock.unlock()
        }

        func drop() {
            lock.lock()
            dropped += 1
            remaining -= 1
            lock.unlock()
        }

        func finished() -> Bool {
            isSettled()
        }
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?
    ) {
        let settingsID = photo.resolvedSettings.uniqueID
        burstLock.lock()
        let burst = bursts[settingsID]
        burstLock.unlock()
        guard let burst else { return }
        if let error {
            burst.drop()
        } else if let data = photo.fileDataRepresentation(),
                  burst.maxBytes.map({ data.count <= $0 }) ?? true,
                  let entry = Self.photoEntry(data, dir: burst.dir, fs: fs) {
            burst.accept(entry, bytes: data.count)
        } else {
            burst.drop() // an over-cap frame is dropped, never truncated
        }
        guard burst.finished() else {
            // the SAME settings ride every frame of the burst — the uniqueID
            // is how the next callback finds this burst in the map
            burst.output.capturePhoto(with: burst.settings, delegate: self)
            return
        }
        settleBurst(settingsID, burst)
    }

    private func settleBurst(_ settingsID: Int64, _ burst: BurstState) {
        guard takeBurst(settingsID) != nil else { return }
        burst.cancelDeadline()
        burst.session.stopRunning()
        let elapsed = Int(Date().timeIntervalSince(burst.startedAt) * 1000)
        core?.stageAuditDetail([
            "count": burst.photos.count, "requested": burst.requested,
            "totalBytes": burst.totalBytes, "dropped": burst.dropped,
            "flash": Self.flashName(burst.flash), "durationMs": elapsed,
        ])
        burst.done(.success(["photos": burst.photos]))
    }

    /// One frame's CapturedPhoto dict: written into the capture scope (the
    /// media staging directory), read back through the granted scope.
    private static func photoEntry(_ data: Data, dir: URL?, fs: FSPrimitives) -> [String: Any]? {
        guard let dir, let dims = pixelDims(data) else { return nil }
        let name = "capture-\(UUID().uuidString.prefix(8)).jpg"
        guard (try? data.write(to: dir.appendingPathComponent(name))) != nil else { return nil }
        return [
            "scope": fs.grantUserScope(dir),
            "path": name,
            "bytes": data.count,
            "width": dims.0,
            "height": dims.1,
            "format": "jpeg",
            "capturedAt": GatewayCore.isoNow(),
        ]
    }

    private static func pixelDims(_ data: Data) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (width, height)
    }

    private static func flashMode(_ name: String) -> AVCaptureDevice.FlashMode {
        switch name {
        case "off": return .off
        case "on": return .on
        default: return .auto
        }
    }

    private static func flashName(_ mode: AVCaptureDevice.FlashMode) -> String {
        switch mode {
        case .off: return "off"
        case .on: return "on"
        default: return "auto"
        }
    }

    // ---- the phased recording rows -------------------------------------------

    /// Shape now, implementation phased (proposal §3): the honest
    /// `unavailable`, never a pretend recording.
    private func phased(_ name: String, _ done: @escaping GatewayDone) {
        core?.stageAuditDetail(["phased": true])
        done(.failure(GatewayError(
            code: "unavailable", primitive: name,
            message: "phased — the capture burst is the v1 implementation face")))
    }

    /// The staging directory for captured frames: <Documents>/media — the
    /// media picker's own read-through scope directory (the same grant
    /// discipline; captures are media the session owns).
    private func mediaDirectory() -> URL? {
        if let mediaDir { return mediaDir }
        let documents = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask)[0]
        let dir = documents.appendingPathComponent("media", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        mediaDir = dir
        return dir
    }
}
