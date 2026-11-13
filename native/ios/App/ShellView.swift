import SwiftUI
import WebKit

/// The whole app on screen: the web view, with the offline screen or the update notice over it.
struct ShellView: View {
    @ObservedObject var shell: Shell

    var body: some View {
        WebViewContainer(webView: shell.webView)
            .overlay {
                if let error = shell.loadError {
                    OfflineView(message: error, url: shell.failedURL, retry: shell.retry)
                }
            }
            .safeAreaInset(edge: .top) {
                if shell.needsUpdate { UpdateBanner() }
            }
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
