import AppKit
import CoreGraphics
import XCTest
@testable import SurfaceStateSupport

final class SurfaceInteractionStateTests: XCTestCase {
    // THE POCKET'S MORPH TESTS LIVED HERE — five of them, all describing a
    // second size that no longer exists: the growth order, the no-reversal
    // rule, the capture-keeps-it-open rule, and the exit that could only be
    // applied at a settlement boundary. The pocket has ONE size now, so there
    // is no morph to sequence and nothing here to assert about it.
    //
    // What replaced them is a geometry test: PocketRow measures its two
    // shoulders and PocketCard states its own height, and both are exercised
    // through NotchGeometry rather than through this reducer.

    func testPointerOnlyTracksTheBar() {
        var state = SurfaceInteractionState()
        state.reduce(.pointerEntered(.bar))
        XCTAssertTrue(state.presentation.barHovered)
        state.reduce(.pointerExited(.bar))
        XCTAssertFalse(state.presentation.barHovered)
    }

    func testRepeatedTaskEntryDoesNotResetExplicitTerminalChoice() {
        var state = SurfaceInteractionState()
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: true, requiresTerminal: false))
        state.reduce(.terminalVisibilityChanged(false))
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: true, requiresTerminal: false))
        XCTAssertFalse(state.terminalVisible)
    }

    func testNewTaskAppliesItsTerminalDefault() {
        var state = SurfaceInteractionState()
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: false, requiresTerminal: false))
        state.reduce(.terminalVisibilityChanged(true))
        state.reduce(.taskEntered(id: "b", terminalDefaultOpen: false, requiresTerminal: false))
        XCTAssertFalse(state.terminalVisible)
    }

    func testDictationPillAlwaysHasAWindowLevelAboveTheNotch() {
        _ = NSApplication.shared
        let notch = NSPanel(contentRect: NSRect(x: 20, y: 20, width: 30, height: 30),
                            styleMask: .borderless, backing: .buffered, defer: false)
        let pill = NSPanel(contentRect: NSRect(x: 25, y: 25, width: 30, height: 30),
                           styleMask: .borderless, backing: .buffered, defer: false)
        defer { notch.orderOut(nil); pill.orderOut(nil) }
        notch.level = .screenSaver
        pill.level = NSWindow.Level(rawValue: SurfaceWindowPriority.pillLevel(above: notch.level.rawValue))
        notch.orderFrontRegardless()
        pill.orderFrontRegardless()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))

        func serverLayer(_ window: NSWindow) -> Int? {
            let info = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]]
            return info?.first(where: {
                ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == window.windowNumber
            }).flatMap { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue }
        }

        guard let notchLayer = serverLayer(notch), let pillLayer = serverLayer(pill) else {
            XCTFail("the ordered test panels must be registered with WindowServer")
            return
        }
        XCTAssertGreaterThan(pillLayer, notchLayer,
                             "the WindowServer must keep the active pill above an expanded notch")
    }

}
