import Foundation

/// A real dedicated thread, serial by construction. quickjs computes its JS
/// stack limit from the thread that created the runtime and validates the
/// stack on every JS call, so a runtime may NEVER be driven from pooled
/// dispatch threads (they hand each block an arbitrary thread). The boot
/// spike survives dispatch queues because its whole JS lifetime stays inside
/// one block = one thread; the carrier's and gateway's event-driven
/// delivers cannot, so they run here. 4 MB stack: quickjs-ng's JS stack
/// budget + C-to-Swift callback headroom (ARCHITECTURE.md §6 thread rules).
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
