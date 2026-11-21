import Foundation
import XCTest
@testable import StacksShellCore

private let policy = NavigationPolicy(rootDomain: "dashnash.ninja", otherRoots: ["test.dashnash.ninja"])
private let book = URL(string: "https://mofobookklub.dashnash.ninja/#/book/9780316769488")!
private let home = URL(string: "https://mofobookklub.dashnash.ninja/#/")!

final class PageShareTests: XCTestCase {
    func testSharesThePagesOwnURLAndTitleByDefault() {
        let share = PageShare(policy: policy)
        XCTAssertTrue(share.isVisible(on: book))
        XCTAssertEqual(share.target(on: book, title: "MOFO Book Klub"), ShareTarget(url: book, title: "MOFO Book Klub", text: nil))
        XCTAssertEqual(share.target(on: book, title: "  "), ShareTarget(url: book, title: nil, text: nil))
    }

    func testAPageMayChangeWhatItSharesOnlyWhileItIsOnThatURL() throws {
        var share = PageShare(policy: policy)
        try share.set([
            "page": .string(book.absoluteString),
            "url": .string("https://mofobookklub.dashnash.ninja/#/book/9780316769488/comment/c1"),
            "title": .string("A comment"),
            "text": .string("Look at this"),
        ])
        let target = share.target(on: book, title: "MOFO Book Klub")
        XCTAssertEqual(target?.url.absoluteString, "https://mofobookklub.dashnash.ninja/#/book/9780316769488/comment/c1")
        XCTAssertEqual(target?.title, "A comment")
        XCTAssertEqual(target?.text, "Look at this")
        // A hash route later: back to the default, though nothing told the shell.
        XCTAssertEqual(share.target(on: home, title: "MOFO Book Klub"), ShareTarget(url: home, title: "MOFO Book Klub", text: nil))
        // A new document forgets it even on the same URL.
        share.clear()
        XCTAssertEqual(share.target(on: book, title: "T")?.url, book)
    }

    func testOnlyTheTitleCanChangeAndTheRestDefaults() throws {
        var share = PageShare(policy: policy)
        try share.set(["page": .string(book.absoluteString), "title": .string("The Catcher in the Rye")])
        XCTAssertEqual(share.target(on: book, title: "MOFO Book Klub"), ShareTarget(url: book, title: "The Catcher in the Rye", text: nil))
    }

    func testHidingTakesTheButtonAwayOnThatPageOnly() throws {
        var share = PageShare(policy: policy)
        try share.set(["page": .string(book.absoluteString), "hidden": .bool(true)])
        XCTAssertFalse(share.isVisible(on: book))
        XCTAssertNil(share.target(on: book, title: "T"))
        XCTAssertTrue(share.isVisible(on: home))
        // Sending only the page again goes back to the default.
        try share.set(["page": .string(book.absoluteString)])
        XCTAssertTrue(share.isVisible(on: book))
    }

    func testMatchesThePageHoweverItIsSpelled() throws {
        var share = PageShare(policy: policy)
        try share.set(["page": .string("https://Hello.dashnash.ninja"), "hidden": .bool(true)])
        XCTAssertFalse(share.isVisible(on: URL(string: "https://hello.dashnash.ninja/")!))
        try share.set(["page": .string("https://hello.dashnash.ninja/#"), "hidden": .bool(true)])
        XCTAssertFalse(share.isVisible(on: URL(string: "https://hello.dashnash.ninja/")!))
    }

    func testRefusesBadArguments() {
        var share = PageShare(policy: policy)
        for args: [String: JSONValue] in [
            [:],
            ["page": .number(1)],
            ["page": .string(book.absoluteString), "url": .string("http://mofobookklub.dashnash.ninja/")],
            ["page": .string(book.absoluteString), "url": .string("javascript:alert(1)")],
            ["page": .string(book.absoluteString), "title": .number(3)],
            ["page": .string(book.absoluteString), "text": .string(String(repeating: "a", count: PageShare.maxTextLength + 1))],
            ["page": .string(book.absoluteString), "hidden": .string("yes")],
        ] {
            XCTAssertThrowsError(try share.set(args), "\(args)") { error in
                XCTAssertEqual((error as? BridgeError)?.code, .failed)
            }
        }
        XCTAssertNil(share.setting)
    }

    func testNeverSharesASignInLinkOrAPageThatIsNotOurs() {
        let share = PageShare(policy: policy)
        let signIn = URL(string: "https://auth.dashnash.ninja/#/signin?next=%2Fauthorize%3Fapp%3Dmofobookklub%26return%3D%252F")!
        XCTAssertEqual(share.target(on: signIn, title: "Sign in")?.url.absoluteString, "https://mofobookklub.dashnash.ninja/")
        XCTAssertEqual(share.target(on: URL(string: "https://auth.dashnash.ninja/authorize?app=hello")!, title: nil)?.url.absoluteString, "https://hello.dashnash.ninja/")
        XCTAssertFalse(share.isVisible(on: URL(string: "https://example.com/")!))
        XCTAssertFalse(share.isVisible(on: URL(string: "https://hello.test.dashnash.ninja/")!))
        XCTAssertFalse(share.isVisible(on: nil))
    }

    func testThePortalsPagesShareToo() {
        let share = PageShare(policy: policy)
        let inbox = URL(string: "https://auth.dashnash.ninja/#/inbox")!
        XCTAssertEqual(share.target(on: inbox, title: "Inbox")?.url, inbox)
    }

    func testAnyPageOfOursMayCallSharePageButNotAnIframe() async {
        let r = BridgeRouter(authHost: policy.authHost, isOurHost: policy.isOurHost)
        r.register("share.page") { _ in .object([:]) }
        let app = await r.handle(BridgeRequest(name: "share.page", args: ["page": .string(book.absoluteString)]), from: FrameInfo(scheme: "https", host: "mofobookklub.dashnash.ninja", isMainFrame: true))
        XCTAssertEqual(app, .ok(.object([:])))
        let portal = await r.handle(BridgeRequest(name: "share.page"), from: FrameInfo(scheme: "https", host: "auth.dashnash.ninja", isMainFrame: true))
        XCTAssertEqual(portal, .ok(.object([:])))
        let framed = await r.handle(BridgeRequest(name: "share.page"), from: FrameInfo(scheme: "https", host: "hello.dashnash.ninja", isMainFrame: false))
        XCTAssertEqual(framed, .error(BridgeError(.forbidden, "Not allowed from this page")))
    }
}
