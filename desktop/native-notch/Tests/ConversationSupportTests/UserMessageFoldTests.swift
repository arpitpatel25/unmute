import XCTest
@testable import ConversationSupport

final class UserMessageFoldTests: XCTestCase {

    func testAShortMessageIsNeverFolded() {
        XCTAssertFalse(userTextOverflows(fullHeight: 40))
        XCTAssertFalse(userTextOverflows(fullHeight: userBubbleMaxHeight))
    }

    /// Folding something that would have fitted in another line or two costs a
    /// tap and hides almost nothing — worse than simply showing it.
    func testAMessageThatBarelyExceedsTheCapIsShownWhole() {
        XCTAssertFalse(userTextOverflows(fullHeight: userBubbleMaxHeight + 1))
        XCTAssertFalse(userTextOverflows(fullHeight: userBubbleMaxHeight + userBubbleFoldSlack))
    }

    func testAMessageWithRealContentBelowTheFoldIsFolded() {
        XCTAssertTrue(userTextOverflows(fullHeight: userBubbleMaxHeight + userBubbleFoldSlack + 1))
        XCTAssertTrue(userTextOverflows(fullHeight: 900))
    }

    /// NOT MEASURED YET. The hidden copy reports nothing on the first pass, and
    /// folding on that would flash a collapsed bubble at every reader before
    /// the real height arrives. Show it whole until we actually know.
    func testAnUnmeasuredHeightIsNeverFolded() {
        XCTAssertFalse(userTextOverflows(fullHeight: 0))
        XCTAssertFalse(userTextOverflows(fullHeight: .nan))
        XCTAssertFalse(userTextOverflows(fullHeight: -10))
    }

    /// THE SLACK IS THE DEAD ZONE, and it exists for the same reason
    /// BottomProximity's does: this decision reads a height and then changes a
    /// height. It is only safe because the measured copy always renders in
    /// full — but the margin has to be wider than the fade it draws, or a
    /// borderline message could argue with itself.
    func testTheSlackIsWiderThanTheFadeItDraws() {
        XCTAssertGreaterThan(userBubbleFoldSlack, userBubbleFadeHeight)
    }
}
