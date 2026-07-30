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
    // The pad — held work, waiting for a destination. A SEPARATE panel because
    // it outlives the pill: the pill exists only while a capture does, and the
    // whole point of the scratchpad is accumulating across several.
    private let scratchModel = ScratchpadModel()
    private var scratchWindow: ScratchpadWindow!
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
        scratchModel.emit = { ev in
            NotchLog.log("PAD EVENT out: \(ev.json)")
            IPC.emit(ev)
        }
        pillWindow.fit(geometry: geometry)
        let host = NSHostingView(rootView: AnyView(PillHost(model: pillModel, scratch: scratchModel)))
        host.sizingOptions = []
        pillHost = host
        pillWindow.contentView = host

        // The pad's panel. Non-activating for the same reason the pill's is —
        // see ScratchpadWindow: taking focus would kill the insertion point the
        // user is about to deliver into.
        scratchWindow = ScratchpadWindow()
        scratchWindow.fit(geometry: geometry)
        let padHost = NSHostingView(rootView: ScratchpadHost(model: scratchModel))
        padHost.sizingOptions = []
        scratchWindow.contentView = padHost

        reconcileSurfaces()
    }

    /// THE TWO INPUT SURFACES ARE MUTUALLY EXCLUSIVE, so they must be decided
    /// together — either one changing can change the other's answer.
    private func reconcileSurfaces() {
        reconcilePillVisibility()
        reconcilePadVisibility()
    }

    /// The pill exists only while a capture does. Hidden means ORDERED OUT, not
    /// zero-alpha: an invisible always-on panel still sits in the window server
    /// and still competes for clicks.
    private func reconcilePillVisibility() {
        if pillModel.visible {
            if !pillWindow.isVisible {
                pillWindow.present()
                // Shown after being ordered out — whatever it last sampled may
                // belong to a different Space entirely. Re-sample on the way in.
                Appearance.shared.invalidateBackdrop()
            }
        } else if pillWindow.isVisible {
            pillWindow.orderOut(nil)
        }
    }

    /// The pad is on screen only when it HOLDS something, and NEVER while the
    /// pill is up. Same ordered-out rule as the pill, for the same reason: an
    /// invisible always-on panel still sits in the window server and still
    /// competes for clicks.
    ///
    /// THE PILL WINS THE SLOT. The pad's bottom edge is the top of the pill
    /// cluster plus the cluster's own 9pt row spacing — which is exactly where
    /// `PillView.content` puts the mic-status hint and the model/agent selector.
    /// Both windows are `.screenSaver` and the pad orders itself front as it
    /// appears, so a co-visible pad would cover the coaching line and the
    /// selector panel — the selector being opened by a click on the very
    /// cluster the scratchpad chip lives in.
    ///
    /// Making them exclusive rather than nudging the pad upward is the honest
    /// fix: while a capture is running the PILL is the surface, the pad's
    /// destinations are not actionable yet (the set is still changing, and
    /// pasting at a cursor mid-dictation would fight the capture), and the pad
    /// carries nothing the icon's armed state does not already say. The pad
    /// returns the moment the capture's pill goes away, in the same place it
    /// always sits — it never has to move to dodge anything.
    private func reconcilePadVisibility() {
        guard let scratchWindow else { return }
        if scratchModel.visible && !pillModel.visible {
            if !scratchWindow.isVisible {
                scratchWindow.present()
                Appearance.shared.invalidateBackdrop()
            }
        } else if scratchWindow.isVisible {
            scratchWindow.orderOut(nil)
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
            // The task surface's SIZE now depends on the backend, and detail can
            // arrive independently of the setState that opened the surface —
            // cranking from a PTY task to a Codex one sends showTask with the
            // state unchanged. Without this the frame would keep the previous
            // task's proportions until the next state change.
            let fillChanged = model.task?.hasTerminal != task.hasTerminal
            model.task = task
            if model.state == .task && fillChanged { refit(animated: true) }

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
            reconcileSurfaces()

        case let .scratchpad(payload):
            NotchLog.log("CMD scratchpad enabled=\(payload.enabled) armed=\(payload.armed) delivering=\(payload.delivering) entries=\(payload.pad?.entries.count ?? 0)")
            scratchModel.state = payload
            reconcileSurfaces()

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

    /// ONE pair of numbers for the frame AND the content, so they cannot drift.
    /// Expansion is slower than collapse — the surface should feel like it is
    /// arriving, and like it is getting out of the way.
    private static let growS: Double = 0.42
    private static let shrinkS: Double = 0.30

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
        // MATCHED TO THE WINDOW, and it must be a DURATION curve to be matched
        // at all. This used to animate the content with Theme.morph — a spring
        // whose `response: 0.48` is not a duration: it settles nearer 0.8s,
        // while the frame finished in 0.42. For the difference you saw the OLD
        // content inside the NEW frame — the "1 running" strip floating in a
        // full-size task panel on the way up, and task chrome squeezed into the
        // notch on the way down. Same numbers on both sides, so the surface and
        // what it contains arrive together.
        withAnimation(.easeOut(duration: up ? Self.growS : Self.shrinkS)) { model.state = state }
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
        window.applyFrame(f, animated: true, duration: up ? Self.growS : Self.shrinkS)
        NotchLog.log("state -> \(state.rawValue) window=\(NotchLog.rect(f))")
    }

    /// The Stage/wall keep the cockpit frame; the task surface is content-sized.
    private func frame(for state: NotchState) -> NSRect {
        var size: NSSize
        if state == .task {
            // SIZED BY WHAT THE PANEL CARRIES, not by the state alone. A live
            // terminal gets 80% of the screen; a desktop-app backend's
            // conversation gets 60% (NotchGeometry.SurfaceFill).
            size = geometry.taskSize(terminal: taskHasTerminal)
        } else if geometry.hasNotch,
                  state == .idle || state == .active || state == .attention {
            // NOTCHED HARDWARE: the surface is the notch plus a tongue, and its
            // width is MEASURED from the message the tongue will show. Sizing by
            // state instead is what put the text inside the camera housing.
            //
            // Measured with the same font the view renders, so the frame and the
            // string agree — a mismatch either clips the message or pads the
            // surface with dead space.
            let text = NotchView.tongueText(for: model)
            size = geometry.notchedSize(contentWidth: text.map { t in
                let font = state == .idle
                    ? NSFont.systemFont(ofSize: 9.5, weight: .light)
                    : NSFont.systemFont(ofSize: 11.5)
                var w = (t as NSString).size(withAttributes: [.font: font]).width
                if state == .idle { w += CGFloat(t.count) * 2.1 }      // tracking
                if state != .idle { w += 15 }                          // status dot + gap
                if state == .attention, model.attention > 1 { w += 26 } // count badge
                return w
            })
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

    /// Does the task surface's task have a live terminal? Nil task ⇒ true: a PTY
    /// is the default backend, and opening a hair too large is recoverable in a
    /// way that opening a terminal into a 60% frame is not.
    private var taskHasTerminal: Bool { model.task?.hasTerminal ?? true }

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
    ///
    /// Measured from the SAME base the frame uses, so the headroom shrinks as the
    /// default grows: at 80% of the screen a drag can still add ~22% before
    /// hitting the edge, and 0.6 in the other direction is still available. The
    /// default being large does not take the choice away.
    private func maxScale() -> CGFloat {
        let base = model.state == .cockpit ? geometry.cockpitSize
                                           : geometry.taskSize(terminal: taskHasTerminal)
        let sw = geometry.screenFrame.width * 0.98 / max(base.width, 1)
        let sh = (geometry.screenFrame.height - geometry.menuBarHeight) * 0.98 / max(base.height, 1)
        return max(1, min(sw, sh))
    }
    /// Re-apply the current state's frame after something the frame depends on
    /// changed (the fronted task's backend, a stage detail arriving).
    private func refit(animated: Bool = false) {
        let f = frame(for: model.state)
        let up = f.width >= window.frame.width
        window.applyFrame(f, animated: animated, duration: up ? Self.growS : Self.shrinkS)
        // Logged like a state change, because to the user it IS one: the surface
        // visibly resizes without the rung changing.
        NotchLog.log("refit \(model.state.rawValue) window=\(NotchLog.rect(f))")
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
        // The flag is READ by the view (idle's tongue) and by frame(for:), so a
        // change of hover on notched hardware changes the window size too.
        if model.hovering != entering {
            model.hovering = entering
            if geometry.hasNotch, model.state == .idle {
                withAnimation(.easeOut(duration: entering ? Self.growS : Self.shrinkS)) { }
                window.applyFrame(frame(for: .idle), animated: true,
                                  duration: entering ? Self.growS : Self.shrinkS)
            }
        }
        if entering {
            hoverTimer?.invalidate()
            if model.state == .dormant && commandedState == .dormant {
                NotchLog.log("hover-wake: dormant → idle")
                withAnimation(.easeOut(duration: Self.growS)) { model.state = .idle }
                window.applyFrame(frame(for: .idle), animated: true, duration: Self.growS)
            }
        } else {
            guard model.state == .idle, commandedState == .dormant else { return }
            hoverTimer?.invalidate()
            hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                guard let self, self.model.state == .idle, self.commandedState == .dormant else { return }
                NotchLog.log("hover-sleep: idle → dormant")
                withAnimation(.easeOut(duration: Self.shrinkS)) { self.model.state = .dormant }
                self.window.applyFrame(self.frame(for: .dormant), animated: true, duration: Self.shrinkS)
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

        // NO SPACE-CHANGE HANDLER. Every invalidation strong enough to force a
        // re-sample — ordering the window out and back, or displacing it — is
        // VISIBLE as a blink on each swipe, and a surface that flickers every
        // time the user changes Space is worse than one that is briefly stale.
        //
        // It is also a narrow case. The glass IS live: a window moving beneath
        // the pill retints it continuously (measured — the pill tracked a
        // white-to-yellow gradient sliding under it). macOS re-samples whenever
        // something behind REPAINTS. The only gap is arriving on a Space whose
        // content is completely static, where nothing repaints to trigger it,
        // and Apple exposes no way to ask for a re-sample — its own
        // always-present surfaces are composited by the WindowServer instead.
        //
        // The pill covers itself on the way in (see reconcilePillVisibility):
        // it is ordered out between captures, so rebuilding as it appears costs
        // nothing visually and is the moment that actually matters.
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
        scratchWindow?.fit(geometry: geometry)   // it rides directly above the pill
        NotchLog.log("geometry recomputed (\(reason)): screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) → window=\(NotchLog.rect(f))")
    }
}
