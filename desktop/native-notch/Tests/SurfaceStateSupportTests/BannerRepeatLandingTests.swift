import XCTest
@testable import SurfaceStateSupport

final class BannerRepeatLandingTests: XCTestCase {
    func testAlreadyDormantStaysPut() {
        XCTAssertEqual(BannerRepeat.landing(current: .dormant, pocketOpen: false), .stayPut)
    }

    func testBarLevelRepeatSettlesRatherThanHanging() {
        XCTAssertEqual(BannerRepeat.landing(current: .bar, pocketOpen: false), .restSilently)
    }

    /// THE REGRESSION. An expanded surface is dismissed (click outside, or
    /// Escape); the engine commands a compact rung for a task it has already
    /// announced; the banner is suppressed. The surface must STILL come down.
    ///
    /// The guard that used to sit here read `!isExpanded(model.state)`, so this
    /// case fell through to nothing at all and the notch stayed open through
    /// repeated clicks and repeated Escapes.
    func testSuppressedBannerStillCollapsesAnExpandedSurface() {
        XCTAssertEqual(BannerRepeat.landing(current: .expanded, pocketOpen: false), .restSilently)
    }

    /// Stated as a rule rather than three separate cases: suppression governs
    /// the VOICE, never the geometry. Nothing that is up may be left up.
    func testSuppressionNeverLeavesAVisibleSurfaceUp() {
        for rung in [SurfaceRung.bar, .expanded] {
            XCTAssertEqual(BannerRepeat.landing(current: rung, pocketOpen: false), .restSilently,
                           "a visible surface must settle, rung=\(rung)")
        }
    }

    /// THE POCKET THE USER JUST OPENED IS NOT A BANNER.
    ///
    /// Dormant is the CUTOUT on a notched Mac, so resting a bar that is
    /// carrying an open pocket does not quieten it — it posts it behind the
    /// camera housing, where there is no screen to draw on. The card is simply
    /// gone, one second after the click that asked for it, and the only way
    /// back is a second click.
    func testAnOpenPocketIsNeverRestedIntoTheCutout() {
        XCTAssertEqual(BannerRepeat.landing(current: .bar, pocketOpen: true), .stayPut)
    }

    /// Both halves of the rule at once: the dismissal is still honoured (the
    /// expanded surface comes down), but it lands on the bar, where the open
    /// pocket is visible, instead of continuing into the cutout.
    func testDismissingAnExpandedSurfaceLandsOnTheOpenPocket() {
        XCTAssertEqual(BannerRepeat.landing(current: .expanded, pocketOpen: true), .settleAtBar)
    }

    /// An explicit pocket is user state, so it outranks every self-initiated
    /// rest — the same rule HoverSleepPolicy already applies to the hover
    /// ladder, stated once for every caller.
    func testSelfInitiatedRestNeverSwallowsAnOpenPocket() {
        for rung in [SurfaceRung.dormant, .bar, .expanded] {
            XCTAssertFalse(SurfaceRest.mayRest(current: rung, pocketOpen: true),
                           "an open pocket may not be rested away, rung=\(rung)")
        }
    }

    /// The other three quarters of that rule, so the line above cannot be
    /// satisfied by a function that simply always says no.
    func testTheBarStillRestsWhenNothingIsHoldingItOpen() {
        XCTAssertTrue(SurfaceRest.mayRest(current: .bar, pocketOpen: false))
        XCTAssertFalse(SurfaceRest.mayRest(current: .expanded, pocketOpen: false),
                       "the user opened it")
        // Nothing is holding a dormant surface up, and the stand-down clock
        // still records the sentence as said when it fires down there — 96
        // `rest: dormant -> dormant` lines in one day's field log do exactly
        // that, and a banner that is never recorded as said blinks back.
        XCTAssertTrue(SurfaceRest.mayRest(current: .dormant, pocketOpen: false))
    }
}
