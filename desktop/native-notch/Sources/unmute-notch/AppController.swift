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
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) menuBarH=\(Int(geometry.menuBarHeight)) notchW=\(Int(geometry.notchWidth)) | idle=\(geometry.idleSize) peek=\(geometry.peekSize) panel=\(geometry.panelSize)")
        window = NotchWindow(geometry: geometry)
        let host = NSHostingView(rootView: NotchView(model: model))
        // WE own the window size (AppController.frame(for:)); never let the
        // hosting view resize the window to the SwiftUI content's flexible
        // height (that was blowing the panel up to ~640px). Empty options = the
        // window is authoritative; the content fills whatever size we set.
        host.sizingOptions = []
        window.contentView = host
        // Every user gesture flows through here first so it's logged, then out.
        model.emit = { ev in NotchLog.log("EVENT out: \(ev.json)"); IPC.emit(ev) }
        window.present()
        NotchLog.log("presented at idle: window=\(NotchLog.rect(window.frame)) level=screenSaver visible=\(window.isVisible)")
    }

    func handle(_ command: Command) {
        NotchLog.log("CMD in: \(command)")
        switch command {
        case let .setState(state, attention, working):
            model.attention = attention
            model.working = working
            withAnimation(Theme.morph) { model.state = state }
            // The window IS the shape now, so resizing it top-pinned is the morph.
            let f = frame(for: state)
            window.applyFrame(f, animated: true)
            NotchLog.log("state -> \(state) (attention=\(attention) working=\(working)) window=\(NotchLog.rect(f))")

        case let .showTask(task):
            model.task = task
            NotchLog.log("showTask: id=\(task.id) title=\"\(task.title)\" state=\(task.state.rawValue) options=\(task.options?.count ?? 0)")

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
            window.applyFrame(frame(for: model.state), animated: false)

        case .collapse:
            withAnimation(Theme.morph) { model.state = .idle }
            model.task = nil

        case .quit:
            NSApp.terminate(nil)

        case .unknown:
            break
        }
    }

    /// Top-pinned frame for a state. Idle/peek use fixed sizes; the panel's
    /// height is measured from its SwiftUI content so it's a compact card, not a
    /// window with a void below the content.
    private func frame(for state: NotchState) -> NSRect {
        switch state {
        case .idle, .peek:
            return geometry.windowFrame(for: state)
        case .panel:
            let width = geometry.panelSize.width
            let contentWidth = width - 40 // NotchView horizontal padding (20 each side)
            let host = NSHostingController(rootView: PanelView(model: model))
            let fit = host.sizeThatFits(in: NSSize(width: contentWidth, height: 5000))
            let height = geometry.clampPanelHeight(fit.height + 32) // + vertical padding (16 each)
            return geometry.topPinnedFrame(width: width, height: height)
        }
    }

    private func applyGeometrySizes() {
        model.idleSize = geometry.idleSize
        model.peekSize = geometry.peekSize
        model.panelSize = geometry.panelSize
    }
}
