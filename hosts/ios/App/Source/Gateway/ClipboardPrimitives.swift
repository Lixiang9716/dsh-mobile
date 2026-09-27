import UIKit

/// The v1.5.0 clipboard pair (permission `clipboard`). The read direction is
/// the exfiltration direction, so clipboardRead is approval-gated by default:
/// the call surfaces the SAME alert presentApproval uses (Approve /
/// Approve & Remember / Decline) unless the user already granted a standing
/// one ("Approve & Remember" persists in UserDefaults). The audit record for
/// a read carries the call only — never the text; the write audits kind +
/// length (contract §6).
final class ClipboardPrimitives {
    /// The standing-grant key. A host-scoped boolean: one approval covers the
    /// install, revocable by deleting the app (the user policy surface).
    static let standingGrantKey = "dsh.clipboard.read.granted"

    private weak var core: GatewayCore?

    init(core: GatewayCore) {
        self.core = core
        core.register(name: "clipboardRead") { call, done in self.read(call, done) }
        core.register(name: "clipboardWrite") { call, done in self.write(call, done) }
    }

    // ---- clipboardRead (approval-gated by default) ---------------------------

    private func read(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard standingGrant() else { return requestApproval(call, done) }
        settleRead(done)
    }

    /// The approval surface (same alert as presentApproval); approval settles
    /// the read, decline settles `{}`-shaped null WITHOUT touching the
    /// pasteboard — the user refused, and a refusal is a value, not an error.
    private func requestApproval(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        DispatchQueue.main.async { [weak self] in
            GatewayCore.uiMarker("clipboard-read", "wait")
            guard let self, let root = self.rootViewController() else {
                return done(.failure(GatewayError(
                    code: "unavailable", primitive: "clipboardRead",
                    message: "no key window to present the approval on")))
            }
            self.presentAlert(root: root, call: call, done: done)
        }
    }

    private func presentAlert(
        root: UIViewController, call: GatewayCall, done: @escaping GatewayDone
    ) {
        let alert = UIAlertController(
            title: call.string("title") ?? "Allow clipboard read?",
            message: call.string("detail")
                ?? "The agent wants to read the clipboard. Approve once, always, or decline.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Approve", style: .default) { _ in
            self.settleRead(done)
        })
        alert.addAction(UIAlertAction(title: "Approve & Remember", style: .default) { _ in
            UserDefaults.standard.set(true, forKey: Self.standingGrantKey)
            self.settleRead(done)
        })
        alert.addAction(UIAlertAction(title: "Decline", style: .cancel) { _ in
            GatewayCore.uiMarker("clipboard-read", "done")
            done(.success(NSNull()))
        })
        root.present(alert, animated: true)
    }

    /// The pasteboard read + settle, after consent. Empty/non-text is null.
    private func settleRead(_ done: @escaping GatewayDone) {
        GatewayCore.uiMarker("clipboard-read", "done")
        if let text = UIPasteboard.general.string {
            done(.success(["kind": "text", "text": text]))
        } else {
            done(.success(NSNull()))
        }
    }

    private func standingGrant() -> Bool {
        UserDefaults.standard.bool(forKey: Self.standingGrantKey)
    }

    // ---- clipboardWrite ------------------------------------------------------

    private func write(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let text = call.string("text") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "clipboardWrite",
                message: "text missing")))
        }
        UIPasteboard.general.string = text
        core?.stageAuditDetail(["kind": "text", "length": text.count])
        done(.success(NSNull()))
    }

    private func rootViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let window = scenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        return window?.rootViewController
    }
}
