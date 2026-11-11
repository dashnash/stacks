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

private let portal = FrameInfo(scheme: "https", host: "auth.iamdashnash.com", isMainFrame: true)
private let anApp = FrameInfo(scheme: "https", host: "hello.iamdashnash.com", isMainFrame: true)

private func router() -> BridgeRouter {
    let policy = NavigationPolicy(rootDomain: "iamdashnash.com", otherRoots: ["test.iamdashnash.com"])
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
        }
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
            FrameInfo(scheme: "https", host: "auth.iamdashnash.com", isMainFrame: false),
            FrameInfo(scheme: "http", host: "auth.iamdashnash.com", isMainFrame: true),
            FrameInfo(scheme: "https", host: "auth.test.iamdashnash.com", isMainFrame: true),
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
        let framed = await r.handle(BridgeRequest(name: "share", args: ["url": .string("https://x")]), from: FrameInfo(scheme: "https", host: "hello.iamdashnash.com", isMainFrame: false))
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
        let bare = BridgeRouter(authHost: "auth.iamdashnash.com", isOurHost: { _ in true })
        let none = await bare.handle(BridgeRequest(name: "share"), from: anApp)
        guard case .error(let e3) = none else { return XCTFail() }
        XCTAssertEqual(e3.code, .unsupported)
    }

    func testAHandlersOwnErrorsAreReportedAsFailed() async {
        struct Boom: LocalizedError { var errorDescription: String? { "Boom" } }
        let r = BridgeRouter(authHost: "auth.iamdashnash.com", isOurHost: { _ in true })
        r.register("app.info") { _ in throw Boom() }
        let reply = await r.handle(BridgeRequest(name: "app.info"), from: anApp)
        XCTAssertEqual(reply, .error(BridgeError(.failed, "Boom")))
    }

    func testTheInjectedScriptDeclaresTheProtocolAndItsCalls() {
        let js = BridgeRouter.injectedScript(appVersion: "1.2.3")
        XCTAssertTrue(js.contains("protocol: 1"))
        XCTAssertTrue(js.contains("version: \"1.2.3\""))
        XCTAssertTrue(js.contains("calls: Object.freeze([\"app.info\",\"auth.apple\",\"auth.google\",\"auth.signedOut\",\"badge.set\",\"push.register\",\"push.saveDevice\",\"push.status\",\"share\"])"))
        XCTAssertTrue(js.contains("messageHandlers.stacks"))
    }

    func testJSONValuesRoundTripThroughFoundation() throws {
        let v: JSONValue = .object(["a": .array([.bool(true), .number(2), .string("x"), .null]), "b": .object([:])])
        XCTAssertEqual(try JSONValue(foundation: v.foundationValue), v)
    }
}
