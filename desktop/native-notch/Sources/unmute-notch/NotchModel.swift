import SwiftUI

// Observable state the SwiftUI surface renders. AppController mutates it in
// response to commands; the view morphs via Theme.morph on change.
final class NotchModel: ObservableObject {
    @Published var state: NotchState = .dormant
    @Published var attention: Int = 0        // your-move queue depth
    @Published var working: Int = 0          // our-move count
    @Published var task: PanelTask? = nil    // the fronted task (task state)
    @Published var cockpit: CockpitData? = nil

    /// Event sink. Defaults to the real stdout emitter; overridable for tests.
    var emit: (Event) -> Void = IPC.emit
}
