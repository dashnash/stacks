import AuthenticationServices
import StacksShellCore
import UIKit

/// The system's Sign in with Apple sheet, for the bridge's `auth.apple`. Returns Apple's identity
/// token (addressed to this app's bundle ID) and the name Apple shares, which it does only the
/// first time someone signs in to the app ("" after that).
@MainActor
final class AppleSignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<JSONValue, Error>?
    private weak var anchor: UIWindow?
    /// Kept alive while the sheet is up (the controller holds its delegate weakly).
    private static var current: AppleSignIn?

    static func run(anchor: UIWindow?) async throws -> JSONValue {
        guard current == nil else { throw BridgeError(.failed, "Sign in with Apple is already open") }
        let flow = AppleSignIn()
        flow.anchor = anchor
        current = flow
        defer { current = nil }
        return try await withCheckedThrowingContinuation { continuation in
            flow.continuation = continuation
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = flow
            controller.presentationContextProvider = flow
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<JSONValue, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let data = credential.identityToken, let token = String(data: data, encoding: .utf8)
            else { return finish(.failure(BridgeError(.failed, "Apple didn't return a sign-in token"))) }
            let name = [credential.fullName?.givenName, credential.fullName?.familyName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            finish(.success(.object(["credential": .string(token), "name": .string(name)])))
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            if let e = error as? ASAuthorizationError, e.code == .canceled {
                finish(.failure(BridgeError(.cancelled, "Sign-in was cancelled")))
            } else {
                finish(.failure(BridgeError(.failed, error.localizedDescription)))
            }
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor ?? ASPresentationAnchor() }
    }
}
