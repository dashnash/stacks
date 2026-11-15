import SafariServices
import StacksShellCore
import UIKit
import WebKit

/// Owns the web view and everything around it: which links stay inside, the bridge, the offline
/// screen, remembering the last page, and asking for an update when the web needs a newer app.
@MainActor
final class Shell: NSObject, ObservableObject {
    static let fallbackSettings = ShellSettings(
        policy: NavigationPolicy(rootDomain: "dashnash.ninja"),
        googleClientID: "",
        googleServerClientID: "",
        appVersion: "0",
        build: "0"
    )

    let settings: ShellSettings
    let webView: WKWebView
    let router: BridgeRouter
    let push: PushRegistrar
    /// What each app declared it may ask for (`native` in /native/config).
    let nativeConfig: NativeConfigStore
    lazy var gameKit = GameKitHardware(shell: self)

    /// Why the last page didn't load (shown as "Can't reach DashyHQ" with a retry), or nil.
    @Published var loadError: String?
    @Published var failedURL: URL?
    /// The web needs a newer app than this one.
    @Published var needsUpdate = false
    /// A game asked for the whole screen (`screen.immersive`): no status bar or home indicator.
    @Published private(set) var immersive = false
    /// What the app may rotate to now (`screen.lockOrientation`); AppDelegate hands it to UIKit.
    var orientationMask: UIInterfaceOrientationMask
    let defaultOrientationMask: UIInterfaceOrientationMask
    private var refreshControl: UIRefreshControl?

    private var lastLoaded: URL?
    private static let lastURLKey = "stacks.lastURL"
    private static let lastURLAtKey = "stacks.lastURLAt"

    init(settings: ShellSettings) {
        self.settings = settings
        push = PushRegistrar(environment: settings.pushEnvironment)
        let nativeConfig = NativeConfigStore(url: settings.nativeConfigURL)
        self.nativeConfig = nativeConfig
        router = BridgeRouter(authHost: settings.policy.authHost, isOurHost: settings.policy.isOurHost, capabilities: { host in
            await nativeConfig.capabilities(forHost: host)
        })
        defaultOrientationMask = UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
        orientationMask = defaultOrientationMask

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // the platform's and apps' cookies, kept across launches
        config.applicationNameForUserAgent = "DashyHQ/\(settings.appVersion) StacksNative/\(BridgeProtocol.version)"
        config.allowsInlineMediaPlayback = true
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: BridgeRouter.injectedScript(appVersion: settings.appVersion), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        content.addScriptMessageHandler(WeakBridgeHandler(self), contentWorld: .page, name: "stacks")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        refreshControl = refresh

        NativeHandlers.register(on: router, shell: self)
        let defaults = UserDefaults.standard
        let start = settings.policy.launchURL(lastURL: defaults.url(forKey: Self.lastURLKey), savedAt: defaults.object(forKey: Self.lastURLAtKey) as? Date)
        webView.load(URLRequest(url: start))
        Task { await checkForUpdate() }
    }

    /// Open a link from outside (a universal link, a notification): ours load here, others in Safari.
    func open(_ link: URL) {
        // A sign-in started in a browser can't finish here: open the app it was for instead.
        let url = settings.policy.handoffURL(link)
        switch settings.policy.decide(url) {
        case .inApp: webView.load(URLRequest(url: url))
        case .safari: present(SFSafariViewController(url: url))
        case .system: UIApplication.shared.open(url)
        case .cancel: break
        }
    }

    func retry() {
        loadError = nil
        if let url = failedURL ?? webView.url { webView.load(URLRequest(url: url)) } else { webView.reload() }
    }

    @objc private func pulledToRefresh() {
        if loadError == nil {
            webView.reload()
        } else {
            retry()
        }
    }

    private func checkForUpdate() async {
        // Offline or an older platform: carry on.
        guard let config = await nativeConfig.current() else { return }
        needsUpdate = config.needsUpdate(appVersion: settings.appVersion)
    }

    /// Back in the app: apps may have changed what they declare since /native/config was read.
    func becameActive() {
        Task { await nativeConfig.forget() }
    }

    /// `screen.immersive`: no status bar, home indicator, swipe-back or pull-to-refresh.
    func setImmersive(_ on: Bool) {
        immersive = on
        webView.allowsBackForwardNavigationGestures = !on
        webView.scrollView.refreshControl = on ? nil : refreshControl
    }

    /// The view controller to present sheets from (the topmost one).
    var presenter: UIViewController? {
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    func present(_ controller: UIViewController) {
        presenter?.present(controller, animated: true)
    }

    private func remember(_ url: URL) {
        guard url.scheme == "https", let host = url.host, settings.policy.isOurHost(host), !settings.policy.isSignInPlumbing(url) else { return }
        UserDefaults.standard.set(url, forKey: Self.lastURLKey)
        UserDefaults.standard.set(Date(), forKey: Self.lastURLAtKey)
    }

    private func finishedLoading() {
        webView.scrollView.refreshControl?.endRefreshing()
    }
}

// MARK: - Links

extension Shell: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        switch settings.policy.decide(url) {
        case .inApp:
            decisionHandler(.allow)
        case .safari:
            // Embedded content (videos, maps) may load in its frame; a page of its own opens in Safari.
            if mainFrame {
                decisionHandler(.cancel)
                present(SFSafariViewController(url: url))
            } else {
                decisionHandler(.allow)
            }
        case .system:
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 500 {
            failedURL = response.response.url
            loadError = "Stacks is having trouble (error \(http.statusCode))."
        }
        decisionHandler(.allow)
    }

    /// A new page (or a reload) replaced the old one: whatever the old one turned on stops.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        gameKit.reset()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishedLoading()
        if let url = webView.url {
            remember(url)
            if url != failedURL { loadError = nil }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        finishedLoading()
        let e = error as NSError
        // Cancelled loads (a new link tapped mid-load, or a link we sent to Safari) aren't failures.
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // frame load interrupted by our own policy
        failedURL = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        loadError = e.localizedDescription
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        gameKit.reset()
        webView.reload()
    }

    /// The web's own motion events (DeviceMotionEvent, the fallback): only for apps that declared
    /// "motion", and iOS still asks the person.
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host
        let allowedPage = frame.isMainFrame && origin.protocol == "https" && settings.policy.isOurHost(host)
        Task { @MainActor in
            let declared = allowedPage ? await nativeConfig.capabilities(forHost: host).contains("motion") : false
            decisionHandler(declared ? .prompt : .deny)
        }
    }

    /// `target="_blank"` links and `window.open`: ours in this view, others in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { open(url) }
        return nil
    }
}

// MARK: - The bridge

extension Shell {
    func handleBridgeMessage(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let frame = FrameInfo(scheme: origin.protocol, host: origin.host, isMainFrame: message.frameInfo.isMainFrame)
        let body = message.body
        Task { @MainActor in
            let reply = await router.handle(body: body, from: frame)
            replyHandler(reply.json.foundationValue, nil)
        }
    }
}

/// WebKit keeps its message handlers forever; this keeps it from keeping the shell.
final class WeakBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var shell: Shell?

    init(_ shell: Shell) {
        self.shell = shell
    }

    @MainActor
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let shell else { return replyHandler(BridgeReply.error(BridgeError(.failed, "The app is closing")).json.foundationValue, nil) }
        shell.handleBridgeMessage(message, replyHandler: replyHandler)
    }
}
