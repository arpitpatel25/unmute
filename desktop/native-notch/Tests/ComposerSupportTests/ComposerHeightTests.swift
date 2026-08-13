import XCTest
@testable import ComposerSupport

final class ComposerHeightTests: XCTestCase {
    func testEmptyAndSingleLineComposerStayCompact() {
        XCTAssertEqual(ComposerHeight.resolve(measured: 0), 30)
        XCTAssertEqual(ComposerHeight.resolve(measured: 21), 30)
    }

    func testWrappedComposerGrowsAndStopsAtTheMultilineCap() {
        XCTAssertEqual(ComposerHeight.resolve(measured: 48), 52)
        XCTAssertEqual(ComposerHeight.resolve(measured: 120), 76)
    }
}
