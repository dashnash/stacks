import StacksShellCore
import UIKit
import UserNotifications

/// This device and push: the permission, the APNs token, and the platform's device id and secret
/// (Keychain). The portal page drives it through the bridge (`push.*`); see docs/NATIVE_APP_SPEC.md.
@MainActor
final class PushRegistrar {
    private let environment: String
    private var waiting: [CheckedContinuation<Data, Error>] = []
    private var attempt = 0

    init(environment: String) {
        self.environment = environment
    }

    func permission() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "notDetermined"
        }
    }

    /// Ask (iOS shows its prompt only the first time), then get this device's token from APNs.
    func register() async throws -> JSONValue {
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        guard granted else { throw BridgeError(.cancelled, "Notifications are turned off for this app") }
        let token = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            waiting.append(continuation)
            guard waiting.count == 1 else { return }
            attempt += 1
            let this = attempt
            UIApplication.shared.registerForRemoteNotifications()
            // APNs normally answers in a moment; don't leave the page waiting forever.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, self.attempt == this, !self.waiting.isEmpty else { return }
                self.finish(.failure(BridgeError(.failed, "Apple didn't answer the notification registration")))
            }
        }
        return .object([
            "token": .string(Push.tokenHex(token)),
            "env": .string(environment),
            "bundleId": .string(Bundle.main.bundleIdentifier ?? ""),
            "deviceName": .string(UIDevice.current.name),
        ])
    }

    func didRegister(token: Data) {
        finish(.success(token))
    }

    func didFail(_ error: Error) {
        finish(.failure(BridgeError(.failed, "Couldn't register for notifications: \(error.localizedDescription)")))
    }

    private func finish(_ result: Result<Data, Error>) {
        let continuations = waiting
        waiting = []
        attempt += 1
        for c in continuations { c.resume(with: result) }
    }

    /// The icon's number. iOS keeps it until the next push or call.
    func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }
}

/// The platform's id and secret for this device, kept in the Keychain (this device only).
enum DeviceKeychain {
    private static let service = "stacks.device"
    private static let account = "device"

    private struct Stored: Codable {
        let id: String
        let secret: String
    }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func save(id: String, secret: String) throws {
        let data = try JSONEncoder().encode(Stored(id: id, secret: secret))
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw BridgeError(.failed, "Couldn't keep the device key (\(status))") }
    }

    private static func load() -> Stored? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    static var deviceId: String? { load()?.id }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
