import Foundation
import XCTest
@testable import StacksShellCore

private let production = NavigationPolicy(rootDomain: "iamdashnash.com", otherRoots: ["test.iamdashnash.com"])
private let staging = NavigationPolicy(rootDomain: "test.iamdashnash.com")

final class NavigationTests: XCTestCase {
    private func decide(_ p: NavigationPolicy, _ s: String) -> NavigationDecision { p.decide(URL(string: s)!) }

    func testKeepsThePortalAndAppsInsideAndSendsTheRestOfTheWebToSafari() {
        XCTAssertEqual(decide(production, "https://auth.iamdashnash.com/#/profile"), .inApp)
        XCTAssertEqual(decide(production, "https://mofobookklub.iamdashnash.com/#/book/1"), .inApp)
        XCTAssertEqual(decide(production, "https://iamdashnash.com/"), .inApp)
        XCTAssertEqual(decide(production, "https://accounts.google.com/o/oauth2"), .safari)
        XCTAssertEqual(decide(production, "https://github.com/dashnash/stacks"), .safari)
        XCTAssertEqual(decide(production, "https://iamdashnash.com.evil.example/"), .safari)
        XCTAssertEqual(decide(production, "https://notiamdashnash.com/"), .safari)
    }

    func testKeepsTheEnvironmentsApart() {
        XCTAssertEqual(decide(production, "https://hello.test.iamdashnash.com/"), .safari)
        XCTAssertEqual(decide(production, "https://test.iamdashnash.com/"), .safari)
        XCTAssertEqual(decide(staging, "https://hello.test.iamdashnash.com/"), .inApp)
        XCTAssertEqual(decide(staging, "https://hello.iamdashnash.com/"), .safari)
    }

    func testHandsMailPhoneAndMessagesToTheSystemAndDropsOddSchemes() {
        XCTAssertEqual(decide(production, "mailto:a@b.c"), .system)
        XCTAssertEqual(decide(production, "tel:+15551234"), .system)
        XCTAssertEqual(decide(production, "sms:+15551234"), .system)
        XCTAssertEqual(decide(production, "about:blank"), .inApp)
        XCTAssertEqual(decide(production, "javascript:alert(1)"), .cancel)
        XCTAssertEqual(decide(production, "file:///etc/passwd"), .cancel)
    }

    func testReopensTheLastPageWithinADayAndOnlyOurs() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let page = URL(string: "https://hello.iamdashnash.com/#/x")!
        XCTAssertEqual(production.launchURL(lastURL: page, savedAt: now.addingTimeInterval(-3600), now: now), page)
        XCTAssertEqual(production.launchURL(lastURL: page, savedAt: now.addingTimeInterval(-25 * 3600), now: now), production.startURL)
        XCTAssertEqual(production.launchURL(lastURL: URL(string: "https://evil.example/")!, savedAt: now, now: now), production.startURL)
        XCTAssertEqual(production.launchURL(lastURL: nil, savedAt: nil, now: now).absoluteString, "https://auth.iamdashnash.com/")
    }
}

final class ConfigTests: XCTestCase {
    func testComparesVersionsAsNumbers() {
        XCTAssertTrue(Version.atLeast("1.10.0", "1.2.0"))
        XCTAssertFalse(Version.atLeast("1.0.0", "1.0.1"))
        XCTAssertTrue(Version.atLeast("1.0", "1.0.0"))
        XCTAssertTrue(Version.atLeast("2", "1.9.9"))
    }

    func testReadsNativeConfigAsThePlatformServesItAndKnowsWhenToAskForAnUpdate() throws {
        // The shape platform/api's GET /native/config answers (platform/api/tests/google.test.ts).
        let json = #"{"protocol":1,"minShellVersion":"1.2.0","authHost":"auth.iamdashnash.com","apps":[{"slug":"hello","name":"Hello Board","host":"hello.iamdashnash.com"}]}"#
        let config = try JSONDecoder().decode(NativeConfig.self, from: Data(json.utf8))
        XCTAssertEqual(config.apps.first?.host, "hello.iamdashnash.com")
        XCTAssertTrue(config.needsUpdate(appVersion: "1.1.9"))
        XCTAssertFalse(config.needsUpdate(appVersion: "1.2.0"))
        let newer = NativeConfig(protocol: 2, minShellVersion: "1.0.0", authHost: "a", apps: [])
        XCTAssertTrue(newer.needsUpdate(appVersion: "9.0.0"))
    }

    func testReadsItsSettingsFromInfoPlist() {
        let s = ShellSettings(info: [
            "StacksRootDomain": "iamdashnash.com",
            "StacksOtherRoots": "test.iamdashnash.com, ",
            "GIDClientID": "ios.apps.googleusercontent.com",
            "GIDServerClientID": "web.apps.googleusercontent.com",
            "CFBundleShortVersionString": "1.0.0",
            "CFBundleVersion": "42",
        ])
        XCTAssertEqual(s?.policy, NavigationPolicy(rootDomain: "iamdashnash.com", otherRoots: ["test.iamdashnash.com"]))
        XCTAssertEqual(s?.nativeConfigURL.absoluteString, "https://auth.iamdashnash.com/api/native/config")
        XCTAssertEqual(s?.build, "42")
        XCTAssertNil(ShellSettings(info: [:]))
    }
}
