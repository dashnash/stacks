import Foundation
import XCTest
@testable import StacksShellCore

/// A sign-in started in Chrome or Safari that iOS hands to the app can't finish there (bug: the app
/// showed "Sign-in expired or was started in another browser" and reopened it on every launch).
final class SignInHandoffTests: XCTestCase {
    let policy = NavigationPolicy(rootDomain: "test.iamdashnash.com")

    func testSignInPlumbingIsRecognised() {
        for raw in [
            "https://hello.test.iamdashnash.com/api/auth/callback?code=c&state=s",
            "https://hello.test.iamdashnash.com/api/auth/login",
            "https://auth.test.iamdashnash.com/authorize?app=hello&state=s",
            "https://auth.test.iamdashnash.com/logout",
            "https://auth.test.iamdashnash.com/#/signin?next=%2Fauthorize%3Fapp%3Dhello",
        ] {
            XCTAssertTrue(policy.isSignInPlumbing(URL(string: raw)!), raw)
        }
        for raw in ["https://hello.test.iamdashnash.com/", "https://auth.test.iamdashnash.com/#/profile", "https://hello.test.iamdashnash.com/#/signin"] {
            XCTAssertFalse(policy.isSignInPlumbing(URL(string: raw)!), raw)
        }
    }

    func testAHandedOffSignInOpensTheAppItWasFor() {
        let portalSignIn = URL(string: "https://auth.test.iamdashnash.com/#/signin?next=%2Fauthorize%3Fapp%3Dhello%26state%3Ds%26redirect_uri%3Dx")!
        XCTAssertEqual(policy.handoffURL(portalSignIn).absoluteString, "https://hello.test.iamdashnash.com/")
        let authorize = URL(string: "https://auth.test.iamdashnash.com/authorize?app=mofobookklub&state=s")!
        XCTAssertEqual(policy.handoffURL(authorize).absoluteString, "https://mofobookklub.test.iamdashnash.com/")
        let callback = URL(string: "https://hello.test.iamdashnash.com/api/auth/callback?code=c&state=s")!
        XCTAssertEqual(policy.handoffURL(callback).absoluteString, "https://hello.test.iamdashnash.com/")
        XCTAssertEqual(policy.handoffURL(URL(string: "https://auth.test.iamdashnash.com/logout")!), policy.startURL)
        // A made-up app slug goes to the portal.
        XCTAssertEqual(policy.handoffURL(URL(string: "https://auth.test.iamdashnash.com/authorize?app=..%2Fevil")!), policy.startURL)
        // Ordinary links are untouched.
        let page = URL(string: "https://hello.test.iamdashnash.com/#post-1")!
        XCTAssertEqual(policy.handoffURL(page), page)
    }

    func testSignInPlumbingIsNeverReopenedAtLaunch() {
        let now = Date()
        let stuck = URL(string: "https://hello.test.iamdashnash.com/api/auth/callback?code=c&state=s")!
        XCTAssertEqual(policy.launchURL(lastURL: stuck, savedAt: now, now: now), policy.startURL)
        let fine = URL(string: "https://hello.test.iamdashnash.com/")!
        XCTAssertEqual(policy.launchURL(lastURL: fine, savedAt: now, now: now), fine)
    }
}
