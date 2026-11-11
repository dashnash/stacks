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
        UNUserNotificationCenter.current().delegate = self
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
        guard let url = Push.url(from: response.notification.request.content.userInfo) else { return }
        await MainActor.run { self.shell.open(url) }
    }
}
