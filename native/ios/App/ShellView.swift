import SwiftUI
import WebKit

/// The whole app on screen: the web view, with the offline screen or the update notice over it.
struct ShellView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            WebViewContainer(webView: shell.webView)
                .overlay {
                    if let error = shell.loadError {
                        OfflineView(message: error, url: shell.failedURL, retry: shell.retry)
                    }
                }
                .safeAreaInset(edge: .top) {
                    if shell.needsUpdate { UpdateBanner() }
                }
                // The page runs under the home indicator; the Share button stays above it.
                .ignoresSafeArea(.container, edges: .bottom)
            if showsShare {
                ShareButton(dimmed: shell.scrolling, action: shell.sharePage)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showsShare)
        // A game asked for the whole screen (screen.immersive).
        .statusBarHidden(shell.immersive)
        .persistentSystemOverlays(shell.immersive ? .hidden : .automatic)
    }

    /// Every page of ours can be shared, unless it hid the button (`share.page`), a game took the
    /// whole screen, the page didn't load or the keyboard is up.
    private var showsShare: Bool {
        shell.shareAvailable && !shell.immersive && shell.loadError == nil && !shell.keyboardUp
    }
}

private struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// "Can't reach DashyHQ", with what failed and a retry (pull to refresh works too).
private struct OfflineView: View {
    let message: String
    let url: URL?
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("Can't reach DashyHQ").font(.title2.bold())
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
            if let host = url?.host { Text(host).font(.footnote.monospaced()).foregroundStyle(.tertiary) }
            Button("Try again", action: retry).buttonStyle(.borderedProminent)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}

private struct UpdateBanner: View {
    var body: some View {
        Text("A newer DashyHQ is available. Update it from TestFlight or the App Store to keep everything working.")
            .font(.footnote)
            .multilineTextAlignment(.center)
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(.yellow.opacity(0.9))
            .foregroundStyle(.black)
    }
}
