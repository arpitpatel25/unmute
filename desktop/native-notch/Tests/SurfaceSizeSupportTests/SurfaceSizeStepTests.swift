import XCTest
@testable import SurfaceSizeSupport

final class SurfaceSizeStepTests: XCTestCase {
    /// Catches a control that skips a supported fill or moves beyond its bounds.
    func testSteppingMovesToAdjacentSupportedFillAndStopsAtBounds() {
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .smaller), 0.7)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .larger), 0.9)
        XCTAssertNil(SurfaceSizeStep.next(after: 0.7, direction: .smaller))
        XCTAssertNil(SurfaceSizeStep.next(after: 0.9, direction: .larger))
    }
}
