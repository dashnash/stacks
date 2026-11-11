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
