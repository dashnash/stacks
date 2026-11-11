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
    /// Sign-in plumbing is never reopened (it only works once, mid-sign-in).
    public func launchURL(lastURL: URL?, savedAt: Date?, now: Date = Date()) -> URL {
        if let url = lastURL, let at = savedAt, now.timeIntervalSince(at) < 24 * 3600, url.scheme == "https", let host = url.host, isOurHost(host), !isSignInPlumbing(url) {
            return url
        }
        return startURL
    }

    /// Pages that only make sense mid-sign-in, in the browser that started it: an app's
    /// `/api/...` (the sign-in callback), the portal's `/authorize` and `/logout`, and the portal's
    /// sign-in page (`/#/signin?next=...`). Never remembered, never opened as a hand-off.
    public func isSignInPlumbing(_ url: URL) -> Bool {
        let path = url.path
        if path == "/api" || path.hasPrefix("/api/") || path == "/authorize" || path == "/logout" { return true }
        if url.host?.lowercased() == authHost, let fragment = url.fragment, fragment.hasPrefix("/signin") { return true }
        return false
    }

    /// A link handed to the app (a universal link, a notification). Sign-in plumbing started in a
    /// browser can't finish here (its state cookie is in that browser), so open the app it was for
    /// instead: it signs in silently with the app's own session. Anything else opens as it is.
    public func handoffURL(_ url: URL) -> URL {
        guard isSignInPlumbing(url) else { return url }
        if let slug = Self.appSlug(signingInTo: url, authHost: authHost), let app = URL(string: "https://\(slug).\(rootDomain)/") { return app }
        if let host = url.host?.lowercased(), host != authHost, isOurHost(host), let app = URL(string: "https://\(host)/") { return app }
        return startURL
    }

    /// The app a sign-in was for: `/authorize?app=<slug>`, or the portal's `#/signin?next=/authorize?app=<slug>...`.
    static func appSlug(signingInTo url: URL, authHost: String) -> String? {
        var authorize: URLComponents?
        if url.path == "/authorize" {
            authorize = URLComponents(url: url, resolvingAgainstBaseURL: false)
        } else if url.host?.lowercased() == authHost, let fragment = url.fragment, let q = fragment.firstIndex(of: "?") {
            let next = URLComponents(string: String(fragment[q...]))?.queryItems?.first { $0.name == "next" }?.value
            authorize = next.flatMap { URLComponents(string: $0) }
            if authorize?.path != "/authorize" { authorize = nil }
        }
        guard let slug = authorize?.queryItems?.first(where: { $0.name == "app" })?.value,
              slug.range(of: "^[a-z0-9][a-z0-9-]{0,39}$", options: .regularExpression) != nil
        else { return nil }
        return slug
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
    /// The APNs environment the platform should push through: "sandbox" or "production".
    public let pushEnvironment: String
    /// The git commit CI built this from (empty for a local Xcode build).
    public let commit: String

    public init(policy: NavigationPolicy, googleClientID: String, googleServerClientID: String, appVersion: String, build: String, pushEnvironment: String = "sandbox", commit: String = "") {
        self.policy = policy
        self.googleClientID = googleClientID
        self.googleServerClientID = googleServerClientID
        self.appVersion = appVersion
        self.build = build
        self.pushEnvironment = pushEnvironment
        self.commit = commit
    }

    /// From Info.plist keys `StacksRootDomain`, `StacksOtherRoots` (comma-separated), `GIDClientID`,
    /// `GIDServerClientID`, `CFBundleShortVersionString`, `CFBundleVersion`, `StacksPushEnvironment`
    /// (the `aps-environment` entitlement's value), `StacksGitCommit`. Nil without a root domain.
    public init?(info: [String: Any]) {
        guard let root = (info["StacksRootDomain"] as? String)?.trimmingCharacters(in: .whitespaces), !root.isEmpty else { return nil }
        let others = ((info["StacksOtherRoots"] as? String) ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        self.init(
            policy: NavigationPolicy(rootDomain: root, otherRoots: others),
            googleClientID: (info["GIDClientID"] as? String) ?? "",
            googleServerClientID: (info["GIDServerClientID"] as? String) ?? "",
            appVersion: (info["CFBundleShortVersionString"] as? String) ?? "0",
            build: (info["CFBundleVersion"] as? String) ?? "0",
            pushEnvironment: Push.environment(apsEnvironment: (info["StacksPushEnvironment"] as? String) ?? ""),
            commit: ((info["StacksGitCommit"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        )
    }

    public var nativeConfigURL: URL { URL(string: "https://\(policy.authHost)/api/native/config")! }
}
