import Foundation

/// Drives `m1.carrier.loopback`: one C runtime session with the bus seam
/// wired, the loopback carrier server in front of it, and every crossing
/// marshaled onto the right queues — server (carrier queue) → JS via
/// `dsh_spike_bus_deliver` on the dedicated runtime thread; JS
/// (`__dshBusPost`, runtime thread) → server via a hop to the carrier queue
/// (the server re-hops internally). The JS lifetime stays on ONE thread
/// (ARCHITECTURE.md §6); the outcome settles exactly once — scenario
/// completion or watchdog timeout, whichever comes first.
/// A real dedicated thread, serial by construction. quickjs computes its JS
/// stack limit from the thread that created the runtime and validates the
/// stack on every JS call, so a runtime may NEVER be driven from pooled
/// dispatch threads (they hand each block an arbitrary thread). The boot
/// spike survives dispatch queues because its whole JS lifetime stays inside
/// one block = one thread; the carrier's event-driven delivers cannot, so
/// they run here. 4 MB stack: quickjs-ng's JS stack budget + C-to-Swift
/// callback headroom.
final class RuntimeThread {
    private let cond = NSCondition()
    private var pending: [() -> Void] = []
    private var running = true
    private var thread: Thread!
    private let name: String

    init(name: String) { self.name = name }

    /// Creates + starts the thread here rather than in init: the body
    /// captures self, which Swift only allows once initialization completes.
    func start() {
        thread = Thread { [self] in
            Thread.current.name = name
            cond.lock()
            while running || !pending.isEmpty {
                while pending.isEmpty && running { cond.wait() }
                if pending.isEmpty { break }
                let block = pending.removeFirst()
                cond.unlock()
                block()
                cond.lock()
            }
            cond.unlock()
        }
        thread.name = name
        thread.stackSize = 4 << 20
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func async(_ block: @escaping () -> Void) {
        cond.lock()
        pending.append(block)
        cond.signal()
        cond.unlock()
    }

    func stop() {
        cond.lock()
        running = false
        cond.signal()
        cond.unlock()
    }
}

final class CarrierRuntime {
    static let entryModule = "scenario/m1-carrier-loopback.js"
    static let watchdogSeconds = 30

    private let runtimeThread = RuntimeThread(name: "org.dsh.spike.carrier")
    private let server = CarrierServer()
    private let sink = SpikeLogSink()
    // Swift imports the never-defined C struct's pointer as OpaquePointer.
    private var host: OpaquePointer?
    private var watchdog: DispatchWorkItem?
    private var completion: ((SpikeOutcome) -> Void)?
    private var finished = false
    private var hostHelloDelivered = false

    /// Main-thread callback carrying the loopback origin once the page can
    /// be loaded (the Presentation surface wires its WKWebView here).
    var onOpenOrigin: ((URL) -> Void)?

    func run(completion: @escaping (SpikeOutcome) -> Void) {
        runtimeThread.start()
        runtimeThread.async { [self] in
            self.completion = completion
            startSession()
        }
    }

    // ---- session setup (runtime thread) ------------------------------------

    private func startSession() {
        let root: URL
        do {
            root = try SpikeBundleStager.stage()
            try server.start(webRoot: root.appendingPathComponent("web")) { [weak self] in
                // fires on the server queue; JS only ever runs on our thread
                self?.runtimeThread.async { self?.deliverHostHello() }
            }
        } catch {
            finish(SpikeOutcome(
                completed: false, passed: false,
                error: "carrier bootstrap: \(error)",
                canonicalLines: sink.lines
            ))
            return
        }
        server.onWSMessage = { [weak self] text in self?.ingest(text) }
        var cSink = sink.cSink
        guard let host = dsh_spike_new(root.path, &cSink)
        else {
            finish(failOutcome("dsh_spike_new returned NULL"))
            return
        }
        self.host = host
        dsh_spike_set_bus_sink(host, { ud, line in
            guard let ud, let line else { return }
            let runtime = Unmanaged<CarrierRuntime>.fromOpaque(ud).takeUnretainedValue()
            runtime.busPosted(String(cString: line))
        }, Unmanaged.passUnretained(self).toOpaque())
        let source = String(cString: dsh_spike_res_scenario_carrier_js(nil))
        if dsh_spike_eval(host, Self.entryModule, source) != 0 {
            finish(failOutcome("eval: \(String(cString: dsh_spike_error(host)))"))
            return
        }
        if dsh_spike_pump(host) != 0 {
            finish(failOutcome("pump: \(String(cString: dsh_spike_error(host)))"))
            return
        }
        armWatchdog()
    }

    /// Runtime queue only. The server's onReady hop and the setup tail can
    /// both offer the port; the scenario must see host.hello exactly once.
    /// This is also when the origin is first loadable — the page load waits
    /// for the port, never for bus.ready (which fires during eval, before
    /// the listener has a port).
    private func deliverHostHello() {
        guard !hostHelloDelivered, server.port != 0 else { return }
        hostHelloDelivered = true
        deliver(["type": "host.hello", "port": Int(server.port)])
        let port = Int(server.port)
        DispatchQueue.main.async { [weak self] in
            self?.onOpenOrigin?(URL(string: "http://127.0.0.1:\(port)/")!)
        }
    }

    // ---- JS → host direction (runtime queue, called from C) ----------------

    private func busPosted(_ line: String) {
        guard !finished, host != nil,
              let data = line.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        switch msg["type"] as? String {
        case "bus.ready":
            break // the page load is driven by deliverHostHello, not here
        case "ws.send":
            if let payload = msg["payload"],
               let text = Self.jsonLine(payload) {
                server.send(text) // CarrierServer.send hops to its own queue
            }
        default:
            break
        }
    }

    // ---- host → JS direction ----------------------------------------------

    /// Called on the server queue; hops onto the runtime thread, where — and
    /// only where — JS may run.
    private func ingest(_ text: String) {
        guard let payload = (try? JSONSerialization.jsonObject(
            with: Data(text.utf8))) as? [String: Any] else { return }
        runtimeThread.async { [weak self] in
            guard let self, !self.finished else { return }
            if payload["type"] as? String == "hello" {
                self.deliver([
                    "type": "ws.hello",
                    "href": payload["href"] ?? "",
                    "served": self.server.servedList(),
                ])
            } else {
                self.deliver(["type": "ws.message", "payload": payload])
            }
        }
    }

    /// Delivers one bus line into the scenario and settles on completion.
    /// Runtime queue only.
    private func deliver(_ obj: [String: Any]) {
        guard let host, !finished, let text = Self.jsonLine(obj) else { return }
        if dsh_spike_bus_deliver(host, text) != 0 {
            finish(failOutcome("bus deliver: \(String(cString: dsh_spike_error(host)))"))
            return
        }
        if dsh_spike_complete(host) != 0 {
            finish(SpikeOutcome(
                completed: true,
                passed: dsh_spike_pass(host) != 0,
                error: "",
                canonicalLines: sink.lines
            ))
        }
    }

    // ---- settling -----------------------------------------------------------

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // the check itself must run on the runtime thread
            self.runtimeThread.async { [weak self] in
                guard let self, !self.finished else { return }
                self.finish(self.failOutcome(
                    "carrier watchdog: scenario did not complete in \(Self.watchdogSeconds)s"))
            }
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        reportFailure(message)
        return SpikeOutcome(
            completed: false, passed: false,
            error: message,
            canonicalLines: sink.lines
        )
    }

    private func finish(_ outcome: SpikeOutcome) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        dsh_spike_free(host)
        host = nil
        server.stop()
        print("spike: carrier drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        runtimeThread.async { [weak self] in self?.runtimeThread.stop() }
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }

    /// Failure report on stdout (the E2E capture channel; lines without the
    /// canonical prefix are ignored by the checker) and NSLog (os_log).
    private func reportFailure(_ message: String) {
        print("spike: carrier FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: carrier FAIL \(message)")
    }

    private static func jsonLine(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
