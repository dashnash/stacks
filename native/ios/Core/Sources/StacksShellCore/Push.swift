import Foundation

/// Push notifications: what the app reads from Apple and from a notification (protocol 1: `push.*`).
public enum Push {
    /// APNs hands the app its token as bytes; the platform takes it as lower-case hex.
    public static func tokenHex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The platform's name for the APNs environment of this build: the `aps-environment`
    /// entitlement is "development" for builds run from Xcode, "production" for TestFlight and the App Store.
    public static func environment(apsEnvironment: String) -> String {
        apsEnvironment == "production" ? "production" : "sandbox"
    }

    /// The page a tapped notification opens: its `url` (the platform sends an absolute https link).
    /// Whether that page opens in the app or in Safari is the navigation policy's call.
    public static func url(from userInfo: [AnyHashable: Any]) -> URL? {
        guard let raw = userInfo["url"] as? String, let url = URL(string: raw), url.scheme == "https", url.host != nil else { return nil }
        return url
    }
}

/// Buttons on a notification (Approve / Deny on an access request). The app sends the press to
/// `POST /api/devices/<id>/actions` with the device's secret, without opening the web view.
public enum PushAction {
    /// The notification category the platform sets on access requests (`aps.category`).
    public static let accessRequestCategory = "ACCESS_REQUEST"
    public static let approveIdentifier = "APPROVE"
    public static let denyIdentifier = "DENY"

    /// The platform's name for a pressed button, or nil for anything else (a plain tap).
    public static func action(forIdentifier identifier: String) -> String? {
        switch identifier {
        case approveIdentifier: return "approve"
        case denyIdentifier: return "deny"
        default: return nil
        }
    }

    /// The single-use token the platform put on this notification for this device.
    public static func token(from userInfo: [AnyHashable: Any]) -> String? {
        guard let token = userInfo["actionToken"] as? String, !token.isEmpty else { return nil }
        return token
    }

    public static func url(authHost: String, deviceId: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.")
        guard let id = deviceId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "https://\(authHost)/api/devices/\(id)/actions")
    }

    public static func body(secret: String, token: String, action: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["secret": secret, "token": token, "action": action], options: [.sortedKeys])
    }
}
