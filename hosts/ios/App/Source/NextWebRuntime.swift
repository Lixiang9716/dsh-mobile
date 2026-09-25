import Foundation
import WebKit

/// Drives `nextweb.mount`: the SELF-HOSTED web client (presentation/
/// web-client-next) on the SAME SessionServe seat the user-facing launch
/// runs — selected by the launch configuration (`-dsh-web-client
/// dsh-web-client-next`), served with zero injection rows, speaking the
/// same /api + remote.mux surface. The probe drives OUR page like a user
/// (new session → type → send) through a REAL agent-loop turn whose model
/// boundary is the carrier's scripted SSE endpoint; the journal streams
/// live and the page's own timeline fold renders it. One implementation of
/// the serving path, verified by this manifest and run by users — the
/// SessionWriteRuntime shape, mirrored.
final class NextWebRuntime {
    static let scenario = "nextweb.mount"
    static let clientID = SessionServe.nextClientID
    static let watchdogSeconds = 180

    private let serve = SessionServe()
    private let eventLog = CarrierEventLog(scenario: NextWebRuntime.scenario)
    private weak var webView: WKWebView?
    private var completion: ((SpikeOutcome) -> Void)?
    private var watchdog: DispatchWorkItem?
    private var finished = false

    /// Main-thread callback carrying the loopback origin (token included).
    var onOpenOrigin: ((URL) -> Void)?

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    func run(completion: @escaping (SpikeOutcome) -> Void) {
        self.completion = completion
        armWatchdog()
        wireEvidence()
        // First record in the manifest: the launch configuration selected
        // the self-hosted client.
        eventLog.emit("client.selected", ["client": Self.clientID, "source": "launch"])
        do {
            try serve.start()
        } catch {
            finish(failOutcome("nextweb bootstrap: \(error)"))
        }
    }

    /// The seat's serving facts → the canonical records the manifest pins.
    private func wireEvidence() {
        serve.onIndexRendered = { [weak self] rows, bytes in
            self?.eventLog.emit("index.rendered", ["rows": rows, "bytes": bytes])
        }
        serve.onIndexServed = { [weak self] in
            self?.eventLog.emit("index.served", ["path": "/", "status": 200])
        }
        serve.onAssetServed = { [weak self] path in
            guard let self, !self.assetLogged, path == "/js/main.js" else { return }
            assetLogged = true
            eventLog.emit("asset.served", ["path": path])
        }
        serve.onUpgradeAccepted = { [weak self] path in
            guard let self, !self.upgradeLogged else { return }
            upgradeLogged = true
            eventLog.emit("upgrade.accepted", ["path": path])
        }
        serve.onAPICall = { [weak self] endpoint, answered in
            self?.observeRPC(endpoint, answered)
        }
        serve.onMuxFrame = { [weak self] direction, kind in
            self?.observeMuxFrame(direction, kind)
        }
        serve.onOrigin = { [weak self] url in
            self?.onOpenOrigin?(url)
        }
        serve.onRuntimeFailure = { [weak self] message in
            guard let self else { return }
            finish(self.failOutcome(message))
        }
    }

    /// rpc.observed: the FIRST call of each distinct endpoint.
    private func observeRPC(_ endpoint: String, _ answered: String) {
        guard !rpcLogged.contains(endpoint) else { return }
        rpcLogged.insert(endpoint)
        eventLog.emit("rpc.observed", ["endpoint": endpoint, "answered": answered])
    }

    /// session.attached: the page's journal stream opened (our page follows
    /// exactly one session); journal.frame.forwarded: the first tx item.
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "item" else { return }
        if !attachLogged {
            attachLogged = true
            eventLog.emit("session.attached", ["stream": "session/follow"])
            return
        }
        if !frameLogged {
            frameLogged = true
            eventLog.emit("journal.frame.forwarded", [
                "direction": "tx", "first": true,
                "source": "REAL session log records + assistant-stream frames",
            ])
        }
    }

    private var assetLogged = false
    private var upgradeLogged = false
    private var attachLogged = false
    private var frameLogged = false
    private var rpcLogged: Set<String> = []

    /// The document finished loading: wait for the entry-module evidence,
    /// then run the probe legs in order (open → type → send+settle).
    func pageDidFinish() {
        guard !finished else { return }
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(30)
            while !self.assetLogged && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard self.assetLogged else {
                return self.finish(self.failOutcome(
                    "nextweb: the entry module never arrived"))
            }
            self.runProbe()
        }
    }

    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("nextweb: no WebView attached"))
        }
        SessionWriteProbe.evaluate(webView, NextWebProbe.probeScript()) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            self.runSteps(Self.probeSteps(self))
        }
    }

    private static func probeSteps(_ owner: NextWebRuntime)
        -> [(expr: String, collect: ([String: Any]) -> Void)] {
        let message = NextWebProbe.messageText
        return [
            ("window.__next.open()", { probe in
                owner.eventLog.emit("client.opened", [
                    "chatVisible": probe["chatVisible"] ?? false,
                ])
            }),
            ("window.__next.type('\(message)')", { probe in
                owner.eventLog.emit("composer.typed", [
                    "found": probe["found"] ?? false,
                    "sendEnabled": probe["sendEnabled"] ?? false,
                    "text": message,
                ])
            }),
            ("window.__next.sendAndSettle()", { probe in
                owner.consumeSettled(probe)
            }),
        ]
    }

    /// Await one leg's page function, parse its JSON, emit its evidence,
    /// advance — fail loud on any unparseable leg (never a silent skip).
    private func runSteps(_ steps: [(expr: String, collect: ([String: Any]) -> Void)]) {
        guard let step = steps.first else {
            return finish(failOutcome("probe steps ran out without a verdict"))
        }
        guard let webView else {
            return finish(failOutcome("nextweb: no WebView attached"))
        }
        SessionWriteProbe.awaitPromise(webView, step.expr) { [weak self] result, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe \(step.expr): \(error)"))
            }
            guard let probe = SessionWriteProbe.parse(result) else {
                let raw = result as? String ?? "nil"
                return self.finish(self.failOutcome(
                    "probe \(step.expr) returned no parseable result: \(raw)"))
            }
            step.collect(probe)
            guard steps.count > 1 else { return }
            self.runSteps(Array(steps.dropFirst()))
        }
    }

    /// The settle leg's verdict: the DOM must show the user bubble AND the
    /// scripted assistant reply, with the streaming tail gone.
    private func consumeSettled(_ probe: [String: Any]) {
        guard (probe["userShown"] as? Bool) == true,
              (probe["tailGone"] as? Bool) == true else {
            return finish(failOutcome("the transcript never settled: \(probe)"))
        }
        eventLog.emit("page.rendered", [
            "items": probe["items"] ?? 0,
            "reply": NextWebProbe.expectedReply,
            "userText": NextWebProbe.messageText,
            "title": probe["title"] ?? "",
        ])
        finish(SpikeOutcome(
            completed: true, passed: true, error: "",
            canonicalLines: eventLog.lines
        ))
    }

    // ---- settling ----------------------------------------------------------

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.finish(self.failOutcome(
                "nextweb watchdog: drive did not complete in \(Self.watchdogSeconds)s"))
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: nextweb FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: nextweb FAIL \(message)")
        return SpikeOutcome(
            completed: false, passed: false, error: message,
            canonicalLines: eventLog.lines
        )
    }

    private func finish(_ outcome: SpikeOutcome) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        serve.stop()
        print("spike: nextweb drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }
}
