import CoreHaptics
import CoreMotion
import StacksShellCore
import UIKit
import WebKit

/// The Game kit's hardware (native/protocol/v1.json: motion.*, haptics.*, screen.*). The router has
/// already checked that the page's app declared the capability; arguments are checked by
/// `GameKit` in Core. Everything here is undone by `reset()` when the page goes away.
@MainActor
final class GameKitHardware {
    private weak var shell: Shell?
    private let motion = CMMotionManager()
    private var channel: String?
    private var hz = 60
    private var batcher = MotionBatcher()
    private var link: CADisplayLink?
    private var streams = 0
    private var engine: CHHapticEngine?
    private var observers: [NSObjectProtocol] = []

    init(shell: Shell) {
        self.shell = shell
        let center = NotificationCenter.default
        // Motion pauses while the app is in the background and picks up again when it's back.
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.motion.stopDeviceMotionUpdates() }
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.channel != nil { self?.resumeMotion() } }
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: Motion

    func startMotion(_ start: GameKit.MotionStart) throws -> JSONValue {
        guard motion.isDeviceMotionAvailable else { throw BridgeError(.unsupported, "This device has no motion sensors") }
        stopMotion()
        streams += 1
        let id = "motion-\(streams)"
        channel = id
        hz = start.hz
        batcher = MotionBatcher(sensors: start.sensors)
        resumeMotion()
        let link = CADisplayLink(target: DisplayLinkTarget(self), selector: #selector(DisplayLinkTarget.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
        return .object(["channel": .string(id), "hz": .number(Double(start.hz))])
    }

    func stopMotion(channel id: String) {
        if id == channel { stopMotion() }
    }

    func stopMotion() {
        motion.stopDeviceMotionUpdates()
        link?.invalidate()
        link = nil
        channel = nil
        _ = batcher.flush()
    }

    private func resumeMotion() {
        motion.deviceMotionUpdateInterval = 1.0 / Double(hz)
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let d = data else { return }
            MainActor.assumeIsolated {
                self?.batcher.add(
                    timestamp: d.timestamp,
                    userAcceleration: (d.userAcceleration.x, d.userAcceleration.y, d.userAcceleration.z),
                    rotationRate: (d.rotationRate.x, d.rotationRate.y, d.rotationRate.z),
                    gravity: (d.gravity.x, d.gravity.y, d.gravity.z),
                    attitude: (roll: d.attitude.roll, pitch: d.attitude.pitch, yaw: d.attitude.yaw)
                )
            }
        }
    }

    /// Once per display frame: everything since the last one, to the page.
    fileprivate func flush() {
        guard let channel, let json = batcher.flush(), let webView = shell?.webView else { return }
        webView.evaluateJavaScript(BridgeRouter.emitScript(channel: channel, payloadJSON: json), completionHandler: nil)
    }

    // MARK: Haptics

    func impact(_ style: String) {
        let s: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case "light": s = .light
        case "heavy": s = .heavy
        case "soft": s = .soft
        case "rigid": s = .rigid
        default: s = .medium
        }
        UIImpactFeedbackGenerator(style: s).impactOccurred()
    }

    func notification(_ type: String) {
        let t: UINotificationFeedbackGenerator.FeedbackType = type == "success" ? .success : type == "warning" ? .warning : .error
        UINotificationFeedbackGenerator().notificationOccurred(t)
    }

    func pattern(_ events: [GameKit.HapticEvent]) throws {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            throw BridgeError(.unsupported, "This device can't play haptic patterns")
        }
        do {
            if engine == nil {
                let e = try CHHapticEngine()
                e.isAutoShutdownEnabled = true
                e.resetHandler = { [weak self] in Task { @MainActor in self?.engine = nil } }
                e.stoppedHandler = { [weak self] _ in Task { @MainActor in self?.engine = nil } }
                engine = e
            }
            guard let engine else { return }
            try engine.start()
            let haptics = events.map { e in
                CHHapticEvent(
                    eventType: e.duration == nil ? .hapticTransient : .hapticContinuous,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(e.intensity)),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(e.sharpness)),
                    ],
                    relativeTime: e.t,
                    duration: e.duration ?? 0
                )
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: haptics, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch let e as BridgeError {
            throw e
        } catch {
            throw BridgeError(.failed, "Couldn't play the pattern: \(error.localizedDescription)")
        }
    }

    // MARK: Screen

    func lockOrientation(_ orientation: String) {
        guard let shell else { return }
        let any: UIInterfaceOrientationMask = UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
        shell.orientationMask = orientation == "portrait" ? .portrait : orientation == "landscape" ? .landscape : any
        if let scene = shell.webView.window?.windowScene {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: shell.orientationMask)) { _ in }
            for window in scene.windows { window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
        }
    }

    func immersive(_ on: Bool) {
        shell?.setImmersive(on)
    }

    func keepAwake(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on
    }

    /// The page went away (a new page, a reload, another app): stop and undo everything.
    func reset() {
        if channel != nil { stopMotion() }
        if shell?.immersive == true { immersive(false) }
        if shell?.orientationMask != shell?.defaultOrientationMask { lockOrientation("any") }
        if UIApplication.shared.isIdleTimerDisabled { keepAwake(false) }
    }
}

/// CADisplayLink keeps its target; this keeps it from keeping the hardware.
@MainActor
private final class DisplayLinkTarget: NSObject {
    private weak var hardware: GameKitHardware?

    init(_ hardware: GameKitHardware) {
        self.hardware = hardware
    }

    @objc func tick() {
        hardware?.flush()
    }
}

/// `GET /native/config`: which hosts declared which capabilities. Read at launch and again after
/// coming back to the app; before refusing a call it is read again if the copy is more than 10 s
/// old (`NativeConfigCache`), so an app deployed while DashyHQ was open works without a relaunch.
/// Never from the phone's HTTP cache (the platform says max-age=300).
actor NativeConfigStore {
    private let url: URL
    private var cache = NativeConfigCache()
    private var loading: Task<NativeConfig?, Never>?

    init(url: URL) {
        self.url = url
    }

    func current() async -> NativeConfig? {
        if cache.config == nil || cache.fetchedAt == nil { await fetch() }
        return cache.config
    }

    func allows(host: String, capability: String) async -> Bool {
        if cache.needsFetch(host: host, capability: capability, now: Date()) { await fetch() }
        return cache.allows(host: host, capability: capability)
    }

    /// Apps may have changed what they declare: read it again on the next call.
    func forget() {
        cache.expire()
    }

    private func fetch() async {
        if let loading {
            _ = await loading.value
            return
        }
        let url = url
        let task = Task<NativeConfig?, Never> {
            do {
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                let (data, _) = try await URLSession.shared.data(for: request)
                return try JSONDecoder().decode(NativeConfig.self, from: data)
            } catch {
                return nil
            }
        }
        loading = task
        let result = await task.value
        loading = nil
        if let result { cache.stored(result, at: Date()) } else { cache.failed(at: Date()) }
    }
}
