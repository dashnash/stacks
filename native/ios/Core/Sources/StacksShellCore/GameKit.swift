import Foundation

/// The Game kit's rules (native/protocol/v1.json): what the motion, haptics and screen calls take,
/// checked here so they're tested on Linux; the app's handlers only drive the hardware.
public enum GameKit {
    public static let minHz = 10
    public static let maxHz = 100
    public static let sensors = ["userAcceleration", "rotationRate", "gravity", "attitude"]
    public static let impactStyles = ["light", "medium", "heavy", "soft", "rigid"]
    public static let notificationTypes = ["success", "warning", "error"]
    public static let orientations = ["portrait", "landscape", "any"]
    public static let maxPatternEvents = 32
    public static let maxPatternSeconds = 5.0

    public struct MotionStart: Equatable {
        public let hz: Int
        public let sensors: [String]
    }

    /// `motion.start` args: `hz` clamped to 10-100 (default 60), `sensors` known names (default all).
    public static func motionStart(_ args: [String: JSONValue]) throws -> MotionStart {
        var hz = 60
        if case .number(let n)? = args["hz"], n.isFinite { hz = Int(n.rounded()) }
        hz = min(maxHz, max(minHz, hz))
        var picked = sensors
        if case .array(let list)? = args["sensors"], !list.isEmpty {
            let names = list.compactMap { $0.stringValue }
            guard names.count == list.count, names.allSatisfy(sensors.contains) else {
                throw BridgeError(.failed, "\"sensors\" may hold only \(sensors.joined(separator: ", "))")
            }
            picked = sensors.filter(names.contains)
        }
        return MotionStart(hz: hz, sensors: picked)
    }

    public static func channel(_ args: [String: JSONValue]) throws -> String {
        guard let c = args["channel"]?.stringValue, !c.isEmpty else { throw BridgeError(.failed, "\"channel\" is required") }
        return c
    }

    public static func impactStyle(_ args: [String: JSONValue]) throws -> String {
        let style = args["style"]?.stringValue ?? "medium"
        guard impactStyles.contains(style) else { throw BridgeError(.failed, "\"style\" must be one of \(impactStyles.joined(separator: ", "))") }
        return style
    }

    public static func notificationType(_ args: [String: JSONValue]) throws -> String {
        guard let type = args["type"]?.stringValue, notificationTypes.contains(type) else {
            throw BridgeError(.failed, "\"type\" must be one of \(notificationTypes.joined(separator: ", "))")
        }
        return type
    }

    public static func orientation(_ args: [String: JSONValue]) throws -> String {
        guard let o = args["orientation"]?.stringValue, orientations.contains(o) else {
            throw BridgeError(.failed, "\"orientation\" must be one of \(orientations.joined(separator: ", "))")
        }
        return o
    }

    public static func on(_ args: [String: JSONValue]) throws -> Bool {
        guard case .bool(let on)? = args["on"] else { throw BridgeError(.failed, "\"on\" must be true or false") }
        return on
    }

    public struct HapticEvent: Equatable {
        public let t: Double
        public let intensity: Double
        public let sharpness: Double
        /// Continuous when set, else a tap.
        public let duration: Double?
    }

    /// `haptics.pattern` args: 1-32 events, all within 5 s, intensity and sharpness clamped to 0-1.
    public static func pattern(_ args: [String: JSONValue]) throws -> [HapticEvent] {
        guard case .array(let list)? = args["events"], !list.isEmpty else { throw BridgeError(.failed, "\"events\" is required") }
        guard list.count <= maxPatternEvents else { throw BridgeError(.failed, "At most \(maxPatternEvents) events in a pattern") }
        let clamp = { (v: Double) in min(1, max(0, v)) }
        return try list.map { item in
            guard case .object(let e) = item, case .number(let t)? = e["t"], t >= 0 else {
                throw BridgeError(.failed, "Each event needs a time \"t\" (seconds)")
            }
            var intensity = 1.0, sharpness = 0.5
            if case .number(let i)? = e["intensity"] { intensity = clamp(i) }
            if case .number(let s)? = e["sharpness"] { sharpness = clamp(s) }
            var duration: Double?
            if case .number(let d)? = e["duration"], d > 0 { duration = d }
            guard t + (duration ?? 0) <= maxPatternSeconds else { throw BridgeError(.failed, "A pattern lasts at most \(Int(maxPatternSeconds)) s") }
            return HapticEvent(t: t, intensity: intensity, sharpness: sharpness, duration: duration)
        }
    }
}

/// One CoreMotion reading, in its own units (g, rad/s, rad); `t` in seconds since the stream began.
public struct MotionSample: Equatable {
    public var t: Double
    public var userAcceleration: (x: Double, y: Double, z: Double)
    public var rotationRate: (x: Double, y: Double, z: Double)
    public var gravity: (x: Double, y: Double, z: Double)
    public var attitude: (roll: Double, pitch: Double, yaw: Double)

    public init(t: Double, userAcceleration: (Double, Double, Double), rotationRate: (Double, Double, Double), gravity: (Double, Double, Double), attitude: (roll: Double, pitch: Double, yaw: Double)) {
        self.t = t
        self.userAcceleration = (userAcceleration.0, userAcceleration.1, userAcceleration.2)
        self.rotationRate = (rotationRate.0, rotationRate.1, rotationRate.2)
        self.gravity = (gravity.0, gravity.1, gravity.2)
        self.attitude = attitude
    }

    public static func == (a: MotionSample, b: MotionSample) -> Bool {
        a.t == b.t && a.userAcceleration == b.userAcceleration && a.rotationRate == b.rotationRate && a.gravity == b.gravity && a.attitude == b.attitude
    }
}

/// Collects samples between frames and writes them as the protocol's motion batch.
public struct MotionBatcher {
    public let sensors: [String]
    public private(set) var pending: [MotionSample] = []
    private var start: Double?
    /// Batches longer than this drop their oldest samples (the page stalled; old readings are useless).
    public static let maxPending = 200

    public init(sensors: [String] = GameKit.sensors) {
        self.sensors = sensors
    }

    /// Add a reading taken at `timestamp` (seconds, any clock): `t` counts from the first one.
    public mutating func add(timestamp: Double, userAcceleration: (Double, Double, Double), rotationRate: (Double, Double, Double), gravity: (Double, Double, Double), attitude: (roll: Double, pitch: Double, yaw: Double)) {
        if start == nil { start = timestamp }
        pending.append(MotionSample(t: timestamp - (start ?? timestamp), userAcceleration: userAcceleration, rotationRate: rotationRate, gravity: gravity, attitude: attitude))
        if pending.count > Self.maxPending { pending.removeFirst(pending.count - Self.maxPending) }
    }

    /// The pending samples as `{"samples":[...]}`, or nil when there are none; clears them.
    public mutating func flush() -> String? {
        guard !pending.isEmpty else { return nil }
        let samples = pending
        pending.removeAll(keepingCapacity: true)
        return "{\"samples\":[" + samples.map(json).joined(separator: ",") + "]}"
    }

    private func json(_ s: MotionSample) -> String {
        var parts = ["\"t\":\(Self.num(s.t))"]
        for sensor in sensors {
            switch sensor {
            case "userAcceleration": parts.append("\"userAcceleration\":\(Self.vec(s.userAcceleration))")
            case "rotationRate": parts.append("\"rotationRate\":\(Self.vec(s.rotationRate))")
            case "gravity": parts.append("\"gravity\":\(Self.vec(s.gravity))")
            case "attitude": parts.append("\"attitude\":{\"roll\":\(Self.num(s.attitude.roll)),\"pitch\":\(Self.num(s.attitude.pitch)),\"yaw\":\(Self.num(s.attitude.yaw))}")
            default: break
            }
        }
        return "{" + parts.joined(separator: ",") + "}"
    }

    private static func vec(_ v: (x: Double, y: Double, z: Double)) -> String {
        "{\"x\":\(num(v.x)),\"y\":\(num(v.y)),\"z\":\(num(v.z))}"
    }

    /// Five decimals is well under the sensors' noise; non-finite readings become 0.
    static func num(_ v: Double) -> String {
        guard v.isFinite else { return "0" }
        let r = (v * 100_000).rounded() / 100_000
        if r == 0 { return "0" }
        if r == r.rounded(), abs(r) < 1e15 { return String(Int(r)) }
        return String(r)
    }
}
