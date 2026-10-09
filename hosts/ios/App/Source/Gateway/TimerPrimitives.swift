import Foundation

/// The gateway timer seam (contract v1.4.0 §5) on this host — the Android
/// loop-z2 (#382) and the Harmony #395 twin. `timerSchedule {delayMs, tag?}`
/// arms a dispatch-source timer and answers `{timerId}` immediately (the JS
/// shim's sync-handle contract); the fire delivers
/// `{"event":"timer.fire","timerId":N}` through `core.emit` — the session's
/// emit hop lands it on the runtime thread, so a timer callback never runs
/// on a second thread (ARCHITECTURE.md §6). `timerCancel {timerId}` is the
/// idempotent one-way cancel the contract defines: an unknown or
/// already-fired id still settles ok.
///
/// The consumer is upstream/shims/timers.js — the deadline fuses, the llm
/// retry pacing and the read-idle watchdog all arm through this seam.
/// Before this primitive the gateway settled every arm denied and each JS
/// timer hung forever (measured 2026-10-08 on the serve seat: 160,247
/// timerSchedule denials in fifteen minutes, one `arm/failed` warn per
/// runtime).
final class TimerPrimitives {
    private weak var core: GatewayCore?

    /// Bookkeeping and firing share one serial queue; the only cross-thread
    /// call is `core.emit`, which the session routes onto the runtime queue.
    private let queue = DispatchQueue(label: "org.dsh.gateway.timer")
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var nextTimerId: Int = 1

    init(core: GatewayCore) {
        self.core = core
        core.register(name: "timerSchedule") { call, done in
            self.schedule(call, done)
        }
        core.register(name: "timerCancel") { call, done in
            self.cancel(call, done)
        }
    }

    private func schedule(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let requested = call.args["delayMs"] as? Double
            ?? (call.args["delayMs"] as? Int).map(Double.init)
        guard let requested else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "timerSchedule",
                message: "delayMs must be a number")))
        }
        let delayMs = Int(min(2_147_483_647, max(0, requested.rounded(.down))))
        queue.async { [weak self] in
            guard let self else {
                return done(.failure(GatewayError(
                    code: "io", primitive: "timerSchedule",
                    message: "timer bookkeeping released")))
            }
            let timerId = self.nextTimerId
            self.nextTimerId += 1
            let source = DispatchSource.makeTimerSource(queue: self.queue)
            source.schedule(deadline: .now() + .milliseconds(delayMs))
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.timers[timerId] = nil
                if let json = GatewayCore.jsonLine([
                    "event": "timer.fire", "timerId": timerId,
                ]) {
                    self.core?.emit?(json)
                }
            }
            source.resume()
            self.timers[timerId] = source
            done(.success(["timerId": timerId]))
        }
    }

    private func cancel(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let requested = call.args["timerId"] as? Double
            ?? (call.args["timerId"] as? Int).map(Double.init)
        guard let requested else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "timerCancel",
                message: "timerId must be a number")))
        }
        let timerId = Int(requested)
        queue.async { [weak self] in
            if let source = self?.timers.removeValue(forKey: timerId) {
                source.cancel()
            }
            done(.success(["cancelled": true]))
        }
    }
}
