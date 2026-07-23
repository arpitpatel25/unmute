import AppKit
import SwiftUI

// Owns the notch window + view model, and translates decoded commands from
// Electron main into observable state (which the SwiftUI view animates). Runs on
// the main thread — main.swift dispatches every command here on the main queue.
final class AppController {
    private let model = NotchModel()
    private var window: NotchWindow!
    private var geometry: NotchGeometry

    init() {
        geometry = NotchGeometry.current()
        applyGeometrySizes()
        window = NotchWindow(geometry: geometry)
        window.contentView = NSHostingView(rootView: NotchView(model: model))
        window.present()
    }

    func handle(_ command: Command) {
        switch command {
        case let .setState(state, attention, working):
            model.attention = attention
            model.working = working
            withAnimation(Theme.morph) { model.state = state }
            // A panel needs pointer input; idle/peek let clicks through except on
            // the shape (the tap gesture still fires because the shape is opaque).
            window.ignoresMouseEvents = false

        case let .showTask(task):
            model.task = task

        case let .notchGeometry(hasNotch, x, y, w, h):
            // Trust an explicit geometry push from main (it knows the active
            // display); fall back to what we computed locally.
            geometry = NotchGeometry(
                screenFrame: NSScreen.main?.frame ?? .zero,
                hasNotch: hasNotch,
                notchWidth: w > 0 ? w : geometry.notchWidth,
                menuBarHeight: h > 0 ? h : geometry.menuBarHeight
            )
            _ = (x, y) // reserved for multi-display placement (Stage 7)
            applyGeometrySizes()
            window.applyGeometry(geometry)

        case .collapse:
            withAnimation(Theme.morph) { model.state = .idle }
            model.task = nil

        case .quit:
            NSApp.terminate(nil)

        case .unknown:
            break
        }
    }

    private func applyGeometrySizes() {
        model.idleSize = geometry.idleSize
        model.peekSize = geometry.peekSize
        model.panelSize = geometry.panelSize
    }
}
