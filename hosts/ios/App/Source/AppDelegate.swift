import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private var mainWindow: UIWindow?
    private var console: UITextView?
    private var webView: WKWebView?
    private var bootVerdict = "PENDING"
    private var carrierVerdict = "PENDING"
    private var gatewayVerdict = "PENDING"
    /// Strong ref for the session: CarrierRuntime's internal closures are all
    /// weak, so without this the runtime deallocates the moment the queue
    /// drains its first block and the session dies silently.
    private var carrier: CarrierRuntime?
    /// Same for the m2 gateway phase (boot → carrier → gateway, order frozen).
    private var gateway: GatewaySession?
    /// The m2 on-device session phase (session launch mode only).
    private var session: SessionRuntime?
    private var sessionVerdict = "PENDING"
    /// The Phase-B official-web mount drive (`-dsh-mode official-web`).
    private var official: OfficialWebRuntime?
    private var officialVerdict = "PENDING"
    /// The user-facing serving seat (release boot only; no hooks, no drive).
    private var serve: SessionServe?
    /// The release boot's launch surface, held until the page renders.
    private var bootOverlay: UIView?
    private var bootOverlayLabel: UILabel?
    /// The W-SESS session-live drive (`-dsh-mode session-live`).
    private var sessionLive: SessionLiveRuntime?
    private var sessionLiveVerdict = "PENDING"
    /// The W-RPC session-write drive (`-dsh-mode session-write`).
    private var sessionWrite: SessionWriteRuntime?
    private var sessionWriteVerdict = "PENDING"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let root = UIViewController()
        if BuildFlavor.isRelease {
            return bootRelease(window: window, root: root)
        }
        let console = makeConsole(in: window)
        let webView = makeWebView(in: window)
        root.view.addSubview(console)
        root.view.addSubview(webView)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.mainWindow = window
        self.console = console
        self.webView = webView
        startLaunchedMode()
        return true
    }

    /// The harness console: the drive's face, not its verdict (every canonical
    /// line goes to the spike sink; this pane is what a human watches).
    private func makeConsole(in window: UIWindow) -> UITextView {
        let console = UITextView(frame: CGRect(
            x: 16, y: 64,
            width: window.bounds.width - 32,
            height: window.bounds.height * 0.55 - 64
        ))
        console.isEditable = false
        console.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        console.autoresizingMask = [.flexibleWidth, .flexibleBottomMargin]
        console.text = "DSH spikes — boot.verification, carrier.loopback, then the m2 gateway binding …"
        return console
    }

    private func makeWebView(in window: UIWindow) -> WKWebView {
        let webView = WKWebView(frame: CGRect(
            x: 0, y: window.bounds.height * 0.55,
            width: window.bounds.width,
            height: window.bounds.height * 0.45
        ))
        webView.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        return webView
    }

    /// Dispatch on `-dsh-mode`, each drive announcing itself on the console
    /// and in stdout first (the stdout lines are asserted on — they are spelled
    /// out here rather than assembled from `mode`); the default keeps the
    /// historical boot → carrier → gateway sequence.
    private func startLaunchedMode() {
        switch launchMode {
        case "session":
            let surface = sessionSurface
            announce("DSH session — session.mock-llm over the system plugins, \(surface)…",
                     line: "spike: app launched in session mode (\(surface))", web: false)
            runSession()
        case "official-web":
            announce("DSH official web — officialweb.mount, the upstream app on the contract carrier…",
                     line: "spike: app launched in official-web mode", web: true)
            runOfficialWeb()
        case "session-live":
            announce("DSH session live — session.live-read, the upstream spine on-device answering the official app…",
                     line: "spike: app launched in session-live mode", web: true)
            runSessionLive()
        case "session-write":
            announce("DSH session write — composer.live-write, the official composer driving the upstream spine…",
                     line: "spike: app launched in session-write mode", web: true)
            runSessionWrite()
        case "serve":
            // The USER-FACING serving seat with the harness's logging intact:
            // no probe, no watchdog, no evidence hooks — a human drives the
            // page exactly as a user would — but the runtime's own records
            // still print, which is the only way to see what the product path
            // does (a release build drops every debug/info record by design).
            // This is the mode to reproduce a user-visible failure in.
            announce("DSH serve — the user-facing seat, driven by hand (harness logging on)…",
                     line: "spike: app launched in serve mode", web: true)
            runServingBoot()
        default:
            print("spike: app launched, driving boot.verification then carrier.loopback")
            fflush(stdout)
            SpikeRuntime().run { [weak self] boot in
                self?.show(boot, phase: "boot.verification") { self?.bootVerdict = $0 }
                self?.runCarrier()
            }
        }
    }

    /// Console banner + stdout line for one drive; `web` marks the drives that
    /// own the web view's navigation delegate.
    private func announce(_ banner: String, line: String, web: Bool) {
        console?.text = banner
        print(line)
        fflush(stdout)
        if web {
            webView?.navigationDelegate = self
        }
    }

    /// The session drive's user-visible surface, for its banner and its line.
    private var sessionSurface: String {
        SessionLaunchConfig.scenarioName
            .map { "scenario \($0) (real-LLM drive)" }
            ?? SessionLaunchConfig.profileName
                .map { "profile \($0) (config-selected client)" }
            ?? "Web Client \(SessionLaunchConfig.activeWebClient)"
    }

    /// Launch mode from the launch arguments ("-dsh-mode session"): the
    /// default keeps the historical boot → carrier → gateway sequence.
    private var launchMode: String {
        requestedLaunchMode ?? "spikes"
    }

    /// The `-dsh-mode` value, or nil when the flag is absent.
    private var requestedLaunchMode: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-dsh-mode"), at + 1 < args.count else {
            return nil
        }
        return args[at + 1]
    }

    /// The user-facing boot: the official DSH Web Client over a LIVE agent
    /// spine (`SessionServe`), full screen, with no launch arguments
    /// required — workspace picking, the composer, the session streams, the
    /// settings surface and the tool surface all answer. No verification
    /// drive runs, no verdict panel exists, and no per-event E2E record is
    /// produced — the "release" half of AGENTS.md constraint 5 / rules.md
    /// rule L4. A launch that asks for an E2E drive is refused LOUD (rule 5):
    /// this binary has no drives.
    private func bootRelease(window: UIWindow, root: UIViewController) -> Bool {
        if let mode = requestedLaunchMode, mode != "official-web" {
            fatalError("""
                DSHSpike release build: refusing '-dsh-mode \(mode)'. This is the \
                user-facing distribution build — the verification drives, the \
                verdict panel, and the per-event E2E log stream are compiled out \
                (AGENTS.md constraint 5, rules.md rule L4). Build/run the harness \
                variant (dsh-ios-harness) to drive E2E legs.
                """)
        }
        let webView = WKWebView(frame: .zero)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        // The page is a full-bleed app shell with its OWN fixed chrome — a
        // side rail and a tab row — and the vendored dist cannot be edited
        // (D6). It does not opt into edge-to-edge drawing either (`its
        // index.html` carries no `viewport-fit=cover`), so the safe area is
        // the HOST's job: the WebView starts below the status bar / Dynamic
        // Island instead of drawing under them. Measured before this change:
        // the page's own 对话/轨迹 row rendered at the same y as the clock.
        // The bottom stays edge-to-edge on purpose — the page's composer
        // already clears the home indicator, and insetting it would float the
        // composer away from the bottom edge.
        let overlay = makeBootOverlay()
        // The inset above the WebView (and below the page, past the home
        // indicator) is the WINDOW's own background showing through. Left at
        // its default it reads as a black letterbox bar under the status bar,
        // which looks like a defect rather than a safe-area decision — so the
        // chrome around the page is painted to match the app's surface.
        window.backgroundColor = .systemBackground
        root.view.backgroundColor = .systemBackground
        root.view.addSubview(webView)
        root.view.addSubview(overlay)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: root.view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: root.view.bottomAnchor),
            overlay.topAnchor.constraint(equalTo: root.view.topAnchor),
            overlay.leadingAnchor.constraint(equalTo: root.view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: root.view.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: root.view.bottomAnchor),
        ])
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.mainWindow = window
        self.webView = webView
        runServingBoot()
        return true
    }

    /// The launch surface for the user-facing boot: the seat stages the JS
    /// bundle, boots the spine and only then opens the origin, so for the
    /// first seconds the WebView has nothing in it. A blank white screen is
    /// indistinguishable from an app that is idle and working, which is the
    /// worst of both — so the boot owns the screen until the page renders,
    /// and says what happened when it cannot.
    private func makeBootOverlay() -> UIView {
        let overlay = UIView(frame: .zero)
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.backgroundColor = .systemBackground
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        let label = UILabel()
        label.text = "正在启动 DSH…"
        label.font = .preferredFont(forTextStyle: .callout)
        label.textColor = .secondaryLabel
        label.textAlignment = .center
        label.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -32),
        ])
        bootOverlay = overlay
        bootOverlayLabel = label
        return overlay
    }

    /// The page rendered: the boot surface has nothing left to say.
    private func hideBootOverlay() {
        guard let overlay = bootOverlay else { return }
        bootOverlay = nil
        bootOverlayLabel = nil
        UIView.animate(withDuration: 0.2, animations: { overlay.alpha = 0 }) { _ in
            overlay.removeFromSuperview()
        }
    }

    /// A boot that cannot finish leaves the user looking at nothing. Name the
    /// failure on screen — the same strings the Console carries, so the two
    /// channels agree — instead of a white screen that reads as "loading".
    private func showBootFailure(_ reason: String) {
        guard let label = bootOverlayLabel else { return }
        label.text = "启动失败：\(reason)"
        label.textColor = .systemRed
    }

    /// The user-facing serving boot: the `SessionServe` seat, with NO hooks
    /// assigned — the serving facts go nowhere, and the user drives the page.
    /// The seat is the same one `composer.live-write` verifies, so the path the
    /// manifest proves and the path a user runs cannot drift apart.
    private func runServingBoot() {
        let serve = SessionServe(
            credential: SessionServe.loadCredential(),
            interactive: true)
        self.serve = serve
        serve.onOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        // A failure here leaves an inert page, which is indistinguishable
        // from a working-but-idle one. Say so on BOTH channels: the screen
        // (which is what the user is looking at) and the Console (which is
        // what a warn-keeping release build records).
        serve.onRuntimeFailure = { [weak self] message in
            NSLog("%@", "dsh.session.serve: runtime failed: \(message)")
            DispatchQueue.main.async { self?.showBootFailure(message) }
        }
        do {
            try serve.start()
        } catch {
            NSLog("%@", "dsh.session.serve: bootstrap failed: \(error)")
            showBootFailure("\(error)")
        }
    }

    /// The on-device session: the scenario runs behind the mounted Web
    /// Client and starts only once the page is connected (host.info), so
    /// the token deltas stream live into the rendered transcript.
    private func runSession() {
        let session = SessionRuntime()
        self.session = session
        session.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        session.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "session.mock-llm") { self.sessionVerdict = $0 }
            self.session = nil
            // The session runner polls for this terminal marker.
            print("spike: sequence session=\(self.sessionVerdict)")
            fflush(stdout)
        }
    }

    /// The Phase-B official-web mount: the contract carrier serves the
    /// vendored upstream dist; the drive probes the wire + rendered state.
    /// In a release build the same serving stack runs with the evidence
    /// machinery off (no probe, no watchdog, no canonical records).
    private func runOfficialWeb() {
        let official = OfficialWebRuntime(evidence: !BuildFlavor.isRelease)
        self.official = official
        official.attach(webView: webView!)
        official.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        official.run { [weak self] outcome in
            guard let self, !BuildFlavor.isRelease else { return }
            self.show(outcome, phase: "officialweb.mount") { self.officialVerdict = $0 }
            self.official = nil
            print("spike: sequence official-web=\(self.officialVerdict)")
            fflush(stdout)
        }
    }

    /// The W-SESS session-live mount: the spine runs on-device, the claimed
    /// session surface answers the official app, the journal streams real
    /// records.
    private func runSessionLive() {
        let live = SessionLiveRuntime()
        self.sessionLive = live
        live.attach(webView: webView!)
        live.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        live.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "session.live-read") { self.sessionLiveVerdict = $0 }
            self.sessionLive = nil
            print("spike: sequence session-live=\(self.sessionLiveVerdict)")
            fflush(stdout)
        }
    }

    /// The W-RPC session-write mount: the spine answers the official app's
    /// write surface; the probe types into the real composer and the reply
    /// renders in the official UI.
    private func runSessionWrite() {
        let write = SessionWriteRuntime()
        self.sessionWrite = write
        write.attach(webView: webView!)
        write.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        write.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "composer.live-write") { self.sessionWriteVerdict = $0 }
            self.sessionWrite = nil
            print("spike: sequence session-write=\(self.sessionWriteVerdict)")
            fflush(stdout)
        }
    }

    private func runCarrier() {
        let carrier = CarrierRuntime()
        self.carrier = carrier
        carrier.onOpenOrigin = { [weak self] origin in
            self?.webView?.load(URLRequest(url: origin))
        }
        carrier.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "carrier.loopback") { self.carrierVerdict = $0 }
            self.carrier = nil
            self.runGateway()
        }
    }

    /// The m2 phase: the real nine-primitive gateway binding. Its outcome
    /// completes the launch sequence — this is where the final marker prints.
    private func runGateway() {
        let gateway = GatewaySession()
        self.gateway = gateway
        gateway.run { [weak self] outcome in
            guard let self else { return }
            self.show(outcome, phase: "gateway.binding") { self.gatewayVerdict = $0 }
            self.gateway = nil
            // The CI poll waits for this final marker before running the checkers.
            print("spike: sequence boot=\(self.bootVerdict) carrier=\(self.carrierVerdict)"
                + " gateway=\(self.gatewayVerdict)")
            fflush(stdout)
        }
    }

    private func show(
        _ outcome: SpikeOutcome, phase: String, setVerdict: @escaping (String) -> Void
    ) {
        setVerdict(outcome.verdict)
        var text = [
            "DSH spike — \(phase)",
            "engine: \(outcome.engineName) \(outcome.engineVersion)",
            "events logged: \(outcome.canonicalLines.count)",
            "verdict: \(outcome.verdict)",
        ].joined(separator: "\n")
        if !outcome.error.isEmpty {
            text += "\nerror: \(outcome.error)"
            print("spike: error \(outcome.error)")
        }
        console?.text = (console?.text ?? "") + "\n\n" + text
        print("spike: verdict \(outcome.verdict) (\(phase), events logged: \(outcome.canonicalLines.count))")
        fflush(stdout)
    }
}

extension AppDelegate: WKNavigationDelegate {
    /// The official page finished loading: all head subresources have
    /// arrived — the drive emits its mount evidence, probes the wire, and
    /// reads the rendered state. The release boot's launch surface retires
    /// here: the page is what the user asked for.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        official?.pageDidFinish()
        sessionLive?.pageDidFinish()
        sessionWrite?.pageDidFinish()
        hideBootOverlay()
    }

    /// A page that never arrives is the one failure the seat cannot see (the
    /// origin was served, so from the host's side everything worked). Without
    /// this the user keeps looking at "正在启动…" forever with no reason why.
    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showBootFailure(error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
    ) {
        showBootFailure(error.localizedDescription)
    }
}
