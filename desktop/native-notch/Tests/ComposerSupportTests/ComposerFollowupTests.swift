import XCTest
@testable import ComposerSupport

final class ComposerFollowupTests: XCTestCase {
    func testQueueFullDoesNotDisableExplicitAnswers() {
        XCTAssertFalse(composerFollowupCanSend(mode: "full"))
        XCTAssertTrue(composerFollowupCanSend(mode: "answer"))
        XCTAssertFalse(composerFollowupCanSend(mode: "locked"))
        XCTAssertTrue(composerFollowupCanSend(mode: "queue"))
        XCTAssertEqual(composerFollowupSendLabel(mode: "queue"), "Queue follow-up")
    }
}
