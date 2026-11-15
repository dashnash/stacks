import Foundation
import XCTest
@testable import StacksShellCore

/// native/protocol/v1.json, the contract the web side (packages/native) tests against too.
private func protocolFile() throws -> JSONValue {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() } // …/native
    let data = try Data(contentsOf: url.appendingPathComponent("protocol/v1.json"))
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

private func field(_ v: JSONValue, _ path: String...) -> JSONValue {
    var cur = v
    for key in path {
        guard case .object(let o) = cur, let next = o[key] else { return .null }
        cur = next
    }
    return cur
}

private let portal = FrameInfo(scheme: "https", host: "auth.dashnash.ninja", isMainFrame: true)
private let anApp = FrameInfo(scheme: "https", host: "hello.dashnash.ninja", isMainFrame: true)

private func router() -> BridgeRouter {
    let policy = NavigationPolicy(rootDomain: "dashnash.ninja", otherRoots: ["test.dashnash.ninja"])
    let r = BridgeRouter(authHost: policy.authHost, isOurHost: policy.isOurHost)
    r.register("app.info") { _ in .object(["version": .string("1.0.0")]) }
    r.register("auth.google") { _ in .object(["credential": .string("tok")]) }
    r.register("auth.signedOut") { _ in .object([:]) }
    r.register("share") { args in
        if args["url"] == nil { throw BridgeError(.cancelled, "Share was cancelled") }
        return .object(["completed": .bool(true)])
    }
    return r
}

final class ProtocolFileTests: XCTestCase {
    func testTheAppKnowsExactlyTheProtocolsCalls() throws {
        let file = try protocolFile()
        XCTAssertEqual(field(file, "protocol"), .number(Double(BridgeProtocol.version)))
        guard case .object(let calls) = field(file, "calls") else { return XCTFail("no calls") }
        XCTAssertEqual(calls.keys.sorted(), BridgeProtocol.callNames)
        for (name, call) in calls {
            XCTAssertEqual(field(call, "origins").stringValue, BridgeProtocol.calls[name]?.rawValue, name)
            XCTAssertEqual(field(call, "capability").stringValue, BridgeProtocol.capabilities[name], name)
        }
        guard case .array(let example)? = Optional(field(file, "global", "example", "calls")) else { return XCTFail("no example calls") }
        XCTAssertEqual(example.compactMap { $0.stringValue }, BridgeProtocol.callNames)
        guard case .array(let codes) = field(file, "errorCodes") else { return XCTFail("no errorCodes") }
        XCTAssertEqual(codes.compactMap { $0.stringValue }, ["unsupported", "forbidden", "cancelled", "failed"])
        XCTAssertEqual(codes.compactMap { $0.stringValue.flatMap(BridgeErrorCode.init(rawValue:)) }.count, 4)
    }

    func testReadsTheRequestAndWritesTheRepliesOfTheProtocolFile() async throws {
        let file = try protocolFile()
        let body = field(file, "envelope", "request").foundationValue
        let reply = await router().handle(body: body, from: anApp)
        XCTAssertEqual(reply.json, field(file, "envelope", "ok"))
        let cancelled = await router().handle(BridgeRequest(name: "share"), from: anApp)
        XCTAssertEqual(cancelled.json, field(file, "envelope", "error"))
    }
}

final class BridgeRouterTests: XCTestCase {
    func testOnlyThePortalsOwnTopFrameMayAskForGoogleSignIn() async {
        let r = router()
        let ok = await r.handle(BridgeRequest(name: "auth.google"), from: portal)
        XCTAssertEqual(ok, .ok(.object(["credential": .string("tok")])))
        for frame in [
            anApp,
            FrameInfo(scheme: "https", host: "auth.dashnash.ninja", isMainFrame: false),
            FrameInfo(scheme: "http", host: "auth.dashnash.ninja", isMainFrame: true),
            FrameInfo(scheme: "https", host: "auth.test.dashnash.ninja", isMainFrame: true),
            FrameInfo(scheme: "https", host: "evil.example", isMainFrame: true),
        ] {
            let reply = await r.handle(BridgeRequest(name: "auth.google"), from: frame)
            guard case .error(let e) = reply else { return XCTFail("\(frame) got a credential") }
            XCTAssertEqual(e.code, .forbidden, "\(frame)")
        }
    }

    func testAppsMayShareButNotFromIframesOrOtherSites() async {
        let r = router()
        let shared = await r.handle(BridgeRequest(name: "share", args: ["url": .string("https://x")]), from: anApp)
        XCTAssertEqual(shared, .ok(.object(["completed": .bool(true)])))
        let framed = await r.handle(BridgeRequest(name: "share", args: ["url": .string("https://x")]), from: FrameInfo(scheme: "https", host: "hello.dashnash.ninja", isMainFrame: false))
        XCTAssertEqual(framed, .error(BridgeError(.forbidden, "Not allowed from this page")))
    }

    func testRefusesUnknownCallsOtherProtocolsAndGarbage() async {
        let r = router()
        let unknown = await r.handle(BridgeRequest(name: "camera.capture"), from: anApp)
        guard case .error(let e) = unknown else { return XCTFail() }
        XCTAssertEqual(e.code, .unsupported)
        let v2 = await r.handle(BridgeRequest(v: 2, name: "app.info"), from: anApp)
        guard case .error(let e2) = v2 else { return XCTFail() }
        XCTAssertEqual(e2.code, .unsupported)
        let garbage = await r.handle(body: ["nope": 1], from: anApp)
        XCTAssertEqual(garbage, .error(BridgeError(.failed, "Malformed bridge request")))
        // A call the protocol knows but this build has no handler for is unsupported, not a crash.
        let bare = BridgeRouter(authHost: "auth.dashnash.ninja", isOurHost: { _ in true })
        let none = await bare.handle(BridgeRequest(name: "share"), from: anApp)
        guard case .error(let e3) = none else { return XCTFail() }
        XCTAssertEqual(e3.code, .unsupported)
    }

    func testAHandlersOwnErrorsAreReportedAsFailed() async {
        struct Boom: LocalizedError { var errorDescription: String? { "Boom" } }
        let r = BridgeRouter(authHost: "auth.dashnash.ninja", isOurHost: { _ in true })
        r.register("app.info") { _ in throw Boom() }
        let reply = await r.handle(BridgeRequest(name: "app.info"), from: anApp)
        XCTAssertEqual(reply, .error(BridgeError(.failed, "Boom")))
    }

    func testTheInjectedScriptDeclaresTheProtocolAndItsCalls() {
        let js = BridgeRouter.injectedScript(appVersion: "1.2.3")
        XCTAssertTrue(js.contains("protocol: 1"))
        XCTAssertTrue(js.contains("version: \"1.2.3\""))
        XCTAssertTrue(js.contains("calls: Object.freeze([\"app.info\",\"auth.apple\",\"auth.google\",\"auth.signedOut\",\"badge.set\",\"haptics.impact\",\"haptics.notification\",\"haptics.pattern\",\"motion.start\",\"motion.stop\",\"push.register\",\"push.saveDevice\",\"push.status\",\"screen.immersive\",\"screen.keepAwake\",\"screen.lockOrientation\",\"share\"])"))
        XCTAssertTrue(js.contains("messageHandlers.stacks"))
        XCTAssertTrue(js.contains("listen: function (channel, fn)"))
        XCTAssertTrue(js.contains("_emit: function (channel, payload)"))
    }

    func testTheEmitScriptQuotesTheChannel() {
        XCTAssertEqual(
            BridgeRouter.emitScript(channel: "motion-1", payloadJSON: "{\"samples\":[]}"),
            "window.stacksNative && window.stacksNative._emit(\"motion-1\", {\"samples\":[]});"
        )
        XCTAssertTrue(BridgeRouter.emitScript(channel: "a\"); alert(1); (\"", payloadJSON: "{}").contains("_emit(\"a\\\"); alert(1); (\\\"\", {})"))
    }

    func testJSONValuesRoundTripThroughFoundation() throws {
        let v: JSONValue = .object(["a": .array([.bool(true), .number(2), .string("x"), .null]), "b": .object([:])])
        XCTAssertEqual(try JSONValue(foundation: v.foundationValue), v)
    }
}

final class AppCapabilityTests: XCTestCase {
    private let gyro = FrameInfo(scheme: "https", host: "gyro-gym.dashnash.ninja", isMainFrame: true)

    private func gameRouter() -> BridgeRouter {
        let policy = NavigationPolicy(rootDomain: "dashnash.ninja", otherRoots: ["test.dashnash.ninja"])
        let config = NativeConfig(protocol: 1, minShellVersion: "1.0.0", authHost: policy.authHost, apps: [
            .init(slug: "gyro-gym", name: "Gyro Gym", host: "gyro-gym.dashnash.ninja", native: ["motion", "haptics"]),
            .init(slug: "hello", name: "Hello Board", host: "hello.dashnash.ninja"),
        ])
        let r = BridgeRouter(authHost: policy.authHost, isOurHost: policy.isOurHost, capabilities: { config.capabilities(forHost: $0) })
        for name in BridgeProtocol.capabilities.keys { r.register(name) { _ in .object([:]) } }
        return r
    }

    func testAnAppThatDeclaredACapabilityMayUseIt() async {
        let r = gameRouter()
        let started = await r.handle(BridgeRequest(name: "motion.start"), from: gyro)
        XCTAssertEqual(started, .ok(.object([:])))
        let buzz = await r.handle(BridgeRequest(name: "haptics.impact"), from: gyro)
        XCTAssertEqual(buzz, .ok(.object([:])))
    }

    func testUndeclaredCapabilitiesThePortalAndIframesAreRefused() async {
        let r = gameRouter()
        let cases: [(String, FrameInfo)] = [
            ("screen.immersive", gyro), // gyro-gym didn't declare "screen"
            ("motion.start", anApp), // hello declared nothing
            ("motion.start", portal),
            ("motion.start", FrameInfo(scheme: "https", host: "gyro-gym.dashnash.ninja", isMainFrame: false)),
            ("motion.start", FrameInfo(scheme: "https", host: "gyro-gym.test.dashnash.ninja", isMainFrame: true)),
        ]
        for (name, frame) in cases {
            let reply = await r.handle(BridgeRequest(name: name), from: frame)
            guard case .error(let e) = reply else { return XCTFail("\(name) from \(frame) was allowed") }
            XCTAssertEqual(e.code, .forbidden, "\(name) from \(frame)")
        }
        let undeclared = await r.handle(BridgeRequest(name: "motion.start"), from: anApp)
        XCTAssertEqual(undeclared, .error(BridgeError(.forbidden, "This app hasn't declared \"motion\" (\"native\" in its manifest)")))
    }

    func testWithoutAConfigNoAppHasCapabilities() async {
        let r = BridgeRouter(authHost: "auth.dashnash.ninja", isOurHost: { _ in true })
        r.register("haptics.impact") { _ in .object([:]) }
        let reply = await r.handle(BridgeRequest(name: "haptics.impact"), from: gyro)
        guard case .error(let e) = reply else { return XCTFail() }
        XCTAssertEqual(e.code, .forbidden)
    }

    func testNativeConfigReadsCapabilitiesAndOlderConfigsWithout() throws {
        let json = #"{"protocol":1,"minShellVersion":"1.0.0","authHost":"auth.dashnash.ninja","apps":[{"slug":"gyro-gym","name":"Gyro Gym","host":"gyro-gym.dashnash.ninja","native":["motion"]},{"slug":"hello","name":"Hello Board","host":"hello.dashnash.ninja"}]}"#
        let config = try JSONDecoder().decode(NativeConfig.self, from: Data(json.utf8))
        XCTAssertEqual(config.capabilities(forHost: "Gyro-Gym.dashnash.ninja"), ["motion"])
        XCTAssertEqual(config.capabilities(forHost: "hello.dashnash.ninja"), [])
        XCTAssertEqual(config.capabilities(forHost: "auth.dashnash.ninja"), [])
    }
}

