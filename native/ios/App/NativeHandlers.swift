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
                "commit": .string(settings.commit),
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

        // Signing out ends every session and the platform forgets this person's devices: forget
        // the Google session, this device's key and the badge here too.
        router.register("auth.signedOut") { @MainActor [weak shell] _ in
            GIDSignIn.sharedInstance.signOut()
            DeviceKeychain.clear()
            await shell?.push.setBadge(0)
            return .object([:])
        }

        router.register("push.status") { @MainActor [weak shell] _ in
            guard let shell else { throw BridgeError(.failed, "The app is closing") }
            return .object([
                "permission": .string(await shell.push.permission()),
                "deviceId": DeviceKeychain.deviceId.map { JSONValue.string($0) } ?? JSONValue.null,
            ])
        }

        // The page registers the token with its own session (POST /devices), then hands back the
        // platform's device id and secret for the Keychain.
        router.register("push.register") { @MainActor [weak shell] _ in
            guard let shell else { throw BridgeError(.failed, "The app is closing") }
            return try await shell.push.register()
        }

        router.register("push.saveDevice") { @MainActor args in
            guard let id = args["id"]?.stringValue, !id.isEmpty, let secret = args["secret"]?.stringValue, !secret.isEmpty else {
                throw BridgeError(.failed, "\"id\" and \"secret\" are required")
            }
            try DeviceKeychain.save(id: id, secret: secret)
            return .object([:])
        }

        router.register("badge.set") { @MainActor [weak shell] args in
            guard case .number(let count)? = args["count"] else { throw BridgeError(.failed, "\"count\" is required") }
            await shell?.push.setBadge(Int(count))
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
