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
    static var scenarioName: String? {
        guard let name = arg(after: "-dsh-scenario") else { return nil }
        switch name {
        case "llm-live-stream": return name
        default: fatalError("unknown -dsh-scenario: \(name)")
        }
    }

    /// Staged directory of a Web Client plugin id (fail loud on an unknown
    /// id — the config, not a default, decides).
    static func webClientDir(_ id: String) -> String {
        switch id {
        case "dsh-web-client": return "webclient"
        case "dsh-web-client-mini": return "webclient-mini"
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
