import SwiftUI

// Observable state the SwiftUI view renders. AppController mutates it in response
// to commands from Electron main; the view morphs via Theme.morph on change.
final class NotchModel: ObservableObject {
    @Published var state: NotchState = .idle
    @Published var attention: Int = 0        // your-move queue depth (peek counter)
    @Published var working: Int = 0          // our-move count (idle glow)
    @Published var task: PanelTask? = nil    // fronted task in the panel

    // Content footprints per state (from NotchGeometry). Defaults are overwritten
    // once real geometry arrives.
    var idleSize = NSSize(width: 160, height: 24)
    var peekSize = NSSize(width: 420, height: 72)
    var panelSize = NSSize(width: 640, height: 420)

    /// Event sink. Defaults to the real stdout emitter; overridable for tests.
    var emit: (Event) -> Void = IPC.emit

    func size(for state: NotchState) -> NSSize {
        switch state {
        case .idle:  return idleSize
        case .peek:  return peekSize
        case .panel: return panelSize
        }
    }
}
