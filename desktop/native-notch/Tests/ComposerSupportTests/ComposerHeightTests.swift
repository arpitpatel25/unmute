import XCTest
@testable import ComposerSupport

final class ComposerHeightTests: XCTestCase {
    func testEmptyAndSingleLineComposerStayCompact() {
        XCTAssertEqual(ComposerHeight.resolve(measured: 0), 30)
        XCTAssertEqual(ComposerHeight.resolve(measured: 21), 30)
    }

    func testWrappedComposerGrowsAndStopsAtTheMultilineCap() {
        XCTAssertEqual(ComposerHeight.resolve(measured: 48), 52)
        XCTAssertEqual(ComposerHeight.resolve(measured: 120), 124)
        XCTAssertEqual(ComposerHeight.resolve(measured: 900), 144)
    }

    func testASingleLineIsCentredInTheMinimumHeight() {
        // 17pt line in the 30pt minimum: 6pt above and below.
        XCTAssertEqual(ComposerHeight.verticalInset(measured: 17, lineHeight: 17), 6)
        // An empty draft measures 0 but still has a caret one line tall.
        XCTAssertEqual(ComposerHeight.verticalInset(measured: 0, lineHeight: 17), 6)
    }

    func testTallDraftsKeepTheirTwoPointInset() {
        XCTAssertEqual(ComposerHeight.verticalInset(measured: 48, lineHeight: 17), 2)
        XCTAssertEqual(ComposerHeight.verticalInset(measured: 200, lineHeight: 17), 2)
    }
}
