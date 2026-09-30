import AVFoundation
import Foundation

/// The microphone face (the capability plane, v1.10.0 candidate; grant
/// family `microphone`): micStart/micStop control + the mic.frame channel
/// over the bridge event plumbing. Two consent layers, gateway first — the
/// manifest's family grant reached here means the caller is approved at the
/// gateway layer, so the OS prompt (AVAudioApplication's record permission)
/// is the second and last one; an OS refusal resolves `null` (a value, the
/// clipboard-decline posture), and the audit's detail names the refusing
/// layer. Frames are pcm-s16le mono chunks delivered as bridge events
/// (`mic.frame` / `mic.end`, payload bytes base64 — the frozen bridge
/// convention). Pressure discipline (D8): the tap enqueues into a bounded
/// ring with seq minted per captured frame — a frame dropped by a full ring
/// leaves an honest seq gap, never a growing queue — and one coalesced
/// drain forwards the ring FIFO onto the runtime queue; the end event
/// publishes exactly once, after the last forwarded frame.
final class MicPrimitives {
    /// The bounded ring's capacity in frames (drop-oldest on append).
    static let ringCap = 16
    /// Host-declared clamps (the proposal's "host clamps to a declared
    /// range"): sample rates outside 8k–48k clamp to the nearer edge,
    /// frameMs outside 10–200 clamps likewise.
    static let sampleRateRange: ClosedRange<Double> = 8000...48000
    static let frameMsRange: ClosedRange<Double> = 10...200

    private weak var core: GatewayCore?
    private let lock = NSLock()
    private let drainQueue = DispatchQueue(label: "org.dsh.gateway.mic.drain")
    private var streams: [String: MicStream] = [:]

    /// One live stream. `pending` is the ring of captured-but-unforwarded
    /// frames (seq minted at capture); `draining` coalesces drain hops.
    private final class MicStream {
        let engine = AVAudioEngine()
        let id: String
        let startedAt = Date()
        var converter: AVAudioConverter?
        var seq = 0
        var bytes = 0
        var pending: [(seq: Int, data: Data)] = []
        var draining = false
        var stopped = false
        var endPublished = false

        init(id: String) { self.id = id }
    }

    init(core: GatewayCore) {
        self.core = core
        core.register(name: "micStart") { call, done in self.start(call, done) }
        core.register(name: "micStop") { call, done in self.stop(call, done) }
        NotificationCenter.default.addObserver(
            self, selector: #selector(onInterruption),
            name: AVAudioSession.interruptionNotification, object: nil)
    }

    // ---- micStart (armed, not flowing — the timerSchedule posture) -----------

    private func start(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let format = call.string("format") ?? "pcm-s16le"
        guard format == "pcm-s16le" else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "micStart",
                message: "unsupported format \(format) (v0 carries pcm-s16le only)")))
        }
        let sampleRate = clamp((call.args["sampleRate"] as? Double) ?? 16000, Self.sampleRateRange)
        let channels = max(1, (call.args["channels"] as? Int) ?? 1)
        guard channels == 1 else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "micStart",
                message: "channels \(channels) unsupported (v0 is mono)")))
        }
        let frameMs = clamp((call.args["frameMs"] as? Double) ?? 100, Self.frameMsRange)
        core?.stageAuditDetail([
            "format": format, "sampleRate": Int(sampleRate),
            "frameMs": Int(frameMs), "tag": call.string("tag") ?? NSNull(),
        ])
        let fence = Once()
        requestPermissionThen(done, fence: fence, then: {
            self.arm(sampleRate: sampleRate, frameMs: frameMs, fence: fence, done)
        })
    }

    /// The OS consent layer (the second layer; the manifest's family grant
    /// was the first), then the arm hop. OFF the permission-callback
    /// thread: AVAudioSession / engine configuration inside the handler
    /// deadlocks (the callback holds session-internal state; measured on
    /// the dsh-iphone 26.5 simulator). The arm bound (see armFence): a
    /// wedged host route answers the honest `unavailable` instead of
    /// hanging micStart. The fence is PER CALL: micStart is an ordinary
    /// repeatable primitive, and a call-level Once is the only shape that
    /// keeps later starts settleable (an instance-level one burned on the
    /// first arm — measured in review).
    private func requestPermissionThen(
        _ done: @escaping GatewayDone, fence: Once,
        then arm: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            GatewayCore.uiMarker("mic-permission", "wait")
            AVAudioApplication.requestRecordPermission { [weak self] granted in
                self?.handlePermission(granted, done: done, fence: fence, arm: arm)
            }
        }
    }

    /// The permission answer, on its own method so the closure nesting stays
    /// inside the indent budget.
    private func handlePermission(
        _ granted: Bool, done: @escaping GatewayDone, fence: Once,
        arm: @escaping () -> Void
    ) {
        GatewayCore.uiMarker("mic-permission", "done")
        guard granted else {
            // The OS layer refused: a value, not an error; the audit
            // detail names the refusing layer (rule 2).
            core?.stageAuditDetail(["refused": "os"])
            return done(.success(NSNull()))
        }
        DispatchQueue.global(qos: .userInitiated).async(execute: arm)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.armTimeout) { [weak self] in
            self?.fenceTimeout(fence, done)
        }
    }

    private func fenceTimeout(_ fence: Once, _ done: @escaping GatewayDone) {
        guard fence.claim() else { return }
        done(.failure(GatewayError(
            code: "unavailable", primitive: "micStart",
            message: "audio input route did not open within "
                + "\(Int(Self.armTimeout))s (the host audio route is wedged)")))
    }

    /// Configures the engine and resolves { streamId } once ARMED. The tap
    /// installs in the input node's NATIVE format — installTap raises an
    /// ObjC exception on any format mismatch (input taps do not auto-
    /// convert, measured on the dsh-iphone 26.5 simulator) — and each
    /// buffer converts to pcm-s16le mono at the clamped rate through an
    /// explicit AVAudioConverter.
    private func arm(
        sampleRate: Double, frameMs: Double, fence: Once, _ done: @escaping GatewayDone
    ) {
        let id = "mic:\(UUID().uuidString)"
        let stream = MicStream(id: id)
        let error = openInputRoute(stream, sampleRate: sampleRate, frameMs: frameMs)
        if let error {
            return done(.failure(error))
        }
        // The call's fence is the single authority: whoever claims it
        // settles the call.
        guard fence.claim() else {
            stream.engine.inputNode.removeTap(onBus: 0)
            stream.engine.stop()
            return
        }
        lock.lock()
        streams[id] = stream
        lock.unlock()
        done(.success(["streamId": id]))
    }

    /// Opens the input route and installs the tap. The session FIRST (the
    /// native format is only meaningful once the record category is active
    /// — before it the route is degenerate and the tap has nothing to
    /// convert from; measured: micStart answered unavailable). The tap
    /// installs in the node's NATIVE format — installTap raises an ObjC
    /// exception on any format mismatch (input taps do not auto-convert) —
    /// and converts to pcm-s16le mono through an explicit AVAudioConverter.
    /// `inputFormat(forBus:)` OPENS the input AU — the call that can block
    /// forever on a wedged host route (the arm fence bounds it).
    private func openInputRoute(
        _ stream: MicStream, sampleRate: Double, frameMs: Double
    ) -> GatewayError? {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, options: [.defaultToSpeaker])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            return GatewayError(
                code: "unavailable", primitive: "micStart",
                message: "audio session refused: \(error.localizedDescription)")
        }
        let input = stream.engine.inputNode
        let native = input.inputFormat(forBus: 0)
        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: sampleRate,
                channels: 1, interleaved: true),
            let converter = AVAudioConverter(from: native, to: target),
            native.sampleRate > 0
        else {
            return GatewayError(
                code: "unavailable", primitive: "micStart",
                message: "no convertible input route (native format \(native))")
        }
        stream.converter = converter
        let frames = AVAudioFrameCount(native.sampleRate * frameMs / 1000)
        input.installTap(onBus: 0, bufferSize: max(frames, 1), format: native) {
            [weak self] buffer, _ in
            self?.capture(stream, buffer)
        }
        do {
            try stream.engine.prepare()
            try stream.engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return GatewayError(
                code: "unavailable", primitive: "micStart",
                message: "audio engine refused: \(error.localizedDescription)")
        }
        return nil
    }

    /// The arm fence: the input AU open (inputFormat -> installTap -> engine
    /// start) can block INDEFINITELY where the host audio route is wedged
    /// (measured on the dsh-iphone 26.5 simulator: with the Mac-side
    /// Simulator microphone grant absent, `inputFormat(forBus:)` never
    /// returns). The fence bounds the wait and answers the honest
    /// `unavailable` — micStart never hangs the scenario; the capability
    /// gap is a value (the emulator posture), and a healthy host arms
    /// well inside the window.
    private let armFence = Once()
    static let armTimeout: TimeInterval = 8

    private final class Once {
        private let lock = NSLock()
        private var fired = false
        /// True for exactly one caller — the winner runs its settle.
        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if fired { return false }
            fired = true
            return true
        }
    }

    /// One tap buffer -> convert to s16le mono -> one ring entry (runs on
    /// the engine's real-time queue: conversion + byte-copy + counter math
    /// only). A full ring drops the OLDEST entries — their seq is gone from
    /// the delivered stream, the honest gap. A stopped stream drops
    /// everything.
    private func capture(_ stream: MicStream, _ buffer: AVAudioPCMBuffer) {
        guard let converter = stream.converter else { return }
        let target = converter.outputFormat
        let ratio = buffer.format.sampleRate > 0
            ? target.sampleRate / buffer.format.sampleRate : 1
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard
            capacity > 0,
            let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)
        else { return }
        var fed = false
        var convError: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        converter.convert(to: out, error: &convError, withInputFrom: inputBlock)
        guard convError == nil, out.frameLength > 0,
              let ch = out.int16ChannelData?[0] else { return }
        let data = Data(bytes: ch, count: Int(out.frameLength) * 2) // s16le: 2 B/frame

        lock.lock()
        defer { lock.unlock() }
        guard !stream.stopped else { return }
        stream.seq += 1
        stream.pending.append((stream.seq, data))
        while stream.pending.count > Self.ringCap {
            stream.pending.removeFirst()
        }
        let needDrain = !stream.draining
        stream.draining = true
        if needDrain {
            drainQueue.async { [weak self] in self?.drain(stream) }
        }
    }

    /// Forwards the ring FIFO (one drain hop at a time; the tap re-arms).
    /// Each forwarded frame's bytes join the stop record's count — the
    /// audit carries what the consumer actually received.
    private func drain(_ stream: MicStream) {
        while true {
            lock.lock()
            let item = stream.stopped ? nil : stream.pending.isEmpty
                ? nil : stream.pending.removeFirst()
            if item == nil { stream.draining = false }
            lock.unlock()
            guard let item else { return }
            stream.bytes += item.data.count
            core?.emit?(GatewayCore.jsonLine([
                "event": "mic.frame",
                "streamId": stream.id,
                "seq": item.seq,
                "bytesB64": item.data.base64EncodedString(),
            ]) ?? "{}")
        }
    }

    // ---- micStop (idempotent, the record that carries duration + bytes) ------

    private func stop(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let id = call.string("streamId") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "micStop", message: "streamId missing")))
        }
        lock.lock()
        let stream = streams.removeValue(forKey: id)
        lock.unlock()
        guard let stream, !stream.stopped else {
            // unknown or already-stopped id: the timerCancel shape
            return done(.success(["stopped": false, "durationMs": 0, "bytes": 0]))
        }
        halt(stream, reason: "stopped")
        let durationMs = Int(Date().timeIntervalSince(stream.startedAt) * 1000)
        core?.stageAuditDetail(["durationMs": durationMs, "bytes": stream.bytes])
        done(.success(["stopped": true, "durationMs": durationMs, "bytes": stream.bytes]))
    }

    /// Stops capture, drains what remains IN ORDER on the drain queue, then
    /// publishes the end event exactly once.
    private func halt(_ stream: MicStream, reason: String) {
        lock.lock()
        let firstStop = !stream.stopped
        stream.stopped = true
        lock.unlock()
        guard firstStop else { return }
        stream.engine.inputNode.removeTap(onBus: 0)
        stream.engine.stop()
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation)
        drainQueue.sync { drain(stream) }
        lock.lock()
        let first = !stream.endPublished
        stream.endPublished = true
        lock.unlock()
        guard first, let core else { return }
        core.emit?(GatewayCore.jsonLine([
            "event": "mic.end", "streamId": stream.id, "reason": reason,
        ]) ?? "{}")
    }

    /// A foreground-session-only plane: an OS audio interruption (a phone
    /// call, Siri) ends every live stream with reason "interrupted" —
    /// capture is suspension, not a feature (rule 5).
    @objc private func onInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        lock.lock()
        let live = streams.values.filter { !$0.stopped }
        lock.unlock()
        live.forEach { halt($0, reason: "interrupted") }
    }

    private func clamp(_ value: Double, _ range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(value, range.lowerBound), range.upperBound)
    }
}
