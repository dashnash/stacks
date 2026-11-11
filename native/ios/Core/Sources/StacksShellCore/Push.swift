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
