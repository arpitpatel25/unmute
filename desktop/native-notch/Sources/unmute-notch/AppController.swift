import AppKit
import SwiftUI
import SwiftTerm

// Owns the ONE panel + view model; translates commands into observable state,
// user gestures into events, and keeps the surface on the PRIMARY display.
final class AppController: NSObject, NotchResizing {
    private let model = NotchModel()
    private var window: NotchWindow!
    // The INPUT surface — bottom-centre, same process, same material system.
    // One helper owning both panels is what makes "one design system" true in
    // code rather than by discipline, and it means the ⌘V responder-chain fix
    // already covers the pill.
    private let pillModel = PillModel()
    private var pillWindow: PillWindow!
    private var pillHost: NSHostingView<AnyView>!
    private var geometry: NotchGeometry
    /// Kept because contentView is now a container, not the hosting view.
    private var hostView: NSHostingView<NotchView>!
    /// The last state MAIN commanded (hover-wake is local and never fights it).
    /// Mirrored onto the model so the view can gate anything that must not
    /// survive a morph — see NotchModel.commandedState.
    private var commandedState: NotchState = .dormant {
        didSet { model.commandedState = commandedState }
    }
    private var hoverTimer: Timer?
    private var toastTimer: Timer?

    override init() {
        geometry = NotchGeometry.current()
        super.init()
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) menuBarH=\(Int(geometry.menuBarHeight)) notchW=\(Int(geometry.notchWidth))")
        window = NotchWindow(geometry: geometry)
        // A plain container holds the SwiftUI view and the resize border as
        // SIBLINGS. The border cannot live inside the hosting view — SwiftUI
        // owns that view's subviews and is free to reorder or drop them.
        let host = NSHostingView(rootView: NotchView(model: model, topInset: topInset))
        host.sizingOptions = []   // WE own the window size
        hostView = host
        let container = NSView(frame: .zero)
        container.autoresizingMask = [.width, .height]
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        window.contentView = container
        host.frame = container.bounds
        window.resizer = self
        model.hasNotch = geometry.hasNotch
        model.emit = { [weak self] ev in
            NotchLog.log("EVENT out: \(ev.json)")
            IPC.emit(ev)
            self?.afterEmit(ev)
        }
        model.onHover = { [weak self] entering in self?.handleHover(entering) }
        installPill()
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

    // MARK: - The input surface

    private func installPill() {
        pillWindow = PillWindow()
        pillModel.emit = { ev in
            NotchLog.log("PILL EVENT out: \(ev.json)")
            IPC.emit(ev)
        }
        pillWindow.fit(geometry: geometry)
        let host = NSHostingView(rootView: AnyView(PillHost(model: pillModel)))
        host.sizingOptions = []
        pillHost = host
        pillWindow.contentView = host
        reconcilePillVisibility()
    }

    /// The pill exists only while a capture does. Hidden means ORDERED OUT, not
    /// zero-alpha: an invisible always-on panel still sits in the window server
    /// and still competes for clicks.
    private func reconcilePillVisibility() {
        if pillModel.visible {
            if !pillWindow.isVisible { pillWindow.present() }
        } else if pillWindow.isVisible {
            pillWindow.orderOut(nil)
        }
    }

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

        case let .appearance(pref):
            NotchLog.log("CMD appearance \(pref.rawValue)")
            Appearance.shared.preference = pref

        case let .pill(state):
            // Logged at phase granularity only — the level field changes every
            // frame during a capture and would drown the log.
            if state.phase != pillModel.state.phase {
                NotchLog.log("CMD pill phase=\(state.phase.rawValue) kind=\(state.kind.rawValue)")
            }
            pillModel.state = state
            reconcilePillVisibility()

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
        // Each visit starts at the hard-coded size. A size dragged out for one
        // look at a task is not a preference — carrying it across would make the
        // surface's size a hidden setting the user never chose to persist.
        if state != .task && state != .cockpit { userScale = 1 }
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
        // Same duration as the content's own animation, so the frame and what is
        // drawn inside it arrive together.
        window.applyFrame(f, animated: true, duration: up ? 0.42 : 0.30)
        NotchLog.log("state -> \(state.rawValue) window=\(NotchLog.rect(f))")
    }

    /// The Stage/wall keep the cockpit frame; the task surface is content-sized.
    private func frame(for state: NotchState) -> NSRect {
        var size: NSSize
        if state == .task {
            // Codex tasks were briefly given a compact frame, back when the
            // panel had nothing but two buttons to show. They now carry a full
            // transcript and a composer, so they want the same room as a
            // terminal.
            size = geometry.taskSize
        } else {
            size = geometry.size(for: state)
        }

        // USER SCALE — one factor on BOTH axes, so any drag from any edge makes
        // the whole surface bigger rather than stretching it one way. Only the
        // expanded surfaces are resizable; the resting states are fixed.
        if userScale != 1, state == .task || state == .cockpit {
            var w = size.width * userScale
            var h = size.height * userScale
            // The cockpit NEVER goes below its own default. Carrying a smaller
            // task-view scale into it would shrink the wall, and the wall's
            // default is deliberately the larger of the two.
            if state == .cockpit {
                w = max(w, geometry.cockpitSize.width)
                h = max(h, geometry.cockpitSize.height)
            }
            size = NSSize(width: round(w), height: round(h))
        }
        return geometry.topPinnedFrame(width: size.width, height: size.height)
    }

    // MARK: - Drag to resize (session-scoped)

    /// How much bigger the user has dragged the current surface. Reset to 1 on
    /// every collapse, so each visit opens at the hard-coded size and growing it
    /// again is a fresh, deliberate choice.
    private var userScale: CGFloat = 1
    private var dragAnchor: (mouse: NSPoint, scale: CGFloat)?

    /// A drag anywhere on the resize border scales BOTH axes together — there is
    /// no separate width handle and height handle, just "make it bigger".
    /// Distance is measured from the panel's centre, so pulling outward from any
    /// edge or corner grows it and pushing inward shrinks it.
    func beginResize(at pointInWindow: NSPoint) {
        dragAnchor = (mouse: NSEvent.mouseLocation, scale: userScale)
    }

    func continueResize() {
        guard let anchor = dragAnchor else { return }
        let f = window.frame
        let centre = NSPoint(x: f.midX, y: f.maxY)          // top-pinned: grow from the top centre
        let start = hypot(anchor.mouse.x - centre.x, anchor.mouse.y - centre.y)
        let now = NSEvent.mouseLocation
        let current = hypot(now.x - centre.x, now.y - centre.y)
        guard start > 8 else { return }
        let raw = anchor.scale * (current / start)
        userScale = min(max(raw, 0.6), maxScale())
        window.applyFrame(frame(for: model.state), animated: false)
    }

    func endResize() { dragAnchor = nil }

    /// Never larger than the screen it lives on.
    private func maxScale() -> CGFloat {
        let base = model.state == .cockpit ? geometry.cockpitSize : geometry.taskSize
        let sw = geometry.screenFrame.width * 0.98 / max(base.width, 1)
        let sh = (geometry.screenFrame.height - geometry.menuBarHeight) * 0.98 / max(base.height, 1)
        return max(1, min(sw, sh))
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
            guard let self, e.keyCode == 53 else { return }
            // A global monitor is OBSERVE-ONLY — it cannot consume the event, so
            // reaching here while expanded means the Escape ALSO landed in the
            // app underneath. That is the leak, and this line names it.
            if self.model.state == .task || self.model.state == .cockpit {
                NotchLog.log("esc: GLOBAL monitor while expanded — LEAKED to the app below (key=\(self.window.isKeyWindow))")
            }
            self.stepDown()
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            // Never steal keys from a text field or the terminal.
            let fr = self.window.firstResponder
            let typing = fr is NSTextView || fr is TerminalView
            if e.keyCode == 53 {
                // Logged so a leak is DIAGNOSABLE rather than inferred: if this
                // line is absent when Escape leaks, the local monitor never
                // fired and the panel was not key (see NotchWindow).
                NotchLog.log("esc: LOCAL monitor (swallowed) state=\(self.model.state.rawValue) key=\(self.window.isKeyWindow)")
                self.stepDown(); return nil
            }

            // ⌘V AND FRIENDS, BECAUSE NOTHING ELSE WILL DELIVER THEM.
            //
            // On macOS the editing commands are MENU commands: AppKit receives
            // ⌘V, asks the main menu who claims it, and drops it if nobody does.
            // This app is `.accessory` and builds no menu, so ⌘V/⌘C/⌘X/⌘A were
            // discarded everywhere in the notch — the rename field, the note
            // field, the Codex composer, the terminal. Typing worked because raw
            // characters go straight to the first responder without consulting
            // any menu; that asymmetry is what made this look terminal-specific
            // when it never was.
            //
            // It also broke DICTATION into the notch, which is the same thing
            // wearing a different hat: unmute pastes by posting a synthetic ⌘V,
            // and a synthetic ⌘V is indistinguishable from a real one — so it
            // died at the same missing menu.
            //
            // sendAction(to: nil) walks the responder chain, so each of these
            // lands on whatever is focused. Every target already implements the
            // selector (NSTextView, NSTextField, and SwiftTerm's TerminalView);
            // SwiftTerm does NOT claim key equivalents itself, so there is no
            // double-handling.
            if e.modifierFlags.contains(.command), !e.modifierFlags.contains(.control),
               let ch = e.charactersIgnoringModifiers?.lowercased() {
                let shift = e.modifierFlags.contains(.shift)
                let action: Selector? = {
                    switch ch {
                    case "v": return #selector(NSText.paste(_:))
                    case "c": return #selector(NSText.copy(_:))
                    case "x": return #selector(NSText.cut(_:))
                    case "a": return #selector(NSText.selectAll(_:))
                    // UNDO / REDO — the same bug as ⌘V, and it was simply not on
                    // the list. ⌘Z and ⌘⇧Z are menu commands too, so with no
                    // main menu they were discarded everywhere: the rename
                    // field, the note field, the Codex composer, the terminal.
                    // Renaming a task and being unable to undo it is this, not a
                    // clipboard problem and not a one-off.
                    //
                    // These selectors are informal (NSResponder forwards them to
                    // the first responder's undoManager), so they are named
                    // rather than #selector'd.
                    case "z": return Selector((shift ? "redo:" : "undo:"))
                    default:  return nil
                    }
                }()
                if let action, NSApp.sendAction(action, to: nil, from: nil) {
                    NotchLog.log("edit command handled: ⌘\(ch)")
                    return nil
                }
            }

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
        hostView?.rootView = NotchView(model: model, topInset: topInset)
        let f = frame(for: model.state)
        window.applyFrame(f, animated: false)
        // The pill is bottom-anchored to the PRIMARY display's visible frame, so
        // it has to move too — plugging in a monitor, or moving the menu bar to
        // one, relocates both surfaces together. Its size preference does not
        // re-fire on a screen change, so refit explicitly from the current frame.
        pillWindow?.fit(geometry: geometry)
        NotchLog.log("geometry recomputed (\(reason)): screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) → window=\(NotchLog.rect(f))")
    }
}
