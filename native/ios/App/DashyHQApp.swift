import GoogleSignIn
import StacksShellCore
import SwiftUI

/// DashyHQ: the Stacks platform in a native shell. Everything people see is the live website; the
/// app adds native sign-in, the share sheet, universal links, push and (later) device features.
@main
struct DashyHQApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    private var shell: Shell { appDelegate.shell }

    var body: some Scene {
        WindowGroup {
            ShellView(shell: shell)
                .ignoresSafeArea(.container, edges: .bottom)
                // Google's sign-in comes back through its URL scheme; any other URL is a link to open.
                .onOpenURL { url in
                    if !GIDSignIn.sharedInstance.handle(url) { shell.open(url) }
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { shell.open(url) }
                }
        }
    }
}
