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

    func testTemporarySelectionUsesTheExactScreenFractionInsteadOfScalingProviderGeometry() {
        let screen = CGSize(width: 1440, height: 900)
        let providerBase = CGSize(width: 1008, height: 630)

        XCTAssertEqual(
            SurfaceSizeStep.resolvedSize(
                screen: screen,
                providerDefault: providerBase,
                temporaryFill: 0.8
            ),
            CGSize(width: 1152, height: 720)
        )
        XCTAssertEqual(
            SurfaceSizeStep.resolvedSize(
                screen: screen,
                providerDefault: providerBase,
                temporaryFill: nil
            ),
            providerBase
        )
    }
}
