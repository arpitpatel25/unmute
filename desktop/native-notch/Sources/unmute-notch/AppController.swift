import AppKit

// Owns the notch window and translates decoded commands into view state.
// (Stage 1.1: only the quit path is live; the window + view arrive in 1.2/1.3.)
final class AppController {
    func handle(_ command: Command) {
        switch command {
        case .quit:
            NSApp.terminate(nil)
        case .setState, .showTask, .notchGeometry, .collapse, .unknown:
            break // wired up in later tasks
        }
    }
}
