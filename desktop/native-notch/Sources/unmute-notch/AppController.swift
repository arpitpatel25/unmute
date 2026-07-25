import AppKit
import SwiftUI
import SwiftTerm

// Owns the ONE panel + view model; translates commands into observable state,
// user gestures into events, and keeps the surface on the PRIMARY display.
final class AppController: NSObject {
    private let model = NotchModel()
    private var window: NotchWindow!
    private var geometry: NotchGeometry
    /// The last state MAIN commanded (hover-wake is local and never fights it).
    private var commandedState: NotchState = .dormant
    private var hoverTimer: Timer?
    private var toastTimer: Timer?

    override init() {
        geometry = NotchGeometry.current()
        super.init()
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) menuBarH=\(Int(geometry.menuBarHeight)) notchW=\(Int(geometry.notchWidth))")
        window = NotchWindow(geometry: geometry)
        let host = NSHostingView(rootView: NotchView(model: model, topInset: topInset))
        host.sizingOptions = []   // WE own the window size
        window.contentView = host
        model.hasNotch = geometry.hasNotch
        model.emit = { [weak self] ev in
            NotchLog.log("EVENT out: \(ev.json)")
            IPC.emit(ev)
            self?.afterEmit(ev)
        }
        model.onHover = { [weak self] entering in self?.handleHover(entering) }
        window.applyFrame(frame(for: .dormant), animated: false)
        window.present()
        installTracking()
        installKeyMonitors()
        observeScreens()
        NotchLog.log("presented at dormant: window=\(NotchLog.rect(window.frame)) visible=\(window.isVisible)")
    }

    /// Content inset that clears the physical notch (notched ≈ menu bar height
    /// + breathing room) or just the surface's own chrome on plain displays.
    private var topInset: CGFloat { geometry.hasNotch ? geometry.menuBarHeight + 10 : 14 }

    // MARK: - Commands in

    func handle(_ command: Command) {
        switch command {
        case let .setState(state, attention, working):
            NotchLog.log("CMD setState \(state.rawValue) attention=\(attention) working=\(working)")
            model.attention = attention
            model.working = working
            commandedState = state
            applyState(state)

        case let .showTask(task):
            NotchLog.log("CMD showTask id=\(task.id) status=\(task.status.rawValue)")
            model.task = task

        case let .stageDetail(task):
            NotchLog.log("CMD stageDetail id=\(task.id) status=\(task.status.rawValue)")
            // Only meaningful while this task is (still) the focused one.
            if model.focusedId == nil || model.focusedId == task.id {
                model.focusedId = task.id
                model.stageTask = task
                refit()
            }

        case let .setCockpit(data):
            NotchLog.log("CMD setCockpit groups=\(data.groups.count) queue=\(data.queue.count) skills=\(data.skills.count) suggestions=\(data.suggestions.count)")
            model.cockpit = data
            // Focused task vanished (removed/purged) → back to the wall.
            if let f = model.focusedId, !data.groups.flatMap(\.cards).contains(where: { $0.id == f }) {
                model.focusedId = nil
                model.stageTask = nil
            }

        case let .termData(id, b64):
            if let data = Data(base64Encoded: b64) {
                model.termBytes.send((id: id, bytes: [UInt8](data)))
            }

        case let .proposal(detail):
            NotchLog.log("CMD proposal id=\(detail.id) kind=\(detail.kind)")
            model.proposalLoadingId = nil
            model.proposal = detail

        case let .convData(_, text):
            model.convLog += text
            if model.convLog.count > 20_000 { model.convLog = String(model.convLog.suffix(16_000)) }

        case let .capturePhase(phase, target):
            model.capturePhase = phase.isEmpty || phase == "idle" ? nil : phase
            model.captureTarget = target

        case let .toast(text):
            showToast(text)

        case .notchGeometry:
            recomputeGeometry("explicit-push")

        case .collapse:
            model.focusedId = nil
            model.stageTask = nil
            model.task = nil
            commandedState = .dormant
            applyState(.dormant)

        case .quit:
            NSApp.terminate(nil)

        case .unknown:
            break
        }
    }

    // MARK: - State / frames

    private func applyState(_ state: NotchState) {
        let up = rung(state) >= rung(model.state)
        if state != .cockpit { model.focusedId = nil; model.stageTask = nil }
        // Terminal is OPEN BY DEFAULT on the task surface ("hide terminal" is
        // the choice); reset when leaving so re-entry starts open again.
        model.taskTerminalOpen = (state == .task)
        withAnimation(up ? Theme.morph : Theme.collapse) { model.state = state }
        let engaged = (state == .task || state == .cockpit)
        window.allowsKey = engaged
        // ESC MUST NOT LEAK TO THE APP UNDERNEATH.
        //
        // `allowsKey` alone only makes the panel key-ABLE; with
        // becomesKeyOnlyIfNeeded the panel stays non-key until something that
        // needs keys (a field, the terminal) is clicked. So opening the cockpit
        // over, say, a terminal left key focus with the terminal — Escape then
        // reached only the GLOBAL monitor, which macOS defines as observe-only.
        // The result: the cockpit collapsed AND the Escape also landed in the
        // user's Claude Code session underneath, cancelling whatever it was
        // doing. (Reported from the field 2026-07-25.)
        //
        // Taking key while engaged routes Escape through the LOCAL monitor
        // instead, which returns nil and genuinely swallows it. This is a
        // nonactivating panel, so we take the KEYBOARD without activating our
        // app or disturbing the user's frontmost window; on step-down
        // `allowsKey = false` resigns key and the keyboard goes straight back.
        if engaged {
            if !window.isKeyWindow { window.makeKey() }
        }
        let f = frame(for: state)
        window.applyFrame(f, animated: true)
        NotchLog.log("state -> \(state.rawValue) window=\(NotchLog.rect(f))")
    }

    /// The Stage/wall keep the cockpit frame; the task surface is content-sized.
    private func frame(for state: NotchState) -> NSRect {
        if state == .task {
            // No terminal ⇒ no need for terminal-sized real estate.
            let size = geometry.taskSize(compact: model.frontDetail?.backend == "codex-desktop")
            return geometry.topPinnedFrame(width: size.width, height: size.height)
        }
        return geometry.windowFrame(for: state)
    }
    private func refit() {
        window.applyFrame(frame(for: model.state), animated: false)
    }

    private func rung(_ s: NotchState) -> Int {
        switch s {
        case .dormant: return 0; case .idle: return 1; case .active: return 2
        case .attention: return 3; case .task: return 4; case .cockpit: return 5
        }
    }

    private func showToast(_ text: String) {
        model.toast = text
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 1.8, repeats: false) { [weak self] _ in
            self?.model.toast = nil
        }
    }

    /// Local reactions to our own emits (snappy UI; main remains authoritative).
    private func afterEmit(_ ev: Event) {
        switch ev {
        case .focusTask(let id):
            model.focusedId = id
            model.stageTask = nil // stageDetail arrives from main
        case .closeStage:
            model.focusedId = nil
            model.stageTask = nil
        case .suggestionAccept, .suggestionReject:
            model.proposal = nil
            model.convLog = ""
        default: break
        }
    }

    // MARK: - Hover wake (dormant ⇄ idle, local-only)

    private func installTracking() {
        guard let cv = window.contentView else { return }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        cv.addTrackingArea(area)
    }
    /// Shared, idempotent hover-wake (fed by BOTH the SwiftUI .onHover relay and
    /// the AppKit tracking area — SwiftUI's own tracking can miss a never-key
    /// panel, which is exactly the dormant window; two paths, one behavior).
    func handleHover(_ entering: Bool) {
        if entering {
            hoverTimer?.invalidate()
            if model.state == .dormant && commandedState == .dormant {
                NotchLog.log("hover-wake: dormant → idle")
                withAnimation(Theme.morph) { model.state = .idle }
                window.applyFrame(frame(for: .idle), animated: true)
            }
        } else {
            guard model.state == .idle, commandedState == .dormant else { return }
            hoverTimer?.invalidate()
            hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                guard let self, self.model.state == .idle, self.commandedState == .dormant else { return }
                NotchLog.log("hover-sleep: idle → dormant")
                withAnimation(Theme.collapse) { self.model.state = .dormant }
                self.window.applyFrame(self.frame(for: .dormant), animated: true)
            }
        }
    }
    @objc func mouseEntered(with event: NSEvent) { handleHover(true) }
    @objc func mouseExited(with event: NSEvent) { handleHover(false) }

    // MARK: - Keyboard (Esc ladder · Tab crank · F full · 1-9 answers)

    private func installKeyMonitors() {
        // Global Esc: collapse even when we're not key (never required to
        // dismiss the resting state — only steps ENGAGED states down).
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 { self?.stepDown() }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            // Never steal keys from a text field or the terminal.
            let fr = self.window.firstResponder
            let typing = fr is NSTextView || fr is TerminalView
            if e.keyCode == 53 { self.stepDown(); return nil }
            if typing { return e }
            guard self.model.state == .cockpit || self.model.state == .task else { return e }
            if e.keyCode == 48 { self.model.emit(.next); return nil }            // Tab → crank
            if let ch = e.charactersIgnoringModifiers?.lowercased() {
                if ch == "f", self.model.state == .cockpit, self.model.focusedId != nil {
                    self.model.stageFull.toggle(); return nil
                }
                if let n = Int(ch), n >= 1, n <= 9,
                   let t = self.model.frontDetail, t.status == .needsUser,
                   let choices = t.question?.choices, n <= choices.count {
                    self.model.emit(.chooseOption(id: t.id, index: n - 1)); return nil
                }
            }
            return e
        }
    }

    /// Esc: one rung down. Stage full→split→wall; task/cockpit → collapsed
    /// (main then reconciles to attention/active/dormant).
    private func stepDown() {
        if model.proposal != nil || model.proposalLoadingId != nil {
            if let p = model.proposal { model.emit(.converseStop(id: p.id)) }
            model.proposal = nil; model.proposalLoadingId = nil; model.convLog = ""
            return
        }
        switch model.state {
        case .cockpit:
            if model.focusedId != nil {
                if model.stageFull { model.stageFull = false }
                else { model.emit(.closeStage); model.focusedId = nil; model.stageTask = nil }
            } else {
                model.emit(.collapsed)
            }
        case .task, .attention, .active, .idle:
            model.emit(.collapsed)
        case .dormant:
            break
        }
    }

    // MARK: - Displays

    private func observeScreens() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.recomputeGeometry("screen-params-changed") }
    }
    private func recomputeGeometry(_ reason: String) {
        geometry = NotchGeometry.current()
        model.hasNotch = geometry.hasNotch
        // topInset feeds the view tree — rebuild the root so it picks it up.
        if let host = window.contentView as? NSHostingView<NotchView> {
            host.rootView = NotchView(model: model, topInset: topInset)
        }
        let f = frame(for: model.state)
        window.applyFrame(f, animated: false)
        NotchLog.log("geometry recomputed (\(reason)): screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) → window=\(NotchLog.rect(f))")
    }
}
