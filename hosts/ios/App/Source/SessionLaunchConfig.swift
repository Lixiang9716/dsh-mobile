import Foundation

/// Launch-argument configuration for the session drive (`-dsh-*` args), in
/// one place so the drive itself stays about the carrier + runtime. Every
/// value is fail-loud on an unknown name — the launch configuration, not a
/// default, decides (rule 5).
enum SessionLaunchConfig {

    /// Host configuration: which Web Client plugin is ACTIVE (presentation/
    /// is pluggable; the host mounts exactly one). Overridable for E2E via
    /// launch argument `-dsh-web-client <id>`; the staged bundle carries the
    /// plugin under its own directory. Selecting the mini client also flips
    /// the carrier-side evidence to scenario `ui.client-swap` (M3 UI-swap E2E).
    static var activeWebClient: String {
        arg(after: "-dsh-web-client") ?? "dsh-web-client"
    }

    /// M3 config layer (ARCHITECTURE.md §6 UI-plugin level 1): `-dsh-profile
    /// <name>` selects the staged `profiles/<name>/cordis.patch.json` whose
    /// layered override (base → hostFace → profile) decides the ACTIVE Web
    /// Client and the toolbar slot allow-set. The carrier-side evidence
    /// flips to scenario `install.carrier-evidence` and the drive runs the
    /// `install.from-http` JS scenario (real on-device httpFetch install).
    static var profileName: String? {
        arg(after: "-dsh-profile")
    }

    /// M2 real-LLM drive: `-dsh-scenario llm-live-stream` runs the `llm.live-stream` scenario —
    /// one REAL streaming chat turn through the gateway httpFetch (the
    /// OpenAI-compatible backend; credentials ride fs scope "app", staged by
    /// the E2E runner before launch). Carrier-side evidence flips to scenario
    /// `llm.live-stream.carrier`.
    ///
    /// Upstream-parity drive: `-dsh-scenario upstream-parity` runs the
    /// `upstream.parity` port leg — the vendored upstream spine over scripted
    /// turns, projected record-for-record against the committed Node golden.
    /// The mock endpoint rides the launch environment (DSH_MOCK_LLM_URL /
    /// DSH_MOCK_LLM_KEY, injected by the runner via SIMCTL_CHILD_*; the
    /// simulator shares the host's loopback, so the node-side mock is
    /// reachable at 127.0.0.1).
    ///
    /// Upstream-suite drive: `-dsh-scenario upstream-suite` runs the
    /// `upstream.suite` leg — ONE transpiled upstream DSH spec (loop.spec
    /// & friends) through the quickjs-shaped harness; the spec path rides
    /// the launch environment the same way (DSH_UPSTREAM_SPEC).
    ///
    /// Agent-flow drive: `-dsh-scenario agent-flow` runs the `agent.flow`
    /// leg — the prompt override reaching the captured LLM request, the
    /// fixture skill discovered from the staged dir into the session
    /// catalog, and the `skill` tool returning its instructions through a
    /// real agent-loop tool round. The scripted wire is the same host-side
    /// vendored mock server the parity drive uses (SIMCTL_CHILD_* env).
    static var scenarioName: String? {
        guard let name = arg(after: "-dsh-scenario") else { return nil }
        switch name {
        case "llm-live-stream", "upstream-parity", "upstream-suite", "agent-flow": return name
        default: fatalError("unknown -dsh-scenario: \(name)")
        }
    }

    /// Staged directory of a Web Client plugin id (fail loud on an unknown
    /// id — the config, not a default, decides).
    static func webClientDir(_ id: String) -> String {
        switch id {
        case "dsh-web-client": return "webclient"
        case "dsh-web-client-mini": return "webclient-mini"
        case "dsh-web-client-whale": return "webclient-whale"
        default: fatalError("unknown Web Client plugin id: \(id)")
        }
    }

    /// The value following `-<flag>` in the process arguments, if present.
    private static func arg(after flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: flag), at + 1 < args.count else {
            return nil
        }
        return args[at + 1]
    }
}
