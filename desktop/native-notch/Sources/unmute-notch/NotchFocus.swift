import AppKit

/// Giving the caret back.
///
/// `makeFirstResponder` appeared NOWHERE in this app, and AppKit only reassigns
/// first responder when another responder accepts it — a SwiftUI `Text`, a
/// background, a `VStack` all decline. So a composer that took the caret kept it
/// for as long as the window stayed key, and every click inside the notch was
/// inert. Users had to click a different application to get out of a text box
/// they were finished with.
///
/// Releasing it here also settles the other half for free: the text view's
/// `resignFirstResponder` fires, which is what emits `composerFocus(false)` — so
/// the engine's idea of which composer owns the caret cannot drift out of step
/// with AppKit's.
enum NotchFocus {
    static func release() {
        guard let window = NSApp.keyWindow, window.firstResponder !== window else { return }
        window.makeFirstResponder(nil)
    }
}
