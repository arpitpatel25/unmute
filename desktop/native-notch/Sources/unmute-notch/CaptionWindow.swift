import AppKit
import SwiftUI

/// The Agent's voice, such as it is.
///
/// NOT SPEECH. Synthesised voices are unwelcome, unusable in company, and
/// slower to take in than a glance. NOT A PANEL either: anything that slides in
/// with a chrome, a border and a title reads as ANOTHER APP OPENING — the exact
/// feeling an agent whose whole purpose is to abstract the session away must
/// avoid.
///
/// A caption belongs to the machine. It is ambient, non-modal, and gone a
/// moment later. The user asked their computer something and their computer
/// answered.
///
/// DELIBERATELY NOT THE NOTCH. It descends from neither the notch nor the pill,
/// and it sits at the centre of the LOWER HALF of the screen — where captions
/// live. Anything falling from the top of the display reads as the notch
/// talking rather than the computer, which is a different and much smaller
/// idea.
final class CaptionWindow: NSPanel {

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 96),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .screenSaver
        // Same reasoning as PillWindow: no `.stationary`, which strands the
        // backdrop on whichever Space it last sampled.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        sharingType = .readOnly
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        becomesKeyOnlyIfNeeded = true
        // The body is click-through; only the close control accepts a click.
        // The moment a caption intercepts a click meant for the app underneath,
        // it stops being a caption and becomes a window.
        ignoresMouseEvents = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Horizontally centred, vertically at 65% down — the lower third of the
    /// screen, not the floor of it. Sitting lower reads as belonging to the
    /// dock and the pill; this height is where the eye already rests when
    /// reading, and far enough above the bottom furniture to never collide
    /// with it.
    ///
    /// Placed against the screen with the mouse on it, so a caption answers on
    /// the display the user is actually looking at.
    func positionOnActiveScreen() {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
            ?? NSScreen.main
        guard let frame = screen?.frame else { return }
        let size = self.frame.size
        let x = frame.midX - size.width / 2
        // AppKit's origin is bottom-left, so "65% down the screen" is 35% up.
        let y = frame.minY + frame.height * 0.35 - size.height / 2
        setFrameOrigin(NSPoint(x: x.rounded(), y: y.rounded()))
    }
}
