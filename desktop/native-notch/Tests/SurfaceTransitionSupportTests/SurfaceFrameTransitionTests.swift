import CoreGraphics
import XCTest
@testable import SurfaceTransitionSupport

final class SurfaceFrameTransitionTests: XCTestCase {
    func testAutomaticDepartureStaysHiddenUntilACompactStateArrives() {
        var departure = SurfaceDepartureTransition()

        XCTAssertEqual(departure.begin(isExpanded: true), .hide)
        XCTAssertEqual(departure.receive(isExpanded: true), .applyHidden)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyImmediatelyAndShow)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyNormally)
    }

    // 2026-09-21: links opened in an orphaned headless Chrome, whose
    // activation collapsed the card although nothing appeared on screen.
    func testAnAppWithNoWindowOnScreenDoesNotCollapseTheCard() {
        XCTAssertEqual(DepartureTarget.decide(hasWindowOnScreen: true, rechecked: false), .leave)
        XCTAssertEqual(DepartureTarget.decide(hasWindowOnScreen: false, rechecked: false), .lookAgain,
                       "an app still launching gets one more look")
        XCTAssertEqual(DepartureTarget.decide(hasWindowOnScreen: true, rechecked: true), .leave)
        XCTAssertEqual(DepartureTarget.decide(hasWindowOnScreen: false, rechecked: true), .stay)
    }

    func testAutomaticDepartureDoesNothingOutsideALargeSurface() {
        var departure = SurfaceDepartureTransition()

        XCTAssertEqual(departure.begin(isExpanded: false), .none)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyNormally)
    }

    func testReturningBeforeTheCompactReplyRestoresTheLargeSurface() {
        var departure = SurfaceDepartureTransition()
        XCTAssertEqual(departure.begin(isExpanded: true), .hide)

        XCTAssertEqual(departure.cancel(), .keepHidden)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyHidden,
                       "the already queued compact reply must not flash on return")
        XCTAssertEqual(departure.receive(isExpanded: true), .applyImmediatelyAndShow)
        XCTAssertEqual(departure.receive(isExpanded: true), .applyNormally)
    }

    func testReturningAfterCompactSettledHidesUntilLargeSurfaceIsRestored() {
        var departure = SurfaceDepartureTransition()
        XCTAssertEqual(departure.begin(isExpanded: true), .hide)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyImmediatelyAndShow)

        XCTAssertEqual(departure.returnToExpanded(isExpanded: false), .hideUntilExpanded)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyHidden)
        XCTAssertEqual(departure.receive(isExpanded: true), .applyImmediatelyAndShow)
    }

    func testUnfulfilledReturnFallsBackToTheCompactSurface() {
        var departure = SurfaceDepartureTransition()
        XCTAssertEqual(departure.begin(isExpanded: true), .hide)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyImmediatelyAndShow)
        XCTAssertEqual(departure.returnToExpanded(isExpanded: false), .hideUntilExpanded)

        XCTAssertEqual(departure.abandonReturn(), .showCompact)
        XCTAssertEqual(departure.receive(isExpanded: false), .applyNormally)
    }

    func testCompletedRequestDoesNotSuppressCorrectionAfterFrameDrifts() {
        var transition = SurfaceFrameTransition()
        let target = CGRect(x: 10, y: 20, width: 300, height: 120)
        XCTAssertEqual(transition.request(target, from: .zero, animated: true), .animate(target))
        transition.complete(target)

        let drifted = CGRect(x: 10, y: 20, width: 300, height: 64)
        XCTAssertEqual(transition.request(target, from: drifted, animated: false), .setImmediately(target))
    }

    func testSameInFlightTargetDoesNotRestartTheTransition() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let target = CGRect(x: 0, y: 0, width: 480, height: 620)

        XCTAssertEqual(transition.request(target, from: current, animated: true), .animate(target))
        XCTAssertEqual(transition.request(target, from: current, animated: true), .none)
    }

    func testNewTargetRetargetsInsteadOfDiscardingTheCurrentTransition() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let pocket = CGRect(x: 0, y: 0, width: 300, height: 240)
        let task = CGRect(x: 0, y: 0, width: 720, height: 700)

        XCTAssertEqual(transition.request(pocket, from: current, animated: true), .animate(pocket))
        XCTAssertEqual(transition.request(task, from: current, animated: true), .animateFrom(current, to: task))
    }

    func testReduceMotionSetsTheFrameImmediately() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let target = CGRect(x: 0, y: 0, width: 480, height: 620)

        XCTAssertEqual(transition.request(target, from: current, animated: false), .setImmediately(target))
    }

    func testSampleInterpolatesWithoutBlockingTheRequestingThread() {
        let from = CGRect(x: 500, y: 800, width: 348, height: 146)
        let to = CGRect(x: 72, y: 90, width: 1296, height: 810)
        let halfway = SurfaceFrameTransition.sample(from: from, to: to, progress: 0.5)

        XCTAssertEqual(halfway, CGRect(x: 286, y: 445, width: 822, height: 478))
    }

    func testRetargetBeginsAtTheCurrentPresentationFrame() {
        var transition = SurfaceFrameTransition()
        let original = CGRect(x: 500, y: 800, width: 348, height: 146)
        let firstTarget = CGRect(x: 72, y: 90, width: 1296, height: 810)
        let current = CGRect(x: 350, y: 560, width: 700, height: 370)
        let secondTarget = CGRect(x: 144, y: 180, width: 1152, height: 720)

        _ = transition.request(firstTarget, from: original, animated: true)
        XCTAssertEqual(transition.request(secondTarget, from: current, animated: true),
                       .animateFrom(current, to: secondTarget))
    }

    func testRepeatedExpandedUpdatePreservesAnInFlightPocketHandoff() {
        XCTAssertTrue(SurfaceContentHandoff.shouldPreserve(
            wasExpanded: true,
            destinationExpanded: true,
            contentReady: false,
            hasPocketSnapshot: true
        ))
    }

    func testPocketExpansionDoesNotWithholdPreparedExpandedContent() {
        XCTAssertFalse(SurfaceContentHandoff.shouldDelayExpandedContent(
            expandingFromPocket: true,
            contentPrepared: true
        ))
    }

    func testPocketExpansionCountsAsAnExplicitPresentationGesture() {
        XCTAssertTrue(SurfacePresentationIntent.isExplicitGesture(.pocketExpand))
    }

    func testExistingExpandedSurfaceAcceptsRoutineExpandedRefreshWhenAutoPresentIsOff() {
        XCTAssertTrue(SurfacePresentationPolicy.allowsExpandedRequest(
            autoPresent: false,
            surfaceIsAlreadyExpanded: true,
            hasRecentGesture: false
        ))
    }

    func testCompactSurfaceStillRejectsAutomaticExpandedRequestWhenAutoPresentIsOff() {
        XCTAssertFalse(SurfacePresentationPolicy.allowsExpandedRequest(
            autoPresent: false,
            surfaceIsAlreadyExpanded: false,
            hasRecentGesture: false
        ))
    }

    func testLeavingExpandedStateDoesNotPreserveThePocketHandoff() {
        XCTAssertFalse(SurfaceContentHandoff.shouldPreserve(
            wasExpanded: true,
            destinationExpanded: false,
            contentReady: false,
            hasPocketSnapshot: true
        ))
    }

    // ── THE INVARIANT A CALLER MUST HONOUR ──
    //
    // FIELD FAILURE (2026-08-31): the notch vanished and could not be hovered
    // back; only relaunching the app restored it. It was not small or dormant —
    // it was gone. begin() orderOuts the window and parks in .awaitingCompact,
    // and the ONLY exit is receive() with a compact state. The 0.35s rescue
    // timer cannot help, because abandonReturn() fires only from .returning.
    //
    // So a caller that accepts a state command and returns WITHOUT consulting
    // receive() strands the window off-screen permanently. The banner's
    // "nothing new to say" suppression did exactly that, and the window stayed
    // hidden for six hours across two commands that should each have restored
    // it. This pins the contract the state machine depends on.
    func testAWindowHiddenByDepartureIsRecoverableOnlyThroughReceive() {
        var t = SurfaceDepartureTransition()
        XCTAssertEqual(t.begin(isExpanded: true), .hide)

        // The fallback timer is not a rescue for this phase.
        XCTAssertEqual(t.abandonReturn(), .none)

        // Expanded updates keep it hidden, however many arrive.
        XCTAssertEqual(t.receive(isExpanded: true), .applyHidden)
        XCTAssertEqual(t.receive(isExpanded: true), .applyHidden)

        // One compact state is the entire recovery — miss it and nothing else
        // in the machine will show the window again.
        XCTAssertEqual(t.receive(isExpanded: false), .applyImmediatelyAndShow)
    }
}
