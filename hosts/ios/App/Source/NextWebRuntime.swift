import Foundation
import WebKit

/// Drives `nextweb.mount`: the SELF-HOSTED web client (presentation/
/// web-client-next) on the SAME SessionServe seat the user-facing launch
/// runs — selected by the launch configuration (`-dsh-web-client
/// dsh-web-client-next`), served with zero injection rows, speaking the
/// same /api + remote.mux surface. The probe drives OUR page like a user
/// (new session → type → send → stop) through REAL agent-loop turns whose
/// model boundary is the carrier's scripted SSE endpoint; the journal
/// streams live and the page's own timeline fold renders it. One
/// implementation of the serving path, verified by this manifest and run
/// by users — the SessionWriteRuntime shape, mirrored.
///
/// ALL waiting lives on the DRIVE (Swift timers): a driven WKWebView
/// throttles the page's timers to near-zero, so every probe leg is a
/// stateless one-shot evaluate and this type polls the page.
final class NextWebRuntime {
    static let scenario = "nextweb.mount"
    static let clientID = SessionServe.nextClientID
    static let watchdogSeconds = 180
    static let pollSeconds = 60

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
    /// then run the drive phases.
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
            SessionWriteProbe.evaluate(self.webView!, NextWebProbe.probeScript()) { [weak self] _, error in
                guard let self else { return }
                if let error {
                    return self.finish(self.failOutcome("probe setup: \(error)"))
                }
                self.installProbeAndOpen()
            }
        }
    }

    // ---- the drive-side poller ---------------------------------------------

    /// Evaluates `expression` every `intervalSeconds` until its parsed JSON
    /// satisfies `until`, then hands the last parse to `collect`. All timing
    /// is Swift-side; the page only answers stateless one-shot legs.
    private func pollPage(
        _ expression: String,
        intervalSeconds: Double = 0.4,
        until: @escaping ([String: Any]) -> Bool,
        collect: @escaping ([String: Any]) -> Void
    ) {
        guard !finished else { return }
        let deadline = Date().addingTimeInterval(TimeInterval(Self.pollSeconds))
        func tick() {
            guard !finished, let webView else { return }
            if Date() > deadline {
                return finish(failOutcome("page poll timed out: \(expression)"))
            }
            SessionWriteProbe.evaluate(webView, expression) { [weak self] result, error in
                guard let self, !self.finished else { return }
                if let error {
                    return self.finish(self.failOutcome("poll \(expression): \(error)"))
                }
                guard let probe = SessionWriteProbe.parse(result) else {
                    return self.schedule(tick)
                }
                if until(probe) {
                    collect(probe)
                } else {
                    self.schedule(tick)
                }
            }
        }
        schedule(tick)
    }

    private func schedule(_ body: @escaping () -> Void) {
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .milliseconds(400), execute: body)
    }

    // ---- the drive phases ----------------------------------------------------

    private func installProbeAndOpen() {
        SessionWriteProbe.evaluate(webView!, "window.__next.clickNewSession()") { _, _ in }
        pollPage("window.__next.chatVisible()",
            until: { $0["chatVisible"] as? Bool == true },
            collect: { [weak self] _ in
                self?.eventLog.emit("client.opened", ["chatVisible": true])
                self?.typePhase()
        })
    }

    private func typePhase() {
        pollPage("window.__next.typeComposer('\(NextWebProbe.messageText)')",
            until: { $0["sendEnabled"] as? Bool == true },
            collect: { [weak self] probe in
                self?.emitTyped(probe)
        })
    }

    private func emitTyped(_ probe: [String: Any]) {
        eventLog.emit("composer.typed", [
            "found": probe["found"] ?? false,
            "sendEnabled": probe["sendEnabled"] ?? false,
            "text": NextWebProbe.messageText,
        ])
        pressSend()
    }

    /// Press send, then wait for the rendered reply: the DOM must show the
    /// user bubble AND the scripted assistant reply with the streaming tail
    /// gone (the durable message promoted the text).
    private func pressSend() {
        pollPage("window.__next.pressSend()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in
                self?.awaitFirstTurn()
        })
    }

    private func awaitFirstTurn() {
        pollPage("window.__next.readTranscript()",
            until: { probe in
                let replied = (probe["assistant"] as? String ?? "")
                    .contains(NextWebProbe.expectedReply)
                return probe["userShown"] as? Bool == true
                    && probe["tailPresent"] as? Bool == false && replied
            },
            collect: { [weak self] probe in
                self?.eventLog.emit("page.rendered", [
                    "items": probe["items"] ?? 0,
                    "reply": NextWebProbe.expectedReply,
                    "userText": NextWebProbe.messageText,
                    "title": probe["title"] ?? "",
                ])
                self?.beginCancel()
        })
    }

    /// The cancel leg: the stop affordance is OPTIMISTIC (the button morphs
    /// the moment a prompt is admitted — journal frames can arrive as one
    /// burst), so the drive types + sends the slow-marker prompt, polls
    /// until the button is a stop, presses it, and settles on the honest
    /// facts: session/cancel forwarded (bridge evidence) + accepted (the
    /// 已请求停止 toast shows only on ok:true — never a faked success).
    /// Whether the abort raced the turn's last chunk is the vendored
    /// agent-loop's business and is deliberately not pinned here.
    private func beginCancel() {
        pollPage(
            "window.__next.typeComposer('\(NextWebProbe.cancelMessageText)')",
            until: { $0["sendEnabled"] as? Bool == true },
            collect: { [weak self] _ in
                self?.pressSendThenStop()
        })
    }

    private func pressSendThenStop() {
        pollPage("window.__next.pressSend()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in
                self?.awaitStopShape()
        })
    }

    private func awaitStopShape() {
        pollPage("window.__next.stopState()",
            until: { $0["stop"] as? Bool == true },
            collect: { [weak self] _ in
                self?.pressStop()
        })
    }

    private func pressStop() {
        pollPage("window.__next.pressSend()",
            until: { $0["pressed"] as? Bool == true },
            collect: { [weak self] _ in
                self?.eventLog.emit("cancel.stop.pressed", [
                    "stopShown": true, "stopPressed": true,
                ])
                self?.awaitCancelAccepted()
        })
    }

    private func awaitCancelAccepted() {
        pollPage("window.__next.stopState()",
            until: { $0["toast"] as? String == "已请求停止" },
            collect: { [weak self] _ in
                self?.eventLog.emit("cancel.settled", ["accepted": true])
                self?.finish(SpikeOutcome(
                    completed: true, passed: true, error: "",
                    canonicalLines: self?.eventLog.lines ?? []))
        })
    }

    // ---- settling ---------------------------------------------------------------

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
