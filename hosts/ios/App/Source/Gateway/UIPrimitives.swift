import UIKit
import UniformTypeIdentifiers

/// The native UI primitives (contract/primitives.md §4). presentApproval is
/// a UIAlertController (Approve / Decline, plus "Approve & Remember" when
/// allowRemember); presentPicker is a UIDocumentPickerViewController — a
/// FILE pick grants a scope over the parent directory with path =
/// lastPathComponent, a DIRECTORY pick grants the directory itself with
/// path null, and dismissal resolves null granting nothing (user dismissal
/// is a value, never an error). Every automatable surface prints the
/// frozen ui-wait/ui-done stdout markers for the E2E driver.
final class UIPrimitives: NSObject, UIDocumentPickerDelegate {
    private weak var core: GatewayCore?
    private let fs: FSPrimitives
    private let stateLock = NSLock()
    private var pendingPicker: GatewayDone?
    private var pickerMode = "file"

    init(core: GatewayCore, fs: FSPrimitives) {
        self.core = core
        self.fs = fs
        super.init()
        core.register(name: "presentApproval") { call, done in self.approval(call, done) }
        core.register(name: "presentPicker") { call, done in self.picker(call, done) }
    }

    // ---- presentApproval -------------------------------------------------------

    private func approval(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let title = call.string("title") ?? ""
        let detail = call.string("detail")
        let remember = call.bool("allowRemember")
        DispatchQueue.main.async { [weak self] in
            GatewayCore.uiMarker("approval", "wait")
            guard let self, let root = self.rootViewController() else {
                return done(.failure(GatewayError(
                    code: "unavailable", primitive: "presentApproval",
                    message: "no key window to present on")))
            }
            self.presentApprovalAlert(
                root: root, title: title, detail: detail, remember: remember, done: done)
        }
    }

    private func presentApprovalAlert(
        root: UIViewController, title: String, detail: String?,
        remember: Bool, done: @escaping GatewayDone
    ) {
        let alert = UIAlertController(title: title, message: detail, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Approve", style: .default) { _ in
            self.settleApproval(done, approved: true, remember: false)
        })
        if remember {
            alert.addAction(UIAlertAction(title: "Approve & Remember", style: .default) { _ in
                self.settleApproval(done, approved: true, remember: true)
            })
        }
        alert.addAction(UIAlertAction(title: "Decline", style: .cancel) { _ in
            self.settleApproval(done, approved: false, remember: false)
        })
        root.present(alert, animated: true)
    }

    private func settleApproval(
        _ done: @escaping GatewayDone, approved: Bool, remember: Bool
    ) {
        GatewayCore.uiMarker("approval", "done")
        var result: [String: Any] = ["approved": approved]
        if remember { result["remember"] = true }
        done(.success(result))
    }

    // ---- presentPicker ---------------------------------------------------------

    private func picker(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let mode = call.string("mode") == "directory" ? "directory" : "file"
        DispatchQueue.main.async { [weak self] in
            GatewayCore.uiMarker("picker", "wait")
            guard let self, let root = self.rootViewController() else {
                return done(.failure(GatewayError(
                    code: "unavailable", primitive: "presentPicker",
                    message: "no key window to present on")))
            }
            guard self.peekPendingPicker() == nil else {
                return done(.failure(GatewayError(
                    code: "invalid", primitive: "presentPicker",
                    message: "picker already pending")))
            }
            self.putPendingPicker(done, mode: mode)
            self.presentDocumentPicker(root: root, directory: mode == "directory")
        }
    }

    private func presentDocumentPicker(root: UIViewController, directory: Bool) {
        let types: [UTType] = directory ? [.folder] : [.item]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types)
        picker.delegate = self
        root.present(picker, animated: true)
    }

    func documentPicker(
        _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) {
        guard let done = popPendingPicker() else { return }
        let url = urls.first ?? URL(fileURLWithPath: "/")
        let result: [String: Any]
        if pickerMode == "directory" {
            result = ["scope": fs.grantUserScope(url), "path": NSNull()]
        } else {
            let parent = url.deletingLastPathComponent()
            result = ["scope": fs.grantUserScope(parent), "path": url.lastPathComponent]
        }
        GatewayCore.uiMarker("picker", "done")
        done(.success(result))
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let done = popPendingPicker() else { return }
        GatewayCore.uiMarker("picker", "done")
        done(.success(NSNull())) // user dismissal is a value, not an error
    }

    // ---- plumbing --------------------------------------------------------------

    private func rootViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let window = scenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        return window?.rootViewController
    }

    private func peekPendingPicker() -> GatewayDone? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return pendingPicker
    }

    private func popPendingPicker() -> GatewayDone? {
        stateLock.lock()
        defer { stateLock.unlock() }
        let done = pendingPicker
        pendingPicker = nil
        return done
    }

    private func putPendingPicker(_ done: @escaping GatewayDone, mode: String) {
        stateLock.lock()
        pendingPicker = done
        pickerMode = mode
        stateLock.unlock()
    }
}
