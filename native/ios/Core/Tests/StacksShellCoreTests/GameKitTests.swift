import Foundation
import XCTest
@testable import StacksShellCore

final class GameKitArgsTests: XCTestCase {
    func testMotionStartClampsTheRateAndChecksSensors() throws {
        XCTAssertEqual(try GameKit.motionStart([:]), .init(hz: 60, sensors: GameKit.sensors))
        XCTAssertEqual(try GameKit.motionStart(["hz": .number(250)]).hz, 100)
        XCTAssertEqual(try GameKit.motionStart(["hz": .number(1)]).hz, 10)
        XCTAssertEqual(try GameKit.motionStart(["sensors": .array([.string("attitude"), .string("gravity")])]).sensors, ["gravity", "attitude"])
        XCTAssertThrowsError(try GameKit.motionStart(["sensors": .array([.string("magnetometer")])]))
        XCTAssertThrowsError(try GameKit.motionStart(["sensors": .array([.number(1)])]))
    }

    func testHapticsAndScreenArgs() throws {
        XCTAssertEqual(try GameKit.impactStyle([:]), "medium")
        XCTAssertEqual(try GameKit.impactStyle(["style": .string("rigid")]), "rigid")
        XCTAssertThrowsError(try GameKit.impactStyle(["style": .string("huge")]))
        XCTAssertEqual(try GameKit.notificationType(["type": .string("error")]), "error")
        XCTAssertThrowsError(try GameKit.notificationType([:]))
        XCTAssertEqual(try GameKit.orientation(["orientation": .string("landscape")]), "landscape")
        XCTAssertThrowsError(try GameKit.orientation(["orientation": .string("sideways")]))
        XCTAssertEqual(try GameKit.on(["on": .bool(true)]), true)
        XCTAssertThrowsError(try GameKit.on(["on": .string("yes")]))
        XCTAssertEqual(try GameKit.channel(["channel": .string("motion-1")]), "motion-1")
        XCTAssertThrowsError(try GameKit.channel([:]))
    }

    func testPatternsAreCheckedAndClamped() throws {
        let events = try GameKit.pattern(["events": .array([
            .object(["t": .number(0), "intensity": .number(2), "sharpness": .number(-1)]),
            .object(["t": .number(0.1), "duration": .number(0.3)]),
        ])])
        XCTAssertEqual(events, [
            .init(t: 0, intensity: 1, sharpness: 0, duration: nil),
            .init(t: 0.1, intensity: 1, sharpness: 0.5, duration: 0.3),
        ])
        XCTAssertThrowsError(try GameKit.pattern([:]))
        XCTAssertThrowsError(try GameKit.pattern(["events": .array(Array(repeating: .object(["t": .number(0)]), count: 33))]))
        XCTAssertThrowsError(try GameKit.pattern(["events": .array([.object(["t": .number(4.9), "duration": .number(0.2)])])]))
        XCTAssertThrowsError(try GameKit.pattern(["events": .array([.object(["intensity": .number(1)])])]))
    }

    /// The protocol file's examples are valid args.
    func testTheProtocolFilesExamplesParse() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let file = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url.appendingPathComponent("protocol/v1.json")))
        guard case .object(let root) = file, case .object(let calls)? = root["calls"] else { return XCTFail() }
        func args(_ name: String) -> [String: JSONValue] {
            guard case .object(let call)? = calls[name], case .object(let a)? = call["args"] else { return [:] }
            return a
        }
        XCTAssertEqual(try GameKit.motionStart(args("motion.start")).hz, 100)
        XCTAssertEqual(try GameKit.pattern(args("haptics.pattern")).count, 2)
        XCTAssertEqual(try GameKit.impactStyle(args("haptics.impact")), "heavy")
        XCTAssertEqual(try GameKit.notificationType(args("haptics.notification")), "success")
        XCTAssertEqual(try GameKit.orientation(args("screen.lockOrientation")), "portrait")
        XCTAssertEqual(try GameKit.on(args("screen.immersive")), true)
        XCTAssertEqual(try CameraKit.locate(args("camera.locate")).codes.count, 4)
    }
}

final class MotionBatcherTests: XCTestCase {
    func testWritesTheProtocolsBatchAndClears() throws {
        var b = MotionBatcher()
        XCTAssertNil(b.flush())
        b.add(timestamp: 100, userAcceleration: (0.01, -0.02, 0), rotationRate: (0.1, 0, -0.05), gravity: (0, -0.71, -0.71), attitude: (roll: 0, pitch: 0.79, yaw: 0.12))
        b.add(timestamp: 100.01, userAcceleration: (0, 0, 0), rotationRate: (0, 0, 0), gravity: (0, 0, -1), attitude: (roll: 0, pitch: 0, yaw: 0))
        let json = try XCTUnwrap(b.flush())
        XCTAssertNil(b.flush())
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        guard case .object(let o) = decoded, case .array(let samples)? = o["samples"], samples.count == 2 else { return XCTFail(json) }
        guard case .object(let first) = samples[0], case .object(let second) = samples[1] else { return XCTFail(json) }
        XCTAssertEqual(first["t"], .number(0))
        XCTAssertEqual(first["attitude"], .object(["roll": .number(0), "pitch": .number(0.79), "yaw": .number(0.12)]))
        XCTAssertEqual(Set(first.keys), ["t", "userAcceleration", "rotationRate", "gravity", "attitude"])
        guard case .number(let t)? = second["t"] else { return XCTFail() }
        XCTAssertEqual(t, 0.01, accuracy: 1e-9)
    }

    func testKeepsOnlyTheAskedForSensorsAndTheNewestSamples() throws {
        var b = MotionBatcher(sensors: ["gravity"])
        for i in 0..<(MotionBatcher.maxPending + 10) {
            b.add(timestamp: Double(i), userAcceleration: (0, 0, 0), rotationRate: (0, 0, 0), gravity: (0, 0, -1), attitude: (roll: .nan, pitch: 0, yaw: 0))
        }
        XCTAssertEqual(b.pending.count, MotionBatcher.maxPending)
        XCTAssertEqual(b.pending.first?.t, 10)
        let json = try XCTUnwrap(b.flush())
        XCTAssertTrue(json.hasPrefix("{\"samples\":[{\"t\":10,\"gravity\":{\"x\":0,\"y\":0,\"z\":-1}}"), json)
        XCTAssertFalse(json.contains("attitude"))
    }

    func testNumbersAreShortAndAlwaysJSON() {
        XCTAssertEqual(MotionBatcher.num(0.123456789), "0.12346")
        XCTAssertEqual(MotionBatcher.num(-0.0), "0")
        XCTAssertEqual(MotionBatcher.num(.infinity), "0")
        XCTAssertEqual(MotionBatcher.num(3), "3")
        XCTAssertEqual(MotionBatcher.num(-1.0), "-1")
    }
}

final class CameraKitTests: XCTestCase {
    func testLocateArgs() throws {
        XCTAssertEqual(try CameraKit.locate(["codes": .array([.string("a"), .string("b")])]), .init(codes: ["a", "b"], holdMs: 1500, timeoutMs: 10_000, prompt: nil))
        let long = try CameraKit.locate(["codes": .array([.string("a")]), "holdMs": .number(99_999), "timeoutMs": .number(1), "prompt": .string(String(repeating: "x", count: 500))])
        XCTAssertEqual(long.holdMs, 5000)
        XCTAssertEqual(long.timeoutMs, 2000)
        XCTAssertEqual(long.prompt?.count, 120)
        XCTAssertThrowsError(try CameraKit.locate([:]))
        XCTAssertThrowsError(try CameraKit.locate(["codes": .array([])]))
        XCTAssertThrowsError(try CameraKit.locate(["codes": .array([.string("a"), .string("a")])]))
        XCTAssertThrowsError(try CameraKit.locate(["codes": .array([.string("")])]))
        XCTAssertThrowsError(try CameraKit.locate(["codes": .array([.number(1)])]))
        XCTAssertThrowsError(try CameraKit.locate(["codes": .array(Array(repeating: JSONValue.string("a"), count: 9).enumerated().map { .string("c\($0.offset)") })]))
    }

    func testRaysLookOutOfTheBackOfThePhone() {
        let fov = 70 * Double.pi / 180
        let centre = CameraKit.ray(.init(u: 0.5, v: 0.5), fovLong: fov, aspect: 0.75)
        XCTAssertEqual(centre.z, -1, accuracy: 1e-12)
        // The top edge of the image is half the long field of view up, towards the phone's top edge.
        let top = CameraKit.ray(.init(u: 0.5, v: 1), fovLong: fov, aspect: 0.75)
        XCTAssertEqual(atan2(top.y, -top.z), fov / 2, accuracy: 1e-9)
        let right = CameraKit.ray(.init(u: 1, v: 0.5), fovLong: fov, aspect: 0.75)
        XCTAssertEqual(right.x / -right.z, tan(fov / 2) * 0.75, accuracy: 1e-9)
        XCTAssertEqual(right.x * right.x + right.y * right.y + right.z * right.z, 1, accuracy: 1e-12)
    }

    func testTheHoldNeedsEveryCodeSteadyForItsLength() {
        let s = { (u: Double) in CameraKit.Sighting(centre: .init(u: u, v: 0.5), corners: []) }
        var hold = CameraKit.Hold(codes: ["a", "b"], holdMs: 1000)
        XCTAssertFalse(hold.add(t: 0, ["a": s(0.2)]))
        XCTAssertFalse(hold.add(t: 0.1, ["a": s(0.2), "b": s(0.8)]))
        XCTAssertFalse(hold.add(t: 0.6, ["a": s(0.205), "b": s(0.8)]))
        // A jump restarts the hold.
        XCTAssertFalse(hold.add(t: 0.9, ["a": s(0.3), "b": s(0.8)]))
        XCTAssertFalse(hold.add(t: 1.5, ["a": s(0.3), "b": s(0.8)]))
        XCTAssertTrue(hold.add(t: 1.95, ["a": s(0.3), "b": s(0.8)]))
        XCTAssertEqual(hold.last["b"]?.centre.u, 0.8)
        // Losing a code restarts it too.
        XCTAssertFalse(hold.add(t: 2, ["a": s(0.3)]))
        XCTAssertFalse(hold.add(t: 2.1, ["a": s(0.3), "b": s(0.8)]))
    }

    func testTheResultHoldsRaysAndTheAttitude() {
        let found = ["a": CameraKit.Sighting(centre: .init(u: 0.5, v: 0.5), corners: [.init(u: 0.4, v: 0.6), .init(u: 0.6, v: 0.6), .init(u: 0.6, v: 0.4), .init(u: 0.4, v: 0.4)])]
        let r = CameraKit.result(found, fovLong: 1.2, aspect: 0.75, attitude: (roll: 0, pitch: 0.5, yaw: 0.1))
        guard case .object(let o) = r, case .object(let f)? = o["found"], case .object(let a)? = f["a"], case .array(let corners)? = a["corners"] else { return XCTFail() }
        XCTAssertEqual(corners.count, 4)
        XCTAssertEqual(a["centre"], .object(["x": .number(0), "y": .number(0), "z": .number(-1)]))
        XCTAssertEqual(o["attitude"], .object(["roll": .number(0), "pitch": .number(0.5), "yaw": .number(0.1)]))
    }
}
