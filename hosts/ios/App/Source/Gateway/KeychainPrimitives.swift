import Foundation
import Security

/// keychainGet / keychainSet (contract/primitives.md §4) over SecItem
/// generic-password items: service = bundle id, account = the opaque KeyRef.
/// An unset ref reads as null; `keychainSet(ref, null)` deletes; a set on a
/// missing ref adds, on an existing ref updates. iOS is never "unavailable"
/// here — the descriptor declares keychain* available (conformance §7).
final class KeychainPrimitives {
    private let service: String

    init(core: GatewayCore) {
        service = Bundle.main.bundleIdentifier ?? "org.dsh.DSHSpike"
        core.register(name: "keychainGet") { call, done in self.get(call, done) }
        core.register(name: "keychainSet") { call, done in self.set(call, done) }
    }

    private func query(_ ref: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ref,
        ]
    }

    private func get(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let ref = call.string("ref"), !ref.isEmpty else {
            return done(.failure(Self.invalid("keychainGet", "empty ref")))
        }
        var query = self.query(ref)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return done(.success(NSNull())) }
        guard status == errSecSuccess, let data = item as? Data else {
            return done(.failure(Self.io("keychainGet", status)))
        }
        done(.success(["secretB64": data.base64EncodedString()]))
    }

    private func set(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let ref = call.string("ref"), !ref.isEmpty else {
            return done(.failure(Self.invalid("keychainSet", "empty ref")))
        }
        let secret = call.args["secretB64"]
        if secret == nil || secret is NSNull {
            SecItemDelete(query(ref) as CFDictionary)
            return done(.success(NSNull()))
        }
        guard let data = secret as? String, let bytes = Data(base64Encoded: data) else {
            return done(.failure(Self.invalid("keychainSet", "malformed secretB64")))
        }
        store(ref, bytes: bytes, done)
    }

    private func store(
        _ ref: String, bytes: Data, _ done: @escaping GatewayDone
    ) {
        let update = [kSecValueData as String: bytes]
        let status = SecItemUpdate(query(ref) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return done(.success(NSNull())) }
        guard status == errSecItemNotFound else {
            return done(.failure(Self.io("keychainSet", status)))
        }
        var add = query(ref)
        add[kSecValueData as String] = bytes
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            return done(.failure(Self.io("keychainSet", addStatus)))
        }
        done(.success(NSNull()))
    }

    private static func invalid(_ primitive: String, _ message: String) -> GatewayError {
        GatewayError(code: "invalid", primitive: primitive, message: message)
    }

    private static func io(_ primitive: String, _ status: OSStatus) -> GatewayError {
        GatewayError(code: "io", primitive: primitive,
                     message: "SecItem status \(status)")
    }
}
