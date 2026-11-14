import StacksShellCore
import UIKit
import UserNotifications

/// What UIKit still routes through an app delegate: the APNs token, and notifications (shown while
/// the app is open; a tap opens the notification's page). It owns the shell, so a tap that
/// launches the app finds it.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let shell = Shell(settings: ShellSettings(info: Bundle.main.infoDictionary ?? [:]) ?? Shell.fallbackSettings)

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Access requests get Approve and Deny; both need the phone unlocked (Face ID).
        let approve = UNNotificationAction(identifier: PushAction.approveIdentifier, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: PushAction.denyIdentifier, title: "Deny", options: [.authenticationRequired, .destructive])
        center.setNotificationCategories([UNNotificationCategory(identifier: PushAction.accessRequestCategory, actions: [approve, deny], intentIdentifiers: [])])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        shell.push.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        shell.push.didFail(error)
    }

    // The completion-handler forms, finished on the main actor. iOS's completion handlers update
    // UIKit (the app snapshot, state restoration) and assert they're called on the main thread; the
    // `async` forms finish on a background thread and crashed on opening a notification (TestFlight
    // crash 2026-11-14: NSAssertionHandler in _performBlockAfterCATransactionCommitSynchronizes).

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor in completionHandler([.banner, .list, .sound, .badge]) }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Read what's needed here (plain values), then do the work and finish on the main actor.
        let info = response.notification.request.content.userInfo
        let action = PushAction.action(forIdentifier: response.actionIdentifier)
        let token = PushAction.token(from: info)
        let url = Push.url(from: info)
        Task { @MainActor in
            if let action {
                await Self.send(action: action, token: token, authHost: self.shell.settings.policy.authHost, fallback: url)
            } else if let url {
                self.shell.open(url)
            }
            completionHandler()
        }
    }

    /// A button press, straight to the platform (the web view stays closed). If it can't be sent, a
    /// local notification says why and opens the request when tapped; the platform itself notifies
    /// about presses it refuses (4xx).
    nonisolated private static func send(action: String, token: String?, authHost: String, fallback: URL?) async {
        guard let token else {
            return await couldNotSend(fallback, title: "Open the request to answer it", body: "This notification can't be answered from the lock screen.")
        }
        guard let device = DeviceKeychain.credentials else {
            return await couldNotSend(fallback, title: "Open DashyHQ once", body: "This phone isn't set up for quick answers yet. Open DashyHQ, then answer the request there.")
        }
        guard let url = PushAction.url(authHost: authHost, deviceId: device.id),
              let body = try? PushAction.body(secret: device.secret, token: token, action: action)
        else { return await couldNotSend(fallback, title: "Couldn't send that", body: "Open the request to answer it.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 30
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            // 4xx: the platform refused it and sends its own notification saying why.
            if let http = response as? HTTPURLResponse, http.statusCode >= 500 {
                await couldNotSend(fallback, title: "DashyHQ had a problem (\(http.statusCode))", body: "It may still have gone through. Open the request to check.")
            }
        } catch let error as URLError where error.code == .timedOut {
            await couldNotSend(fallback, title: "DashyHQ took too long to answer", body: "It may still have gone through. Open the request to check.")
        } catch {
            await couldNotSend(fallback, title: "Couldn't reach DashyHQ", body: "Check your connection, then open the request to answer it.")
        }
    }

    nonisolated private static func couldNotSend(_ url: URL?, title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let url { content.userInfo = ["url": url.absoluteString] }
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
