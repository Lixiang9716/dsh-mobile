import Foundation

/// Result of one spike run on the runtime queue.
struct SpikeOutcome {
    let completed: Bool
    let passed: Bool
    let error: String
    let canonicalLines: [String]

    var verdict: String { completed && passed ? "PASS" : "FAIL" }

    /// Engine identity as reported by the run's own runtime.created line
    /// (falls back to the host's pinned defaults when unparseable).
    var engineName: String { engineField("engine") ?? "quickjs-ng" }
    var engineVersion: String { engineField("engineVersion") ?? "unknown" }

    private func engineField(_ key: String) -> String? {
        guard let line = canonicalLines.first(where: { $0.contains("\"runtime.created\"") })
        else { return nil }
        let json = line.dropFirst(SpikeLogSink.prefix.count)
        guard
            let data = json.data(using: .utf8),
            let entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let payload = (entry["data"] as? [[String: Any]])?.first,
            let value = payload[key] as? String
        else { return nil }
        return value
    }
}

/// The build flavor, decided at compile time by the configuration's defines
/// (project.pbxproj: `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DSH_RELEASE` on
/// Release, `DSH_RELEASE=1` in GCC_PREPROCESSOR_DEFINITIONS for the C host).
/// The harness (Debug) is the verification vehicle — full structured logging,
/// E2E drives run. The release build is what a user gets: no E2E machinery,
/// no per-event stream, and the critical set (warn/error) retained.
enum BuildFlavor {
    static let isRelease: Bool = {
        #if DSH_RELEASE
        return true
        #else
        return false
        #endif
    }()

    /// One canonical record survives into a release build only when it is
    /// warn/error class. The record is the unified logger's JSON envelope
    /// (`{"level":…,"module":…,"message":…,"data":[…]}`), so the level is
    /// read off the envelope rather than guessed from the text.
    static func keeps(_ line: String) -> Bool {
        guard isRelease else { return true }
        return line.contains("\"level\":\"warn\"") || line.contains("\"level\":\"error\"")
    }
}

/// Receives each canonical E2E line from the C host: appended (for the UI
/// and the outcome), printed to stdout (the E2E capture channel), and NSLog'd
/// (os_log evidence). Called only from the runtime queue while it drives the
/// host, so no synchronization is needed.
final class SpikeLogSink {
    static let prefix = "dsh.spike.log: "
    private(set) var lines: [String] = []

    var cSink: dsh_spike_sink {
        dsh_spike_sink(
            on_log: { ud, line in
                guard let ud, let line else { return }
                let sink = Unmanaged<SpikeLogSink>.fromOpaque(ud).takeUnretainedValue()
                sink.consume(String(cString: line))
            },
            ud: Unmanaged.passUnretained(self).toOpaque()
        )
    }

    /// One host-side line into the same capture the JS log rides: a drive that
    /// has something to say before the entry module runs (the launch env it
    /// declared, say) must not have to reach into the private sink.
    func note(_ line: String) { consume(line) }

    private func consume(_ line: String) {
        guard BuildFlavor.keeps(line) else { return }
        lines.append(line)
        print(line)
        fflush(stdout)
        NSLog("%@", line)
    }
}

/// Drives the platform-neutral C spike host on a dedicated serial queue.
/// The whole JS lifetime (new → eval → pump → free) executes inside ONE
/// block on ONE thread — the only threading model the spike allows
/// (ARCHITECTURE.md §6 thread rules).
final class SpikeRuntime {
    static let entryModule = "scenario/m1-spike-boot.js"
    private let queue = DispatchQueue(label: "org.dsh.spike.runtime")

    func run(completion: @escaping (SpikeOutcome) -> Void) {
        queue.async { [self] in
            let outcome = runOnce()
            DispatchQueue.main.async { completion(outcome) }
        }
    }

    private func runOnce() -> SpikeOutcome {
        let sink = SpikeLogSink()
        do {
            let root = try SpikeBundleStager.stage()
            return drive(bundleRoot: root.path, sink: sink)
        } catch {
            let message = "bundle staging failed: \(error)"
            reportFailure(message)
            return SpikeOutcome(
                completed: false, passed: false, error: message, canonicalLines: sink.lines
            )
        }
    }

    private func drive(bundleRoot: String, sink: SpikeLogSink) -> SpikeOutcome {
        var cSink = sink.cSink
        // Created through the shared factory so the guest-userland declaration
        // (contract v1.3.0 `ishRun`) is made on EVERY drive, not just this one.
        guard let host = dsh_spike_new_declaring(bundleRoot, &cSink, note: sink.note) else {
            return fail(sink, "dsh_spike_new returned NULL")
        }
        defer { dsh_spike_free(host) }
        let source = String(cString: dsh_spike_res_scenario_js(nil))
        if dsh_spike_eval(host, Self.entryModule, source) != 0 {
            return fail(sink, "eval: \(String(cString: dsh_spike_error(host)))")
        }
        if dsh_spike_pump(host) != 0 {
            return fail(sink, "pump: \(String(cString: dsh_spike_error(host)))")
        }
        let outcome = SpikeOutcome(
            completed: dsh_spike_complete(host) != 0,
            passed: dsh_spike_pass(host) != 0,
            error: "",
            canonicalLines: sink.lines
        )
        print("spike: host drive finished completed=\(outcome.completed) passed=\(outcome.passed)")
        return outcome
    }

    private func fail(_ sink: SpikeLogSink, _ message: String) -> SpikeOutcome {
        reportFailure(message)
        return SpikeOutcome(
            completed: false, passed: false, error: message, canonicalLines: sink.lines
        )
    }

    /// Failure report on stdout (the E2E capture channel; lines without the
    /// canonical prefix are ignored by the checker) and NSLog (os_log).
    private func reportFailure(_ message: String) {
        print("spike: FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: FAIL \(message)")
    }
}
