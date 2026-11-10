import Foundation

/// Where a link goes: inside the app (our hosts), Safari (everything else on the web), the system
/// (mail, phone, messages, maps), or nowhere.
public enum NavigationDecision: Equatable {
    case inApp
    case safari
    case system
    case cancel
}

public struct NavigationPolicy: Equatable {
    /// This environment's root domain: the portal is `auth.<root>`, apps are `<slug>.<root>`.
    public let rootDomain: String
    /// Roots of other environments under this one (production's `iamdashnash.com` contains staging's
    /// `test.iamdashnash.com`): their links open in Safari, not in this app.
    public let otherRoots: [String]

    public init(rootDomain: String, otherRoots: [String] = []) {
        self.rootDomain = rootDomain.lowercased()
        self.otherRoots = otherRoots.map { $0.lowercased() }
    }

    public var authHost: String { "auth.\(rootDomain)" }
    public var startURL: URL { URL(string: "https://\(authHost)/")! }

    static func matches(_ host: String, _ root: String) -> Bool { host == root || host.hasSuffix(".\(root)") }

    /// Is this one of the platform's hosts in this environment (the portal or an app)?
    public func isOurHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased()
        guard Self.matches(host, rootDomain) else { return false }
        return !otherRoots.contains { Self.matches(host, $0) }
    }

    public func decide(_ url: URL) -> NavigationDecision {
        switch url.scheme?.lowercased() {
        case "https", "http":
            guard let host = url.host else { return .cancel }
            return isOurHost(host) ? .inApp : .safari
        case "mailto", "tel", "sms", "facetime", "maps":
            return .system
        case "about", "blob", "data":
            // In-page plumbing (about:blank frames, downloads made in the page).
            return .inApp
        default:
            return .cancel
        }
    }

    /// Reopen the last page if it was one of ours and seen in the last day; else the portal.
    public func launchURL(lastURL: URL?, savedAt: Date?, now: Date = Date()) -> URL {
        if let url = lastURL, let at = savedAt, now.timeIntervalSince(at) < 24 * 3600, url.scheme == "https", let host = url.host, isOurHost(host) {
            return url
        }
        return startURL
    }
}

/// Dotted versions compared as numbers ("1.10.0" is newer than "1.2.0").
public enum Version {
    public static func atLeast(_ a: String, _ b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let d = (i < pa.count ? pa[i] : 0) - (i < pb.count ? pb[i] : 0)
            if d != 0 { return d > 0 }
        }
        return true
    }
}

/// `GET https://auth.<root>/api/native/config`.
public struct NativeConfig: Codable, Equatable {
    public struct App: Codable, Equatable {
        public let slug: String
        public let name: String
        public let host: String
    }

    public let `protocol`: Int
    public let minShellVersion: String
    public let authHost: String
    public let apps: [App]

    /// Should the app ask to be updated (the web needs a newer app, or a newer bridge)?
    public func needsUpdate(appVersion: String) -> Bool {
        `protocol` > BridgeProtocol.version || !Version.atLeast(appVersion, minShellVersion)
    }
}

/// The app's settings, from its Info.plist (generated per environment from stacks.config.json).
public struct ShellSettings: Equatable {
    public let policy: NavigationPolicy
    /// The iOS OAuth client (empty until it is set up: native Google sign-in then says so).
    public let googleClientID: String
    /// The platform's web client: Google addresses the ID token to it, so the platform accepts it.
    public let googleServerClientID: String
    public let appVersion: String
    public let build: String

    public init(policy: NavigationPolicy, googleClientID: String, googleServerClientID: String, appVersion: String, build: String) {
        self.policy = policy
        self.googleClientID = googleClientID
        self.googleServerClientID = googleServerClientID
        self.appVersion = appVersion
        self.build = build
    }

    /// From Info.plist keys `StacksRootDomain`, `StacksOtherRoots` (comma-separated), `GIDClientID`,
    /// `GIDServerClientID`, `CFBundleShortVersionString`, `CFBundleVersion`. Nil without a root domain.
    public init?(info: [String: Any]) {
        guard let root = (info["StacksRootDomain"] as? String)?.trimmingCharacters(in: .whitespaces), !root.isEmpty else { return nil }
        let others = ((info["StacksOtherRoots"] as? String) ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        self.init(
            policy: NavigationPolicy(rootDomain: root, otherRoots: others),
            googleClientID: (info["GIDClientID"] as? String) ?? "",
            googleServerClientID: (info["GIDServerClientID"] as? String) ?? "",
            appVersion: (info["CFBundleShortVersionString"] as? String) ?? "0",
            build: (info["CFBundleVersion"] as? String) ?? "0"
        )
    }

    public var nativeConfigURL: URL { URL(string: "https://\(policy.authHost)/api/native/config")! }
}
