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
