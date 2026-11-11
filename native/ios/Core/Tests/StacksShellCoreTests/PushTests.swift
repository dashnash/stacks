import Foundation
import XCTest
@testable import StacksShellCore

final class PushTests: XCTestCase {
    func testTokensAreLowerCaseHex() {
        XCTAssertEqual(Push.tokenHex(Data([0x00, 0x0A, 0xFF, 0x7B])), "000aff7b")
    }

    func testXcodeBuildsUseTheSandbox() {
        XCTAssertEqual(Push.environment(apsEnvironment: "development"), "sandbox")
        XCTAssertEqual(Push.environment(apsEnvironment: ""), "sandbox")
        XCTAssertEqual(Push.environment(apsEnvironment: "production"), "production")
    }

    func testATappedNotificationOpensItsHttpsLinkOnly() {
        XCTAssertEqual(Push.url(from: ["url": "https://auth.iamdashnash.com/#/admin/access?app=club"])?.absoluteString, "https://auth.iamdashnash.com/#/admin/access?app=club")
        XCTAssertNil(Push.url(from: ["url": "javascript:alert(1)"]))
        XCTAssertNil(Push.url(from: ["url": "http://hello.iamdashnash.com/"]))
        XCTAssertNil(Push.url(from: ["aps": ["badge": 1]]))
    }

    func testSettingsReadThePushEnvironment() {
        let settings = ShellSettings(info: ["StacksRootDomain": "iamdashnash.com", "StacksPushEnvironment": "production"])
        XCTAssertEqual(settings?.pushEnvironment, "production")
        XCTAssertEqual(ShellSettings(info: ["StacksRootDomain": "iamdashnash.com"])?.pushEnvironment, "sandbox")
    }
}

final class PushActionTests: XCTestCase {
    func testButtonsMapToThePlatformsActions() {
        XCTAssertEqual(PushAction.action(forIdentifier: "APPROVE"), "approve")
        XCTAssertEqual(PushAction.action(forIdentifier: "DENY"), "deny")
        XCTAssertNil(PushAction.action(forIdentifier: "com.apple.UNNotificationDefaultActionIdentifier"))
    }

    func testTheTokenComesFromTheNotification() {
        XCTAssertEqual(PushAction.token(from: ["actionToken": "spa_abc", "url": "https://x/"]), "spa_abc")
        XCTAssertNil(PushAction.token(from: ["url": "https://x/"]))
    }

    func testThePressGoesToThePortalHostWithTheDeviceSecret() throws {
        XCTAssertEqual(PushAction.url(authHost: "auth.iamdashnash.com", deviceId: "5f2c-8e1a")?.absoluteString, "https://auth.iamdashnash.com/api/devices/5f2c-8e1a/actions")
        XCTAssertEqual(PushAction.url(authHost: "auth.iamdashnash.com", deviceId: "../x")?.absoluteString, "https://auth.iamdashnash.com/api/devices/..%2Fx/actions")
        let body = try PushAction.body(secret: "sdv_1", token: "spa_2", action: "approve")
        XCTAssertEqual(String(data: body, encoding: .utf8), #"{"action":"approve","secret":"sdv_1","token":"spa_2"}"#)
    }
}
