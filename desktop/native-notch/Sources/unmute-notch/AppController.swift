import AppKit
import SwiftUI

// Owns the ONE panel + view model, translates commands into observable state,
// and keeps the surface on the PRIMARY display across monitor changes.
final class AppController {
    private let model = NotchModel()
    private var window: NotchWindow!
    private var geometry: NotchGeometry

    init() {
        geometry = NotchGeometry.current()
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) menuBarH=\(Int(geometry.menuBarHeight)) notchW=\(Int(geometry.notchWidth))")
        window = NotchWindow(geometry: geometry)
        let host = NSHostingView(rootView: NotchView(model: model))
        host.sizingOptions = []   // WE own the window size, not the SwiftUI content
        window.contentView = host
        model.emit = { ev in NotchLog.log("EVENT out: \(ev.json)"); IPC.emit(ev) }
        window.applyFrame(frame(for: .dormant), animated: false)
        window.present()

        // Stay on the primary display and correctly placed when monitors change
        // (plug/unplug external, resolution change). Never hardcoded — always
        // recomputed from the primary screen frame.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.recomputeGeometry("screen-params-changed") }

        NotchLog.log("presented at dormant: window=\(NotchLog.rect(window.frame)) visible=\(window.isVisible)")

        // Escape steps the surface DOWN (spec 2026-07-24) — the only way out of
        // task/cockpit, since there's no window chrome. Global monitor catches it
        // even though the panel is non-activating; local monitor swallows it when
        // we're key (e.g. a focused field). Only acts while engaged, so Esc in
        // another app never disturbs the resting surface.
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 { self?.stepDown() }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53, let self, self.isEngaged { self.stepDown(); return nil }
            return e
        }
    }

    private var isEngaged: Bool { model.state == .task || model.state == .cockpit || model.state == .attention }

    /// Esc: emit a step-down so Electron collapses the surface one level toward
    /// its calm baseline.
    private func stepDown() {
        guard isEngaged else { return }
        NotchLog.log("Esc → stepDown from \(model.state.rawValue)")
        model.emit(.collapsed)
    }

    func handle(_ command: Command) {
        NotchLog.log("CMD in: \(command)")
        switch command {
        case let .setState(state, attention, working):
            model.attention = attention
            model.working = working
            let up = rung(state) >= rung(model.state)
            withAnimation(up ? Theme.morph : Theme.collapse) { model.state = state }
            let f = frame(for: state)
            window.applyFrame(f, animated: true)
            NotchLog.log("state -> \(state.rawValue) (attention=\(attention) working=\(working)) window=\(NotchLog.rect(f))")

        case let .showTask(task):
            model.task = task
            NotchLog.log("showTask: id=\(task.id) title=\"\(task.title)\" state=\(task.state.rawValue) options=\(task.options?.count ?? 0)")

        case let .setCockpit(data):
            model.cockpit = data
            NotchLog.log("setCockpit: tasks=\(data.tasks.count) queue=\(data.queue.count) projects=\(data.projects.count) suggestions=\(data.suggestions.count)")
            // If we're showing the cockpit, refit (task count can't change our
            // fixed 80% frame, but keep it authoritative).
            if model.state == .cockpit { window.applyFrame(frame(for: .cockpit), animated: false) }

        case .notchGeometry:
            recomputeGeometry("explicit-push")

        case .collapse:
            withAnimation(Theme.collapse) { model.state = .dormant }
            model.task = nil
            window.applyFrame(frame(for: .dormant), animated: true)

        case .quit:
            NSApp.terminate(nil)

        case .unknown:
            break
        }
    }

    private func recomputeGeometry(_ reason: String) {
        geometry = NotchGeometry.current()
        let f = frame(for: model.state)
        window.applyFrame(f, animated: false)
        NotchLog.log("geometry recomputed (\(reason)): screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) → window=\(NotchLog.rect(f))")
    }

    /// Top-pinned frame for a state. Task height is measured from its content and
    /// clamped; everything else uses the geometry's fixed/fractional size.
    private func frame(for state: NotchState) -> NSRect {
        if state == .task {
            let width = geometry.taskSize.width
            let host = NSHostingController(rootView: TaskView(model: model))
            let fit = host.sizeThatFits(in: NSSize(width: width, height: 5000))
            let height = geometry.clampTaskHeight(fit.height)
            return geometry.topPinnedFrame(width: width, height: height)
        }
        return geometry.windowFrame(for: state)
    }

    /// Ladder index for choosing expand vs collapse spring.
    private func rung(_ s: NotchState) -> Int {
        switch s {
        case .dormant: return 0
        case .idle: return 1
        case .active: return 2
        case .attention: return 3
        case .task: return 4
        case .cockpit: return 5
        }
    }
}
