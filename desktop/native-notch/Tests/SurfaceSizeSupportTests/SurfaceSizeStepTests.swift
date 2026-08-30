import XCTest
@testable import SurfaceSizeSupport

final class SurfaceSizeStepTests: XCTestCase {
    /// Catches a control that skips a supported fill or moves beyond its bounds.
    func testSteppingMovesToAdjacentSupportedFillAndStopsAtBounds() {
        // UPDATED with the move to a continuous range. This asserted the old
        // three-button world: 0.7 was the floor and 0.9 the ceiling, and a step
        // jumped between them. The range is now 0.40–0.95 and a step is one
        // nudge along it — so 0.7 and 0.9 are ordinary interior values with
        // room on both sides, and only the real ends refuse to move.
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .smaller), 0.75)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.8, direction: .larger), 0.85)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.7, direction: .smaller), 0.65)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.9, direction: .larger), 0.95)
        XCTAssertNil(SurfaceSizeStep.next(after: SurfaceSizeStep.minimum, direction: .smaller))
        XCTAssertNil(SurfaceSizeStep.next(after: SurfaceSizeStep.maximum, direction: .larger))
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
