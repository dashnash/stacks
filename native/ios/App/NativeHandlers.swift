import GoogleSignIn
import StacksShellCore
import UIKit

/// What the app does for a page (protocol 1: native/protocol/v1.json). The router has already
/// checked who is asking: `auth.*` only reaches here from the portal's own page.
@MainActor
enum NativeHandlers {
    static func register(on router: BridgeRouter, shell: Shell) {
        let settings = shell.settings

        router.register("app.info") { @MainActor _ in
            .object([
                "version": .string(settings.appVersion),
                "build": .string(settings.build),
                "platform": .string("ios"),
                "protocol": .number(Double(BridgeProtocol.version)),
            ])
        }

        // Google's sign-in sheet (it shares Safari's Google session: usually one tap). The token is
        // addressed to the platform's web client, which is what the portal's POST /auth/google checks.
        router.register("auth.google") { @MainActor [weak shell] _ in
            guard !settings.googleClientID.isEmpty else {
                throw BridgeError(.unsupported, "Google sign-in isn't set up in this build yet")
            }
            guard let presenter = shell?.presenter else { throw BridgeError(.failed, "Nothing to show the sign-in on") }
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: settings.googleClientID, serverClientID: settings.googleServerClientID)
            do {
                let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
                guard let token = result.user.idToken?.tokenString else { throw BridgeError(.failed, "Google didn't return a sign-in token") }
                return .object(["credential": .string(token)])
            } catch let error as GIDSignInError where error.code == .canceled {
                throw BridgeError(.cancelled, "Sign-in was cancelled")
            }
        }

        router.register("auth.signedOut") { @MainActor _ in
            GIDSignIn.sharedInstance.signOut()
            return .object([:])
        }

        router.register("share") { @MainActor [weak shell] args in
            var items: [Any] = []
            if let text = args["text"]?.stringValue { items.append(text) }
            if let raw = args["url"]?.stringValue, let url = URL(string: raw) { items.append(url) }
            guard !items.isEmpty else { throw BridgeError(.failed, "Nothing to share") }
            guard let shell, let presenter = shell.presenter else { throw BridgeError(.failed, "Nothing to show the share sheet on") }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let title = args["title"]?.stringValue { sheet.title = title }
            // iPad: the sheet is a popover; anchor it mid-screen.
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = shell.webView
                popover.sourceRect = CGRect(x: shell.webView.bounds.midX, y: shell.webView.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            let completed: Bool = await withCheckedContinuation { done in
                sheet.completionWithItemsHandler = { _, completed, _, _ in done.resume(returning: completed) }
                presenter.present(sheet, animated: true)
            }
            return .object(["completed": .bool(completed)])
        }
    }
}
