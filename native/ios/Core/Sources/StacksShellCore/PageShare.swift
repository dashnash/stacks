import Foundation

/// What the Share button shares: a link, and the title and text that go with it.
public struct ShareTarget: Equatable {
    public let url: URL
    public let title: String?
    public let text: String?

    public init(url: URL, title: String?, text: String?) {
        self.url = url
        self.title = title
        self.text = text
    }
}

/// The app's own Share button (#61): every page of ours can be shared, by default as its URL and
/// title. A page may change that or hide the button (`share.page`), but only for the URL it was
/// on when it asked: once the main frame's URL changes (a hash route, `pushState`, another page)
/// the button goes back to the default until the page asks again, so a setting never outlives
/// the page it was made for.
public struct PageShare: Equatable {
    public static let maxTextLength = 2000

    struct Setting: Equatable {
        let page: String
        let url: URL?
        let title: String?
        let text: String?
        let hidden: Bool
    }

    public let policy: NavigationPolicy
    private(set) var setting: Setting?

    public init(policy: NavigationPolicy) {
        self.policy = policy
    }

    /// `share.page` from the page: `{ page, url?, title?, text?, hidden? }`.
    public mutating func set(_ args: [String: JSONValue]) throws {
        guard let page = args["page"]?.stringValue, let pageURL = URL(string: page) else {
            throw BridgeError(.failed, "share.page needs the page's URL (location.href)")
        }
        var url: URL?
        if let raw = args["url"]?.stringValue {
            guard let u = URL(string: raw), u.scheme?.lowercased() == "https", u.host != nil else {
                throw BridgeError(.failed, "share.page shares https links only")
            }
            url = u
        }
        let title = try Self.text(args["title"], "title")
        let text = try Self.text(args["text"], "text")
        var hidden = false
        if let h = args["hidden"] {
            guard case .bool(let b) = h else { throw BridgeError(.failed, "share.page: hidden is true or false") }
            hidden = b
        }
        setting = Setting(page: Self.key(pageURL), url: url, title: title, text: text, hidden: hidden)
    }

    /// A new document: whatever the last one asked for is gone.
    public mutating func clear() {
        setting = nil
    }

    /// Does the button show on this page?
    public func isVisible(on current: URL?) -> Bool {
        guard let current, isOurs(current) else { return false }
        return !(applying(to: current)?.hidden ?? false)
    }

    /// What the button shares on this page (`title` is the page's own), or nil when it's hidden.
    public func target(on current: URL?, title: String?) -> ShareTarget? {
        guard let current, isVisible(on: current) else { return nil }
        let s = applying(to: current)
        // Nobody should share a sign-in link (it only works once, in the browser that started it):
        // share the app it was signing in to.
        let url = s?.url ?? (policy.isSignInPlumbing(current) ? policy.handoffURL(current) : current)
        let pageTitle = title.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        return ShareTarget(url: url, title: s?.title ?? pageTitle, text: s?.text)
    }

    private func applying(to current: URL) -> Setting? {
        guard let s = setting, s.page == Self.key(current) else { return nil }
        return s
    }

    private func isOurs(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host else { return false }
        return policy.isOurHost(host)
    }

    /// The same page however WebKit and the page spell it (`location.href` vs `webView.url`).
    static func key(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        c.scheme = c.scheme?.lowercased()
        c.host = c.host?.lowercased()
        if c.path.isEmpty { c.path = "/" }
        if c.fragment == "" { c.fragment = nil }
        return c.string ?? url.absoluteString
    }

    private static func text(_ value: JSONValue?, _ name: String) throws -> String? {
        guard let value else { return nil }
        guard let s = value.stringValue else { throw BridgeError(.failed, "share.page: \(name) is text") }
        guard s.count <= maxTextLength else { throw BridgeError(.failed, "share.page: \(name) is at most \(maxTextLength) characters") }
        return s
    }
}
