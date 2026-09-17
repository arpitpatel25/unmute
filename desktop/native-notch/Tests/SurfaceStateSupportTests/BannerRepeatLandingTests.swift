import XCTest
@testable import SurfaceStateSupport

final class BannerRepeatLandingTests: XCTestCase {
    func testAlreadyDormantStaysPut() {
        XCTAssertEqual(BannerRepeat.landing(current: .dormant), .stayPut)
    }

    func testBarLevelRepeatSettlesRatherThanHanging() {
        XCTAssertEqual(BannerRepeat.landing(current: .bar), .restSilently)
    }

    /// THE REGRESSION. An expanded surface is dismissed (click outside, or
    /// Escape); the engine commands a compact rung for a task it has already
    /// announced; the banner is suppressed. The surface must STILL come down.
    ///
    /// The guard that used to sit here read `!isExpanded(model.state)`, so this
    /// case fell through to nothing at all and the notch stayed open through
    /// repeated clicks and repeated Escapes.
    func testSuppressedBannerStillCollapsesAnExpandedSurface() {
        XCTAssertEqual(BannerRepeat.landing(current: .expanded), .restSilently)
    }

    /// Stated as a rule rather than three separate cases: suppression governs
    /// the VOICE, never the geometry. Nothing that is up may be left up.
    func testSuppressionNeverLeavesAVisibleSurfaceUp() {
        for rung in [SurfaceRung.bar, .expanded] {
            XCTAssertEqual(BannerRepeat.landing(current: rung), .restSilently,
                           "a visible surface must settle, rung=\(rung)")
        }
    }
}
