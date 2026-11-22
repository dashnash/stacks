import StacksShellCore
import SwiftUI
import UIKit
import WebKit

/// The Share button on every page (#61): what it shares comes from `PageShare` (Core), which a
/// page can change with `share.page`. It hides in immersive mode, on the offline screen and with
/// the keyboard up, and fades while the page scrolls.
extension Shell {
    /// Sets `--stacks-native-share-inset` so a page with its own bottom-right control can make room.
    static let shareInsetScript = """
    (function () {
      var s = document.createElement("style");
      s.textContent = ":root { --stacks-native-share-inset: \(Int(ShareButton.size + 2 * ShareButton.margin))px; }";
      (document.head || document.documentElement).appendChild(s);
    })();
    """

    func observeForShare() {
        // Hash routes and pushState change the URL without a new document: re-check the setting.
        shareObservers.append(webView.observe(\.url, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.refreshShare() }
        })
        // Not the scroll view's delegate: WKWebView owns that.
        shareObservers.append(webView.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.scrolled() }
        })
        let center = NotificationCenter.default
        center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keyboardUp = true }
        }
        center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keyboardUp = false }
        }
        refreshShare()
    }

    /// Does the button show at all on this page (before immersive, offline and the keyboard)?
    func refreshShare() {
        let visible = pageShare.isVisible(on: webView.url)
        if visible != shareAvailable { shareAvailable = visible }
    }

    /// `share.page` from the page.
    func setPageShare(_ args: [String: JSONValue]) throws {
        try pageShare.set(args)
        refreshShare()
    }

    private func scrolled() {
        if !scrolling { scrolling = true }
        scrollSettle?.cancel()
        scrollSettle = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            if !Task.isCancelled { self?.scrolling = false }
        }
    }

    /// The button was tapped: share this page as it asked (or its URL and title).
    func sharePage() {
        guard let target = pageShare.target(on: webView.url, title: webView.title) else { return }
        var items: [Any] = []
        if let text = target.text { items.append(text) }
        items.append(target.url)
        // iPad: the popover points at the button, in the web view's bottom-trailing corner.
        let inset = webView.safeAreaInsets
        let corner = CGRect(
            x: webView.bounds.maxX - inset.right - ShareButton.margin - ShareButton.size,
            y: webView.bounds.maxY - inset.bottom - ShareButton.margin - ShareButton.size,
            width: ShareButton.size,
            height: ShareButton.size
        )
        Task { _ = try? await presentShareSheet(items: items, title: target.title, anchor: corner, arrows: .any) }
    }

    /// The system share sheet; true when the person shared (false when they backed out).
    func presentShareSheet(items: [Any], title: String?, anchor: CGRect, arrows: UIPopoverArrowDirection) async throws -> Bool {
        guard let presenter else { throw BridgeError(.failed, "Nothing to show the share sheet on") }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let title { sheet.title = title }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = anchor
            popover.permittedArrowDirections = arrows
        }
        return await withCheckedContinuation { done in
            sheet.completionWithItemsHandler = { _, completed, _, _ in done.resume(returning: completed) }
            presenter.present(sheet, animated: true)
        }
    }
}

/// The round Share button at the bottom right.
struct ShareButton: View {
    static let size: CGFloat = 44
    static let margin: CGFloat = 16

    let dimmed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 17, weight: .semibold))
                .offset(y: -1) // the symbol's arrow sits low; centre it by eye
                .frame(width: Self.size, height: Self.size)
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.08)))
                .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .opacity(dimmed ? 0.3 : 1)
        .animation(.easeInOut(duration: 0.2), value: dimmed)
        .padding(Self.margin)
        .accessibilityLabel("Share this page")
    }
}
