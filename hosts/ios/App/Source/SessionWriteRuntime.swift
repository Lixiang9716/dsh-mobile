import Foundation
import WebKit

/// Drives `b4.write.live` (the W-RPC leg, decision D9): the upstream spine
/// answers the OFFICIAL app's WRITE surface. The web-boot producer is
/// composed WITH the write surface (upstream/web-write.js — real
/// session/create, prompt admission, the session/follow + workspace/follow
/// streams, the settings describe), and the page's own composer message —
/// typed through the real UI by the probe — drives a REAL upstream
/// agent-loop turn: user/message → agent-loop events → assistant deltas →
/// turn/end, streamed live over the mux journal and rendered in the
/// official UI. The llm transport stays the carrier's SCRIPTED
/// chat-completions endpoint (real HTTP + SSE; the model output is the only
/// scripted part, logged as such). Endpoints the spine does not implement
/// stay structured-unavailable, never faked.
///
/// The serving path itself lives in `SessionServe` — the seat a user-facing
/// launch runs with no hooks. This type is the VERIFICATION drive: it holds a
/// seat, turns its hooks into canonical records, drives the page with the
/// probe and decides the verdict. One implementation of the serving path,
/// verified by this manifest and run by users, never two that drift.
final class SessionWriteRuntime {
    static let scenario = "b4.write.live"
    static let clientID = SessionServe.clientID
    static let watchdogSeconds = 180

    /// A DEBUG drive may point the composer's real-model route at an
    /// OpenAI-compatible endpoint from the environment (DSH_E2E_LLM_URL/KEY/
    /// MODEL) — the b4 scenario's documented live route, exercised end to end.
    /// Release keeps `SessionServe()` (no credential ⇒ the scripted loopback).
    private lazy var serve: SessionServe = {
        let env = ProcessInfo.processInfo.environment
        if let url = env["DSH_E2E_LLM_URL"], let key = env["DSH_E2E_LLM_KEY"],
           let model = env["DSH_E2E_LLM_MODEL"] {
            return SessionServe(credential: SessionServe.LlmCredential(
                baseUrl: url, apiKey: key, model: model,
                provider: env["DSH_E2E_LLM_PROVIDER"] ?? "openai-compatible"))
        }
        return SessionServe()
    }()
    private let eventLog = CarrierEventLog(scenario: SessionWriteRuntime.scenario)
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
        // The first record in the manifest: the configuration selected the
        // official client. Emitted before the carrier starts, so it precedes
        // every runtime-side record the boot emits.
        eventLog.emit("client.selected", ["client": Self.clientID, "source": "launch"])
        do {
            try serve.start()
        } catch {
            finish(failOutcome("session-write bootstrap: \(error)"))
        }
    }

    /// Turns the seat's serving facts into the canonical records the manifest
    /// pins. Every hook is called exactly where the serving seat performs the
    /// act, so the record order is unchanged by the split; the once-guards
    /// stay here, where the evidence lives (the UI's later calls are wire
    /// traffic, served the same way without another record).
    private func wireEvidence() {
        serve.onIndexRendered = { [weak self] rows, bytes in
            self?.eventLog.emit("index.rendered", ["rows": rows, "bytes": bytes])
        }
        serve.onIndexServed = { [weak self] in
            self?.eventLog.emit("index.served", ["path": "/", "status": 200])
        }
        serve.onAssetServed = { [weak self] path in
            self?.observeAsset(path)
        }
        serve.onComboServed = { [weak self] url, bytes in
            self?.observeCombo(url, bytes: bytes)
        }
        serve.onUpgradeAccepted = { [weak self] path in
            guard let self, !self.upgradeLogged else { return }
            self.upgradeLogged = true
            self.eventLog.emit("upgrade.accepted", ["path": path])
        }
        serve.onAPICall = { [weak self] endpoint, answered in
            self?.observeRPC(endpoint, answered)
        }
        serve.onMuxFrame = { [weak self] direction, kind in
            self?.observeMuxFrame(direction, kind)
        }
        serve.onWebBootApplied = { [weak self] rows, source in
            self?.eventLog.emit("web.boot.applied", ["rows": rows, "source": source])
        }
        serve.onOrigin = { [weak self] url in
            self?.onOpenOrigin?(url)
        }
        serve.onRuntimeFailure = { [weak self] message in
            guard let self else { return }
            self.finish(self.failOutcome(message))
        }
        serve.onRuntimeSettled = { [weak self] passed, message in
            guard let self, !passed else { return }
            self.finish(self.failOutcome("runtime scenario failed: \(message)"))
        }
    }

    /// rpc.observed: the FIRST call of each distinct endpoint.
    private func observeRPC(_ endpoint: String, _ answered: String) {
        guard !rpcLogged.contains(endpoint) else { return }
        rpcLogged.insert(endpoint)
        eventLog.emit("rpc.observed", ["endpoint": endpoint, "answered": answered])
    }

    /// The first tx item frame line for the journal leg.
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "item", !frameLogged else { return }
        frameLogged = true
        eventLog.emit("journal.frame.forwarded", [
            "direction": "tx", "first": true,
            "source": "REAL session log records + assistant-stream frames",
        ])
    }

    // ---- page lifecycle + probe -----------------------------------------------

    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: (String, Int)?
    private var upgradeLogged = false
    private var frameLogged = false
    private var rpcLogged: Set<String> = []

    private func observeAsset(_ path: String) {
        guard path.hasPrefix("/assets/index-"), !assetLogged else { return }
        assetLogged = true
        eventLog.emit("asset.served", ["path": path])
        guard let combo = comboPending, !comboLogged else { return }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": combo.0, "bytes": combo.1])
    }

    private func observeCombo(_ url: String, bytes: Int) {
        guard !comboLogged else { return }
        guard assetLogged else {
            comboPending = (url, bytes)
            return
        }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": url, "bytes": bytes])
    }

    /// The document finished loading: wait for the entry-chunk evidence,
    /// then run the write probe phases in order (pick → type → send).
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
                    "session-write: the entry chunk never arrived"))
            }
            self.runProbe()
        }
    }

    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("session-write: no WebView attached"))
        }
        SessionWriteProbe.evaluate(webView, SessionWriteProbe.probeScript()) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            self.runSteps(Self.probeSteps(self))
        }
    }

    /// The ordered write-path steps: pick the workspace, type into the
    /// composer, send — each collector emits its evidence event.
    private static func probeSteps(_ owner: SessionWriteRuntime)
        -> [(expr: String, collect: ([String: Any]) -> Void)] {
        let message = SessionWriteProbe.messageText
        return [
            ("window.__b4.pick()", { probe in
                owner.eventLog.emit("workspace.picked", [
                    "composer": probe["composer"] ?? false,
                    "dismissed": probe["dismissed"] ?? 0,
                    "notice": probe["notice"] ?? false,
                    "buttons": probe["buttonTexts"] ?? [],
                    "bodyText": probe["bodyText"] as? String ?? "",
                ])
            }),
            ("window.__b4.type('\(message)')", { probe in
                owner.eventLog.emit("composer.typed", [
                    "found": probe["found"] ?? "none",
                    "className": probe["className"] ?? "",
                    "editable": probe["editable"] ?? false,
                    "value": probe["value"] ?? "",
                    "text": message,
                    "buttons": probe["buttons"] ?? [],
                    "active": probe["active"] ?? "none",
                ])
            }),
            ("window.__b4.send()", { probe in
                owner.consumeSend(probe)
            }),
        ]
    }

    /// Await the head step's page function, parse its JSON, emit its event,
    /// advance — fail-loud on any unparseable leg (never a silent skip).
    private func runSteps(_ steps: [(expr: String, collect: ([String: Any]) -> Void)]) {
        guard let step = steps.first else {
            return finish(failOutcome("probe steps ran out without a verdict"))
        }
        guard let webView else {
            return finish(failOutcome("session-write: no WebView attached"))
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

    /// The send leg's verdict: the official DOM must show the typed user
    /// message AND the scripted assistant reply.
    private func consumeSend(_ probe: [String: Any]) {
        guard (probe["sent"] as? Bool) == true else {
            return finish(failOutcome("probe send never fired"))
        }
        let page = probe["page"] as? [String: Any] ?? [:]
        let shapes = probe["frameShapes"] as? [String] ?? []
        eventLog.emit("write.follow.frames", [
            "frames": probe["frames"] ?? 0,
            "shapes": shapes,
            "sessionId": probe["sessionId"] ?? "",
        ])
        guard (probe["reply"] as? Bool) == true else {
            return finish(failOutcome(
                "the assistant reply never rendered; frames: \(shapes.count); bodyText: "
                    + "\((page["bodyText"] as? String ?? "").prefix(200))"))
        }
        eventLog.emit("write.reply.rendered", [
            "reply": SessionWriteProbe.expectedReply,
            "userText": SessionWriteProbe.messageText,
            "moduleMode": "live",
            "bodyText": (page["bodyText"] as? String ?? "")
                .replacingOccurrences(of: "\n", with: " "),
        ])
        finish(SpikeOutcome(
            completed: true, passed: true, error: "",
            canonicalLines: eventLog.lines
        ))
    }

    // ---- settling ---------------------------------------------------------------

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.finish(self.failOutcome(
                "session-write watchdog: drive did not complete in \(Self.watchdogSeconds)s"))
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: session-write FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: session-write FAIL \(message)")
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
        print("spike: session-write drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }
}
