// Runs `stacks-runner off --now` when this Mac is about to sleep or power off, so GitHub stops
// sending iOS jobs to a Mac that can't run them. Built by `stacks-runner install` on the laptop
// (scripts/mac-runner.sh) and run as a LaunchAgent for the `ci` user. Never built in CI.
import AppKit
import Foundation

let logURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/stacks-runner.log")

func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) sleepwatch: \(message)\n"
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: logURL.path) {
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    }
}

func switchOff() {
    let process = Process()
    let done = DispatchSemaphore(value: 0)
    process.executableURL = URL(fileURLWithPath: "/usr/local/bin/stacks-runner")
    process.arguments = ["off", "--now"]
    process.terminationHandler = { _ in done.signal() }
    do {
        try process.run()
    } catch {
        log("cannot start stacks-runner: \(error)")
        return
    }
    if done.wait(timeout: .now() + 60) == .timedOut {
        log("stacks-runner off did not finish within 60 seconds")
        process.terminate()
    } else {
        log("stacks-runner off exited with status \(process.terminationStatus)")
    }
}

let center = NSWorkspace.shared.notificationCenter
let handler: (Notification) -> Void = { notification in
    log(notification.name.rawValue)
    switchOff()
}
center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil, using: handler)
center.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: nil, using: handler)
log("watching for sleep and power off")
RunLoop.main.run()
