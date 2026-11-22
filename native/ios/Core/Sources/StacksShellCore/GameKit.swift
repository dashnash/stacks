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

/// `camera.locate` (native/protocol/v1.json): find codes on a screen with the camera and say which
/// way each is from the phone. Rules and geometry here; the app's `CameraLocator` drives the camera.
public enum CameraKit {
    public static let maxCodes = 8
    public static let maxCodeLength = 200
    public static let maxPromptLength = 120
    /// The codes' centres may move at most this much (a fraction of the image) during a hold.
    public static let steadiness = 0.012

    public struct Locate: Equatable {
        public let codes: [String]
        public let holdMs: Int
        public let timeoutMs: Int
        public let prompt: String?
    }

    /// `camera.locate` args: 1-8 distinct non-empty `codes`; `holdMs` 300-5000 (default 1500);
    /// `timeoutMs` 2000-30000 (default 10000); an optional `prompt` of at most 120 characters.
    public static func locate(_ args: [String: JSONValue]) throws -> Locate {
        guard case .array(let list)? = args["codes"], !list.isEmpty else { throw BridgeError(.failed, "\"codes\" is required") }
        let codes = list.compactMap { $0.stringValue }
        guard codes.count == list.count, codes.allSatisfy({ !$0.isEmpty && $0.count <= maxCodeLength }) else {
            throw BridgeError(.failed, "Each code is a string of 1-\(maxCodeLength) characters")
        }
        guard codes.count <= maxCodes, Set(codes).count == codes.count else { throw BridgeError(.failed, "At most \(maxCodes) different codes") }
        func ms(_ key: String, _ fallback: Int, _ lo: Int, _ hi: Int) -> Int {
            guard case .number(let n)? = args[key], n.isFinite else { return fallback }
            return min(hi, max(lo, Int(n.rounded())))
        }
        var prompt: String?
        if let p = args["prompt"]?.stringValue, !p.isEmpty { prompt = String(p.prefix(maxPromptLength)) }
        return Locate(codes: codes, holdMs: ms("holdMs", 1500, 300, 5000), timeoutMs: ms("timeoutMs", 10_000, 2000, 30_000), prompt: prompt)
    }

    /// A point in the upright (portrait) camera image, 0-1 each way: `u` to the right, `v` up
    /// (Vision's normalized coordinates).
    public struct ImagePoint: Equatable, Sendable {
        public var u: Double
        public var v: Double
        public init(u: Double, v: Double) {
            self.u = u
            self.v = v
        }
    }

    /// The direction from the back camera through an image point, as a unit vector in the phone's
    /// frame (CoreMotion axes: x to the right edge, y to the top edge, z out of the screen; the back
    /// camera looks along -z). `fovLong` is the lens's field of view across the image's long side
    /// (radians; AVFoundation's `videoFieldOfView`), `aspect` the image's short side over its long.
    public static func ray(_ p: ImagePoint, fovLong: Double, aspect: Double) -> (x: Double, y: Double, z: Double) {
        let tanY = tan(fovLong / 2)
        let tanX = tanY * aspect
        let x = (2 * p.u - 1) * tanX
        let y = (2 * p.v - 1) * tanY
        let len = (x * x + y * y + 1).squareRoot()
        return (x / len, y / len, -1 / len)
    }

    /// One camera frame's sightings: each found code's centre and corners.
    public struct Sighting: Equatable, Sendable {
        public var centre: ImagePoint
        public var corners: [ImagePoint]
        public init(centre: ImagePoint, corners: [ImagePoint]) {
            self.centre = centre
            self.corners = corners
        }
    }

    /// Waits for every code to be seen, steadily, for the whole hold.
    public struct Hold {
        public let codes: [String]
        public let holdMs: Int
        private var since: Double?
        private var anchor: [String: ImagePoint] = [:]
        public private(set) var last: [String: Sighting] = [:]

        public init(codes: [String], holdMs: Int) {
            self.codes = codes
            self.holdMs = holdMs
        }

        /// How many of the codes this frame saw.
        public func seen(_ frame: [String: Sighting]) -> Int {
            codes.filter { frame[$0] != nil }.count
        }

        /// Add a frame taken at `t` (seconds). True once all codes have stayed put for `holdMs`.
        public mutating func add(t: Double, _ frame: [String: Sighting]) -> Bool {
            guard seen(frame) == codes.count else {
                since = nil
                return false
            }
            let moved = codes.contains { c in
                guard let a = anchor[c], let p = frame[c]?.centre else { return true }
                return abs(a.u - p.u) > steadiness || abs(a.v - p.v) > steadiness
            }
            if since == nil || moved {
                since = t
                anchor = frame.mapValues { $0.centre }
            }
            last = frame
            return (t - (since ?? t)) * 1000 >= Double(holdMs)
        }
    }

    /// The `camera.locate` result: each code's centre and corners as rays, and the phone's attitude.
    public static func result(_ found: [String: Sighting], fovLong: Double, aspect: Double, attitude: (roll: Double, pitch: Double, yaw: Double)) -> JSONValue {
        func vec(_ p: ImagePoint) -> JSONValue {
            let r = ray(p, fovLong: fovLong, aspect: aspect)
            return .object(["x": .number(r.x), "y": .number(r.y), "z": .number(r.z)])
        }
        var codes: [String: JSONValue] = [:]
        for (code, s) in found {
            codes[code] = .object(["centre": vec(s.centre), "corners": .array(s.corners.map(vec))])
        }
        return .object([
            "found": .object(codes),
            "attitude": .object(["roll": .number(attitude.roll), "pitch": .number(attitude.pitch), "yaw": .number(attitude.yaw)]),
        ])
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
