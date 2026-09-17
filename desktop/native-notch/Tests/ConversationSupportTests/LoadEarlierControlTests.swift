import XCTest
@testable import ConversationSupport

final class LoadEarlierControlTests: XCTestCase {
    func testAKnownRemainderIsCounted() {
        XCTAssertEqual(LoadEarlierControl.label(olderMessages: 20), "Load earlier messages (20)")
    }

    func testACompleteConversationOffersNothing() {
        XCTAssertNil(LoadEarlierControl.label(olderMessages: 0))
    }

    /// THE CASE THE CONTROL EXISTED WITHOUT. A reattached card holds a replay
    /// tail, so the engine knows earlier messages exist but not yet how many.
    /// Counting them required loading them — the very thing this button does.
    /// Hiding it until the count was known meant it never appeared at all.
    func testAnUnknownRemainderStillOffersToLoad() {
        XCTAssertEqual(LoadEarlierControl.label(olderMessages: -1), "Load earlier messages")
    }
}
