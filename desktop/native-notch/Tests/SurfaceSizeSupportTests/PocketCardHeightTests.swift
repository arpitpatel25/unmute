import XCTest
import CoreGraphics
@testable import SurfaceSizeSupport

final class PocketCardHeightTests: XCTestCase {

    // A task that is ASKING earns three rows: who you are addressing, the
    // question, and which of the held tasks this is.
    func testAnAskGetsItsOwnRow() {
        XCTAssertEqual(pocketCardHeight(hasAsk: true), pocketCardHeightAsking)
    }

    // THE BUG. With no ask, the middle row fell back to the SAME status word the
    // footer already shows — so a finished task rendered "Done" twice, and paid
    // two lines of height (31pt, sized for a two-line question) to say four
    // characters. The row is dropped rather than filled with an echo.
    func testNoAskDropsTheRowRatherThanEchoingTheStatus() {
        XCTAssertEqual(pocketCardHeight(hasAsk: false),
                       pocketCardHeightAsking - pocketAskRowHeight - pocketRowGap)
    }

    func testDroppingTheRowIsWorthRoughlyAThird() {
        let saved = pocketCardHeight(hasAsk: true) - pocketCardHeight(hasAsk: false)
        XCTAssertGreaterThanOrEqual(saved, 30)
    }

    // Both heights must stay tall enough to be a card rather than a strip —
    // the header alone is 20pt and the footer 21pt, plus padding.
    func testEvenTheShortCardStillHoldsItsTwoRows() {
        XCTAssertGreaterThan(pocketCardHeight(hasAsk: false), 60)
    }

    // The window frame is derived from this, so a value that drifts from what
    // the view lays out would clip the footer or leave a dead band.
    func testTheTallHeightIsExactlyItsParts() {
        XCTAssertEqual(pocketCardHeightAsking,
                       pocketCardPadTop + pocketHeaderHeight + pocketRowGap
                       + pocketAskRowHeight + pocketRowGap + pocketFootHeight
                       + pocketCardPadBottom)
    }
}
