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

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        if let action = PushAction.action(forIdentifier: response.actionIdentifier) {
            let token = PushAction.token(from: info)
            let fallback = Push.url(from: info)
            let host = await MainActor.run { self.shell.settings.policy.authHost }
            await Self.send(action: action, token: token, authHost: host, fallback: fallback)
            return
        }
        guard let url = Push.url(from: info) else { return }
        await MainActor.run { self.shell.open(url) }
    }

    /// A button press, straight to the platform (the web view stays closed). If it can't be sent, a
    /// local notification says so and opens the request when tapped; the platform itself notifies
    /// about presses it refuses.
    nonisolated private static func send(action: String, token: String?, authHost: String, fallback: URL?) async {
        guard let token, let device = DeviceKeychain.credentials, let url = PushAction.url(authHost: authHost, deviceId: device.id),
              let body = try? PushAction.body(secret: device.secret, token: token, action: action)
        else { return await couldNotSend(fallback) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 20
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            // 4xx: the platform refused it and sends its own notification saying why.
            if let http = response as? HTTPURLResponse, http.statusCode >= 500 { await couldNotSend(fallback) }
        } catch {
            await couldNotSend(fallback)
        }
    }

    nonisolated private static func couldNotSend(_ url: URL?) async {
        let content = UNMutableNotificationContent()
        content.title = "Couldn't reach Stacks"
        content.body = "Open the request to answer it."
        if let url { content.userInfo = ["url": url.absoluteString] }
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

// Runner verification: no behaviour change (ios-runner-verify branch, closed after the run).
