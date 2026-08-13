import AppKit
import SwiftUI
import SwiftTerm
import HoverStateSupport
import SurfaceSizeSupport
import SurfaceTransitionSupport

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
    // The pad — held work, waiting for a destination. It is drawn INSIDE the
    // pill's panel, as one more element in the cluster's row (PillView.pad), so
    // it has a model here but no window of its own. Sharing the panel is what makes the
    // pad's non-activating contract structural rather than a copied checklist:
    // there is only one set of flags, and it is PillWindow's.
    private let scratchModel = ScratchpadModel()
    private var geometry: NotchGeometry
    /// Kept because contentView is now a container, not the hosting view.
    private var hostView: NSHostingView<NotchView>!
    /// The last state MAIN commanded. The hover ladder is LOCAL — dormant ⇄ idle
    /// happens here and never fights main — so it needs to know what main
    /// actually asked for before it puts the surface back to sleep.
    private var commandedState: NotchState = .dormant
    private var hoverTimer: Timer?
    private var hoverExitTimer: Timer?
    private var pocketHoverTimer: Timer?
    private var expandedContentWorkItem: DispatchWorkItem?
    private var toastTimer: Timer?

    override init() {
        geometry = NotchGeometry.current()
        super.init()
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) barH=\(Int(geometry.barHeight)) cutoutW=\(Int(geometry.cutoutWidth))")
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
        model.onPocketDetails = { [weak self] visible in self?.setPocketDetails(visible) }
        model.onBack = { [weak self] in self?.stepDown() }
        model.selectSurfaceFill = { [weak self] fill in self?.selectSurface(fill) }
        installPill()
        let start = resolve(.dormant)
        model.bar = start.placement
        model.content = start.content
        window.applyFrame(start.frame, animated: false)
        window.present()
        installTracking()
        installKeyMonitors()
        installOutsideClickMonitor()
        observeScreens()
        observeAppSwitches()
        NotchLog.log("presented at dormant: window=\(NotchLog.rect(window.frame)) visible=\(window.isVisible)")
    }

    /// Content inset that clears the physical cutout on the EXPANDED surfaces
    /// (bar height + breathing room), or just the surface's own chrome on a
    /// display with no cutout.
    private var topInset: CGFloat { geometry.hasNotch ? geometry.cutoutHeight + 10 : 14 }

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

        reconcileSurfaces()
    }

    /// ONE PANEL, TWO SURFACES, AND THEY ARE NO LONGER EXCLUSIVE.
    ///
    /// The pad used to be a second window that could only be shown while the
    /// pill was hidden. Its bottom edge sat at the top of the cluster plus the
    /// cluster's 9pt row spacing — which is exactly the slot `PillView.content`
    /// gives the mic hint and the model/agent selector — so a co-visible pad
    /// covered the coaching line and the selector opened by clicking the very
    /// cluster the scratchpad chip sits in. Mutual exclusion was the honest
    /// answer to an overlap, not a design.
    ///
    /// The pad now sits BESIDE the whole column instead of above the pill (see
    /// PillView.content), so the overlap cannot be constructed and neither can
    /// the rule. Both surfaces are drawn in this one window, which is also why
    /// the pad inherits every focus flag PillWindow sets rather than repeating
    /// them — there is only one set, and it is the pill's.
    ///
    /// Hidden means ORDERED OUT, not zero-alpha: an invisible always-on panel
    /// still sits in the window server and still competes for clicks.
    private func reconcileSurfaces() {
        let wanted = pillModel.visible || scratchModel.visible
        if wanted {
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
            // Read BEFORE the assignment below — after it, every payload looks
            // like the same task and the default would never apply at all.
            let switchedTask = model.task?.id != task.id
            model.task = task
            // A PREFERENCE IS A DEFAULT, NOT A CORRECTION.
            //
            // This ran on EVERY payload, so `terminalAutoExpand` re-asserted
            // itself against whatever the user had just chosen: hide the
            // terminal, and the next update put it back. Claude polls only on
            // real change so it was rare; the App Server streams, so a Codex
            // task snapped back constantly and the toggle looked broken.
            //
            // The default now applies when the task CHANGES — which is the
            // moment there is no choice of the user's to override.
            if switchedTask && model.terminalAutoExpand { model.taskTerminalOpen = true }
            // The one thing that still overrides a live choice, and only
            // upward: an ask that can ONLY be answered in the terminal. Leaving
            // that hidden is the dead end the rule exists to prevent.
            if needsTerminalToAnswer(task) { model.taskTerminalOpen = true }
            if model.state == .task && fillChanged { refit(animated: true) }
            // At bar level the fronted task IS the message — the right half
            // carries its activity, and the mass is as wide as what it says.
            else if !isExpanded(model.state) && model.state != .dormant { refreshBar() }

        case let .stageDetail(task):
            NotchLog.log("CMD stageDetail id=\(task.id) status=\(task.status.rawValue)")
            // Only meaningful while this task is (still) the focused one.
            if model.focusedId == nil || model.focusedId == task.id {
                model.focusedId = task.id
                model.stageTask = task
                if needsTerminalToAnswer(task) { model.stageTerminalOpen = true }
                refit()
            }

        case let .setCockpit(data):
            NotchLog.log("CMD setCockpit groups=\(data.groups.count) queue=\(data.queue.count) skills=\(data.skills.count)")
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
            // A PROPOSAL THAT CANNOT BE DRAWN MUST NOT BE HELD.
            //
            // The review popup is only drawn on the expanded surface (the bar
            // has no room for it), and the request is always made from the
            // cockpit — but the reply is asynchronous, so the user can collapse
            // while it is in flight. Holding it then would leave an invisible
            // popup in the model, and `stepDown` consumes a live proposal before
            // it steps the surface down: the next Escape would silently dismiss
            // something the user cannot see instead of collapsing the surface.
            guard isExpanded(model.state) else {
                NotchLog.log("proposal arrived while collapsed — NOT SHOWN, dropped: id=\(detail.id)")
                return
            }
            model.proposal = detail

        case let .convData(_, text):
            model.convLog += text
            if model.convLog.count > 20_000 { model.convLog = String(model.convLog.suffix(16_000)) }

        case let .capturePhase(phase, target):
            let was = model.capturePhase
            model.capturePhase = phase.isEmpty || phase == "idle" ? nil : phase
            model.captureTarget = target
            // Recomputed on BOTH inputs, so neither can leave it stale: the
            // phase ending clears the aim even if no further pill frame arrives.
            if model.capturePhase != "listening" {
                model.captureAimed = false
                model.captureLevel = 0
            }
            // ROUTING IS THE ONE PHASE THE BAR ITSELF HAS TO SHOW.
            //
            // Setting the model is not enough on two counts. The bar is built
            // from a resolved BarContent, so it needs a refresh to pick the new
            // words up — and a DORMANT surface draws nothing at all, which is
            // precisely the state a machine is in when the user has just
            // finished speaking to it.
            //
            // So routing borrows the same reveal the pointer uses: dormant is
            // lifted to idle for the duration, then handed straight back to
            // whatever main last commanded. Nothing about the state machine
            // changes; this is a display lift, not a rung.
            if model.capturePhase == "routing", model.state == .dormant {
                NotchLog.log("routing-reveal: dormant → idle")
                applyState(.idle)
            } else if was == "routing", model.capturePhase == nil,
                      commandedState == .dormant, model.state == .idle {
                NotchLog.log("routing-reveal ended: idle → dormant")
                applyState(.dormant)
            } else if !isExpanded(model.state) {
                refreshBar()
            }

        case let .pocket(p):
            // A pocket that opens or closes changes the surface's SIZE, so it
            // needs a refit — but only when it is the thing being shown. An
            // expanded task outranks it: you are already looking at one address,
            // and a card announcing a second would be two answers to one question.
            let wasOpen = model.pocket.isOpen
            model.pocket = p
            if !p.isOpen {
                model.pocketHovered = false
                model.pocketDetailsVisible = false
            } else {
                // A pocket may be opened while an addressed capture is already
                // live. Size it for the controls on its first frame, not after
                // the view has been mounted and clipped them.
                model.pocketDetailsVisible = model.pocketHovered || model.captureAimed
            }
            NotchLog.log("CMD pocket mode=\(p.mode) at=\(p.at) slots=\(p.slots.count)")
            if !isExpanded(model.state) || model.state == .attention {
                if wasOpen != p.isOpen { refit(animated: true) } else { refreshBar() }
            }

        case let .toast(text):
            showToast(text)

        case .notchGeometry:
            recomputeGeometry("explicit-push")

        case let .appearance(pref):
            NotchLog.log("CMD appearance \(pref.rawValue)")
            // Reaches the expanded panel and the pill ONLY. The bar-level mass
            // is opaque black whatever this says (decision D5) — it impersonates
            // the physical cutout, and the cutout is not translucent.
            Appearance.shared.preference = pref

        case let .autoPresent(on):
            NotchLog.log("CMD autoPresent \(on)")
            autoPresent = on

        case let .terminalAutoExpand(on):
            model.terminalAutoExpand = on
            NotchLog.log("CMD terminalAutoExpand \(on)")
        case let .surfaceFill(fill):
            // Clamped again here, not only in main: this process outlives a
            // single engine run and a bad value would resize every surface
            // with no UI path back.
            let v = min(max(fill, 0.5), 0.95)
            NotchLog.log("CMD surfaceFill \(v)")
            NotchGeometry.SurfaceFill.user = v
            refreshSurfaceControlAvailability()
            // Re-fit only if something expanded is on screen; at bar level the
            // mass is sized by its content, not by this.
            if isExpanded(model.state) { refit(animated: true) }

        case let .screenCaptureVisibility(show):
            let sharing: NSWindow.SharingType = show ? .readOnly : .none
            window.sharingType = sharing
            pillWindow.sharingType = sharing
            NotchLog.log("CMD screenCaptureVisibility show=\(show)")

        case let .pill(state):
            // Logged at phase granularity only — the level field changes every
            // frame during a capture and would drown the log.
            if state.phase != pillModel.state.phase {
                NotchLog.log("CMD pill phase=\(state.phase.rawValue) kind=\(state.kind.rawValue)")
            }
            pillModel.state = state
            // THE POCKET NEEDS THE SAME SIGNAL. Both surfaces live in this
            // process but in different models, and the capture level only ever
            // reached the pill's. The pocket card shows where your voice is
            // going, so it has to know whether anything is being heard.
            model.captureLevel = state.phase == .recording ? state.level : 0
            // A CAPTURE THAT IS NOT RECORDING CANNOT BE LISTENING. The phase
            // arrives from the keyboard path and ends on key-up; this one
            // arrives from the audio path and cannot outlive the microphone. If
            // a key-up is ever missed, the aim clears here instead of leaving a
            // chip claiming the user's voice is going somewhere it is not.
            model.captureAimed = state.phase == .recording
                && state.kind == .remote
                && model.capturePhase == "listening"
            if model.pocket.isOpen { setPocketDetails(model.pocketHovered) }
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

    private func applyState(_ commanded: NotchState) {
        // AUTO-PRESENT decides whether an expanded rung is honoured at all.
        var state = presentableState(commanded)
        syncGeometry("state")
        // DORMANT IS ONLY AVAILABLE WHERE THE HARDWARE IS THE LANDMARK.
        //
        // Hiding at rest is right on a notched display: the cutout is always
        // visible, so "put the pointer in the notch" is a gesture people already
        // have, and dormantFrame() reserves exactly those pixels for it.
        //
        // On a display with no cutout there is nothing to aim at. Dormant there
        // reserved a 2pt strip at dead centre — findable only by accident, which
        // is what testing on a 1920x1080 external screen found: the surface
        // appeared "only in the middle", after hunting for it.
        //
        // The notch is a CONTROL as well as an indicator — it is the way into the
        // orchestrator. An indicator may hide when there is nothing to say; a
        // control may not. So off-notch, dormant collapses into idle: quiet,
        // small, never glowing, but always there and always a target.
        if state == .dormant && !geometry.hasNotch { state = .idle }
        let wasExpanded = isExpanded(model.state)
        let expandingFromPocket = !wasExpanded && isExpanded(state) && model.pocket.isOpen
        let preserveContentHandoff = SurfaceContentHandoff.shouldPreserve(
            wasExpanded: wasExpanded,
            destinationExpanded: isExpanded(state),
            contentReady: model.expandedContentReady,
            hasPocketSnapshot: model.transitionPocket != nil
        )
        if !preserveContentHandoff {
            expandedContentWorkItem?.cancel()
            expandedContentWorkItem = nil
            if expandingFromPocket && !Motion.reduceMotion {
                model.transitionPocket = model.pocket
                model.expandedContentReady = false
            } else {
                model.transitionPocket = nil
                model.expandedContentReady = true
            }
        }
        // Each visit starts at the hard-coded size. A size dragged out for one
        // look at a task is not a preference — carrying it across would make the
        // surface's size a hidden setting the user never chose to persist.
        if state != .task && state != .cockpit {
            userScale = 1
            temporarySurfaceFill = nil
        }
        if state != .cockpit { model.focusedId = nil; model.stageTask = nil }
        // TERMINAL CLOSED BY DEFAULT when a task is pulled to attention.
        //
        // It was open, which inverted the point of the surface: a task arrives
        // BECAUSE it needs you, and the first thing you should see is what it
        // said — not a wall of scrollback with the message squeezed above it.
        // The terminal is one tap away and stays that way; it is the
        // drill-down, not the greeting. Reset on leaving so every arrival is
        // calm again. (The orchestrator's stage keeps its own default: you went
        // there deliberately, so the terminal is what you asked for.)
        //
        // …UNLESS the terminal is the only way to answer. A `terminal_only` ask
        // is a picker Unmute refuses to drive, so the card carries the whole
        // question and no way to reply to it. Greeting that with a closed
        // terminal is the dead end this rule was blamed for: an instruction to
        // "answer in the terminal" beside a terminal that is not there.
        // The preference decides the default; a terminal-only ask overrides it
        // upward and never downward. Turning auto-expand OFF must not strand
        // someone on "answer in the terminal" with no terminal.
        model.taskTerminalOpen = model.task.map { needsTerminalToAnswer($0) || model.terminalAutoExpand } ?? false
        // THE REVIEW POPUP CANNOT SURVIVE A COLLAPSE. It is drawn only on the
        // expanded surface, and a popup nobody can see still eats the next
        // Escape in stepDown. Leaving the expanded state ends it, exactly as
        // pressing Escape on it would.
        if !isExpanded(state), model.proposal != nil || model.proposalLoadingId != nil {
            if let p = model.proposal { model.emit(.converseStop(id: p.id)) }
            NotchLog.log("proposal cleared — the surface left the expanded state")
            model.proposal = nil; model.proposalLoadingId = nil; model.convLog = ""
        }
        // One surface transition: resolve the final visual state first, update
        // SwiftUI in one transaction, then ask AppKit to move the panel frame.
        // NotchWindow suppresses repeated in-flight frame targets, so follow-up
        // content messages cannot restart this physical transition.
        let r = resolve(state)
        withAnimation(Motion.resize) {
            model.state = state
            model.bar = r.placement
            model.content = r.content
        }
        refreshSurfaceControlAvailability()
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
        window.applyFrame(r.frame, animated: true)
        if expandingFromPocket && !Motion.reduceMotion && !preserveContentHandoff {
            let item = DispatchWorkItem { [weak self] in
                guard let self, isExpanded(self.model.state) else { return }
                withAnimation(Theme.contentIn) {
                    self.model.expandedContentReady = true
                    self.model.transitionPocket = nil
                }
            }
            expandedContentWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Theme.contentInDelay, execute: item)
        }
        NotchLog.log("state -> \(state.rawValue)\(state == commanded ? "" : " (commanded \(commanded.rawValue))") window=\(NotchLog.rect(r.frame)) mass=[\(Int(r.placement.left))|\(Int(r.placement.middle))|\(Int(r.placement.right))] fillet=\(Int(r.placement.fillet))")
    }

    /// EVERYTHING ABOUT A STATE, RESOLVED IN ONE PASS: what the mass says, how
    /// wide each half is, the shape numbers, and the window frame that holds
    /// them. One function, because these four have to agree — sizing the window
    /// from one measurement and rendering from another is what put the old
    /// message inside the camera housing.
    private func resolve(_ state: NotchState)
        -> (frame: NSRect, placement: MassPlacement, content: BarContent) {
        switch state {
        case .dormant:
            // Nothing is drawn; the placement exists so the shape traces the
            // hardware's own corners if the surface is on notched glass.
            return (geometry.dormantFrame(),
                    MassPlacement(fillet: 0, bottomRadius: geometry.barCornerRadius),
                    BarContent())

        case .idle, .active, .attention:
            // THE POCKET, OPEN — a card between the bar and the panel.
            //
            // Deliberately small and deliberately temporary: it is up only
            // while you are speaking or because you tapped it, and its job is
            // to say WHICH thing you are addressing, not to let you read the
            // whole ask. Anything bigger and we are back to a surface that is
            // in the way, which is the problem the pocket exists to solve.
            if model.pocket.isOpen {
                // Shorter without the ghost-hint row, and shorter again when a
                // single task makes the carousel pointless.
                // ROOM FOR THE HOUSING ON TOP OF THE CARD, not instead of it.
                // The card keeps its full height; the window grows by whatever
                // the cutout occupies so the card still fits underneath it.
                // Zero on a notchless display, so nothing moves there.
                // GROW BY WHAT THE PLANE ACTUALLY ADDS, which is the inset
                // MINUS the padding it replaced — not the whole inset. And zero
                // on a notchless display, where the plane is unchanged.
                let clearance = geometry.hasNotch ? max(0, topInset - Theme.panelPadding) : 0
                let cardHeight: CGFloat = model.pocketDetailsVisible
                    ? (model.pocket.slots.count > 1 ? 146 : 120)
                    : 64
                return (geometry.topPinnedFrame(width: 348, height: cardHeight + clearance),
                        geometry.panelPlacement,
                        BarContent())
            }
            // BAR LEVEL. Height is the measured menu bar and nothing else; the
            // width follows what the mass has to say, bounded by the room
            // beside the cutout.
            var c = BarContent.make(for: model, state: state, hovering: model.hovering)
            // HOVER GROWS IT SLIGHTLY. A few points on each half that is
            // actually there — enough to register as a response, nowhere near
            // enough to read as opening.
            let grow: CGFloat = model.hovering ? 6 : 0
            let l = c.leftWidth > 0 ? c.leftWidth + grow : 0
            let r = c.wantsRightWidth > 0 ? c.wantsRightWidth + grow : 0
            let m = geometry.mass(left: l, right: r)
            // Dropped rather than ellipsised: if the right half did not survive
            // the fit, the view must not render it either.
            if m.right == 0 { c.right = nil }
            return (geometry.barFrame(m), m, c)

        case .task, .cockpit:
            // The saved Appearance choice is the default for every expanded
            // surface. A visit-scoped choice uses that same absolute geometry.
            let providerDefault = state == .task ? geometry.taskSize(terminal: taskHasTerminal)
                                                 : geometry.cockpitSize
            var size = SurfaceSizeStep.resolvedSize(
                screen: geometry.screenFrame.size,
                providerDefault: providerDefault,
                temporaryFill: temporarySurfaceFill
            )
            // USER SCALE — one factor on BOTH axes, so any drag from any edge
            // makes the whole surface bigger rather than stretching it one way.
            // Only the expanded surfaces are resizable; the resting states are
            // fixed.
            if userScale != 1 {
                var w = size.width * userScale
                var h = size.height * userScale
                // The cockpit never goes below the fill selected for this visit.
                if state == .cockpit {
                    let minimum = geometry.expandedSize(fill: activeSurfaceFill)
                    w = max(w, minimum.width)
                    h = max(h, minimum.height)
                }
                size = NSSize(width: round(w), height: round(h))
            }
            return (geometry.topPinnedFrame(width: size.width, height: size.height),
                    geometry.panelPlacement,
                    BarContent())
        }
    }

    private func isExpanded(_ s: NotchState) -> Bool { s == .task || s == .cockpit }

    /// Re-resolve the CURRENT state in place.
    ///
    /// Used whenever something the mass says changes without the rung changing:
    /// a task detail arriving, the pointer entering or leaving, a display being
    /// plugged in. The width follows the message, so this is a size change like
    /// any other and it travels through the same native frame coordinator.
    private func refreshBar(animated: Bool = true) {
        let r = resolve(model.state)
        withAnimation(animated && !Motion.reduceMotion ? Motion.resize : nil) {
            model.bar = r.placement
            model.content = r.content
        }
        window.applyFrame(r.frame, animated: animated)
        NotchLog.log("bar \(model.state.rawValue) window=\(NotchLog.rect(r.frame)) mass=[\(Int(r.placement.left))|\(Int(r.placement.middle))|\(Int(r.placement.right))] left=\(r.content.left ?? "—") right=\(r.content.right ?? "—")")
    }

    /// Secondary pocket controls are a presentation detail, not a route. Their
    /// frame change is coordinated through the same native transition as every
    /// other pocket resize.
    private func setPocketDetails(_ hovering: Bool) {
        model.pocketHovered = hovering
        pocketHoverTimer?.invalidate()
        if hovering || model.captureAimed {
            guard model.pocket.isOpen, !model.pocketDetailsVisible else { return }
            model.pocketDetailsVisible = true
            refit(animated: true)
            return
        }
        // SwiftUI rebuilds its tracking region while the panel animates. That
        // can emit a synthetic exit even though the pointer is still inside the
        // same surface, creating a 64↔146pt resize loop. Defer only collapse and
        // confirm against the physical window frame before accepting the exit.
        pocketHoverTimer = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: false) { [weak self] _ in
            guard let self, self.model.pocket.isOpen, !self.model.captureAimed else { return }
            if self.window.frame.contains(NSEvent.mouseLocation) {
                self.model.pocketHovered = true
                return
            }
            guard self.model.pocketDetailsVisible else { return }
            self.model.pocketDetailsVisible = false
            self.refit(animated: true)
        }
    }

    // MARK: - Auto-present (default ON)

    /// Whether the surface may present ITSELF. Pushed by main; absent ⇒ ON,
    /// which is also the engine's own default for the same setting.
    private var autoPresent = true
    /// When the user last acted ON THIS SURFACE. See presentableState.
    private var lastGestureAt: Date? = nil
    private static let gestureWindow: TimeInterval = 6

    /// The rung the surface will actually show.
    ///
    /// With auto-present ON this is the identity. With it OFF the surface never
    /// expands ITSELF: every expansion the engine commands today is the direct
    /// consequence of a gesture on this surface — NotchController engages
    /// `task`/`cockpit` only from onTap, onFocusTask and openDashboard, all of
    /// which are events this process emitted — so an expanded rung arriving with
    /// no recent gesture is by definition an automatic present. It is answered
    /// at bar level instead, and the content still updates in place: the user
    /// asked not to be interrupted, not to be left uninformed.
    private func presentableState(_ s: NotchState) -> NotchState {
        guard !autoPresent, isExpanded(s) else { return s }
        if let g = lastGestureAt, Date().timeIntervalSince(g) < Self.gestureWindow { return s }
        let held: NotchState = model.attention > 0 ? .attention : (model.working > 0 ? .active : .idle)
        NotchLog.log("auto-present OFF: \(s.rawValue) held at \(held.rawValue)")
        return held
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
    /// The selected 70/80/90 fill for this expanded visit only. Nil means the
    /// saved Appearance setting is still in effect.
    private var temporarySurfaceFill: CGFloat?
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
        window.applyFrame(resolve(model.state).frame, animated: false)
    }

    func endResize() { dragAnchor = nil }

    private var activeSurfaceFill: CGFloat {
        temporarySurfaceFill ?? NotchGeometry.SurfaceFill.user
    }

    private func selectSurface(_ fill: CGFloat) {
        guard isExpanded(model.state), SurfaceSizeStep.values.contains(where: { abs($0 - fill) < 0.001 }) else { return }
        userScale = 1
        temporarySurfaceFill = fill
        refreshSurfaceControlAvailability()
        refit(animated: true)
    }

    private func refreshSurfaceControlAvailability() {
        guard isExpanded(model.state) else {
            return
        }
        model.selectedSurfaceFill = activeSurfaceFill
    }

    /// Never larger than the screen it lives on.
    ///
    /// Measured from the same base the frame uses, so it never exceeds screen.
    private func maxScale() -> CGFloat {
        let base = model.state == .cockpit ? geometry.cockpitSize
                                           : geometry.taskSize(terminal: taskHasTerminal)
        let sw = geometry.screenFrame.width * 0.98 / max(base.width, 1)
        let sh = (geometry.screenFrame.height - geometry.barHeight) * 0.98 / max(base.height, 1)
        return max(1, min(sw, sh))
    }
    /// Is the terminal the ONLY way to answer this task right now?
    ///
    /// True for a `terminal_only` ask — a picker open in the session that Unmute
    /// has not proven it can drive, so the card shows the whole question and
    /// deliberately offers no reply. In that one case the terminal stops being
    /// the drill-down and becomes the control, so it opens with the ask instead
    /// of waiting to be found.
    ///
    /// Claude Code CLI only, by construction: `terminal_only` is written from
    /// hook events, and only a CLI session emits hooks. `alive` keeps a dead
    /// session's last question from re-opening a terminal with nothing behind it.
    private func needsTerminalToAnswer(_ t: TaskDetail) -> Bool {
        t.alive && t.status == .needsUser && t.question?.kind == "terminal_only"
    }

    /// Re-apply the current state's frame after something the frame depends on
    /// changed (the fronted task's backend, a stage detail arriving, a message
    /// the bar now has to carry).
    private func refit(animated: Bool = false) {
        refreshBar(animated: animated)
        // Logged like a state change, because to the user it IS one: the surface
        // visibly resizes without the rung changing.
        NotchLog.log("refit \(model.state.rawValue) window=\(NotchLog.rect(window.frame))")
    }

    private func rung(_ s: NotchState) -> Int {
        switch s {
        case .dormant: return 0; case .idle: return 1; case .active: return 2
        case .attention: return 3; case .task: return 4; case .cockpit: return 5
        }
    }

    private func showToast(_ text: String) {
        // A toast has nowhere to be drawn at bar level — the surface is menu-bar
        // height and nothing may hang below it. Logged rather than lost without
        // trace; the engine sends these from user actions ("finish the recording
        // first"), so a toast landing here is worth knowing about.
        if !isExpanded(model.state) { NotchLog.log("toast while collapsed — NOT SHOWN: \(text)") }
        model.toast = text
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 1.8, repeats: false) { [weak self] _ in
            self?.model.toast = nil
        }
    }

    /// Local reactions to our own emits (snappy UI; main remains authoritative).
    private func afterEmit(_ ev: Event) {
        // THE USER JUST ASKED FOR SOMETHING ON THIS SURFACE. Recorded so that an
        // expansion arriving from main a moment later can be told apart from one
        // the app decided on by itself — see presentableState.
        switch ev {
        case .tap, .openDashboard, .next, .prev, .focusTask:
            lastGestureAt = Date()
        default: break
        }
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

    // MARK: - Hover — REVEALS, NEVER OPENS
    //
    // Hovering the collapsed mass grows it a little and adds one more level of
    // detail: idle gains the task count, a running task gains its name. It does
    // NOT open the panel, and it must never be made to. The menu bar is
    // somewhere the pointer passes through constantly, and a panel that opens on
    // approach becomes something the user fights — the main usability failure of
    // NotchNook and its imitators. The only thing that opens the panel is a
    // click (NotchView.onTapGesture → .tap).
    //
    // Dormant → idle IS a reveal, not an open: it is one rung, at bar level,
    // and it goes back on its own when the pointer leaves.

    private func installTracking() {
        guard let cv = window.contentView else { return }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        cv.addTrackingArea(area)
    }
    /// Shared, idempotent (fed by BOTH the SwiftUI .onHover relay and the AppKit
    /// tracking area — SwiftUI's own tracking can miss a never-key panel, which
    /// is exactly the dormant window; two paths, one behavior).
    func handleHover(_ entering: Bool) {
        // The flag is READ by BarContent.make, and the mass is as wide as what
        // it says — so a change of hover is a size change like any other.
        // ONE COLLAPSE, NOT TWO.
        //
        // Leaving used to refresh the bar at once — dropping the right half —
        // and only then let the 0.4s sleep timer take the rest away. The eye
        // read that as the count shrinking first and the wordmark following,
        // because that is exactly what happened.
        //
        // When the pointer is leaving a surface that is ABOUT to sleep, the
        // content is left alone and the timer collapses the whole mass in a
        // single motion. The delay still exists — it is what stops a pointer
        // crossing the bar from making it flicker — it just no longer spends
        // that time showing a half-dismantled bar.
        if entering {
            hoverExitTimer?.invalidate()
            hoverTimer?.invalidate()
            if !model.hovering {
                model.hovering = true
                if !isExpanded(model.state), model.state != .dormant { refreshBar() }
            }
            if model.state == .dormant && commandedState == .dormant {
                NotchLog.log("hover-reveal: dormant → idle")
                applyState(.idle)
            }
        } else {
            // Resizing the bar rebuilds both SwiftUI and AppKit tracking
            // regions. Either layer can report a momentary exit even though
            // the pointer is still over the same physical surface. Accepting
            // that event immediately shrinks the bar, which reports an enter,
            // which grows it again: the visible horizontal oscillation.
            //
            // Defer exits and ask the window where the pointer actually is.
            // Enter remains immediate, so genuine hover still feels direct.
            hoverExitTimer?.invalidate()
            hoverExitTimer = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: false) { [weak self] _ in
                guard let self else { return }
                switch HoverExitDecision.resolve(pointerInsideSurface: self.window.frame.contains(NSEvent.mouseLocation)) {
                case .keepRevealed:
                    return
                case .acceptExit:
                    break
                }

                let willSleep = self.model.state == .idle
                    && self.commandedState == .dormant
                    && self.geometry.hasNotch
                if self.model.hovering {
                    self.model.hovering = false
                    if !self.isExpanded(self.model.state), self.model.state != .dormant, !willSleep {
                        self.refreshBar()
                    }
                }
                guard self.model.state == .idle, self.commandedState == .dormant else { return }
                // Off-notch there is no dormant to fall back to (applyState
                // maps it to idle). Idle IS the resting state there.
                guard self.geometry.hasNotch else { return }
                self.hoverTimer?.invalidate()
                self.hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                    guard let self, self.model.state == .idle,
                          self.commandedState == .dormant,
                          !self.model.hovering else { return }
                    NotchLog.log("hover-sleep: idle → dormant")
                    self.applyState(.dormant)
                }
            }
        }
    }
    @objc func mouseEntered(with event: NSEvent) { handleHover(true) }
    @objc func mouseExited(with event: NSEvent) { handleHover(false) }

    // MARK: - Keyboard (Esc ladder · Tab crank · F full · 1-9 answers)

    /// CLICK ANYWHERE ELSE AND IT CLOSES.
    ///
    /// A global monitor sees clicks destined for OTHER apps and cannot consume
    /// them — which is exactly right here: the click should still land wherever
    /// the user aimed it, and the surface should get out of the way. Only
    /// expanded states listen; at bar level there is nothing to dismiss, and a
    /// resting notch that vanished on every click elsewhere would be unusable.
    ///
    /// The pill and the pad are deliberately EXCLUDED — they live in their own
    /// window and are mid-dictation surfaces. Closing the wall because someone
    /// clicked the scratchpad would be a bug, not a dismissal.
    private func installOutsideClickMonitor() {
        NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] e in
            guard let self, self.isExpanded(self.model.state) else { return }
            let p = NSEvent.mouseLocation
            if self.window.frame.contains(p) { return }
            if let pw = self.pillWindow, pw.isVisible, pw.frame.contains(p) { return }
            NotchLog.log("close-all: click outside at \(Int(p.x)),\(Int(p.y))")
            self.closeAll()
        }
    }

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
            self.closeAll()
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
                self.closeAll(); return nil
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
    /// ESCAPE AND OUTSIDE-CLICK MEAN "CLOSE", NOT "GO BACK ONE".
    ///
    /// Escape used to call stepDown(), so from a stage inside the Orchestrator
    /// it took three presses to actually leave. Everywhere else on the platform
    /// those two gestures dismiss the whole thing, and the graded walk now
    /// belongs to the back arrow, which is visible and says what it does.
    ///
    /// Any drilled-in state is torn down on the way out so re-opening starts at
    /// the wall rather than wherever the surface happened to be when it closed.
    private func closeAll() {
        if model.state == .dormant { return }
        if let p = model.proposal { model.emit(.converseStop(id: p.id)) }
        model.proposal = nil; model.proposalLoadingId = nil; model.convLog = ""
        if model.focusedId != nil { model.emit(.closeStage) }
        model.focusedId = nil; model.stageTask = nil; model.stageFull = false
        NotchLog.log("close-all from \(model.state.rawValue)")
        model.emit(.collapsed)
    }

    private func stepDown() {
        // Only a VISIBLE popup gets to swallow the Escape. It is drawn on the
        // expanded surface only, so a stale one at bar level must not consume a
        // keystroke the user aimed at the surface itself. (Belt and braces: it
        // is also cleared on the way down — see applyState.)
        if isExpanded(model.state), model.proposal != nil || model.proposalLoadingId != nil {
            if let p = model.proposal { model.emit(.converseStop(id: p.id)) }
            model.proposal = nil; model.proposalLoadingId = nil; model.convLog = ""
            return
        }
        // CLOSING THE POCKET IS THE AIM CONTROL, and Escape is how you close
        // things. Open means your voice goes to the task on the card; Escape
        // shuts it and the aim goes with it — mid-sentence or not, because that
        // is already what closing means on the expanded panel. This is the
        // whole reason no modifier and no separate "detach" gesture is needed.
        if model.pocket.isOpen {
            model.emit(.pocketRelease)
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

    /// CHANGING WINDOW IS THE SIGNAL.
    ///
    /// An expanded panel covering 70% of the display is right while you are
    /// reading it and wrong the instant you go elsewhere — and you went
    /// elsewhere FOR A REASON, usually to look at the thing you need in order
    /// to answer. Before this, the only way to get your screen back was to
    /// close the task, which says "done with this" and dropped you into the
    /// dashboard to find it again. So leaving now pockets it instead.
    ///
    /// `NSWorkspace.didActivateApplicationNotification`, not app-resign: this
    /// helper is an accessory that never takes key focus, so it is never the
    /// app that resigns. What we can see is who came FORWARD.
    private func observeAppSwitches() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let mine = app?.bundleIdentifier == Bundle.main.bundleIdentifier
                || app?.processIdentifier == ProcessInfo.processInfo.processIdentifier
            if mine {
                // Straight back = you did not mean to leave. Main owns the grace
                // window; we only report the return.
                self.model.emit(.userReturned)
            } else if self.isExpanded(self.model.state) {
                NotchLog.log("user left for \(app?.bundleIdentifier ?? "?") — collapsing")
                self.model.emit(.userLeft(reason: "blur"))
            }
        }

        // A SPACE SWIPE IS LEAVING TOO, and it was invisible here.
        //
        // App activation does not fire when you swipe to another desktop, so an
        // open orchestrator rode along to every Space — including the one you
        // swiped to precisely because you needed to look at something. The
        // surface joins all Spaces (`.canJoinAllSpaces`), which is what makes it
        // reachable everywhere and also what let it follow you at full size.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, self.isExpanded(self.model.state) else { return }
            NotchLog.log("space changed — collapsing")
            self.model.emit(.userLeft(reason: "space"))
        }
    }

    private func observeScreens() {
        // PER DISPLAY, NOT PER APP. Connected, disconnected, rearranged, main
        // display moved, resolution or scaling changed — all of them arrive
        // here, and all of them re-run the measurement. Nothing about the
        // layout survives from launch.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.recomputeGeometry("screen-params-changed") }

        // …and when the SURFACE ITSELF changes screen, which a display change
        // does not always announce (the window server can move a panel during a
        // Space transition, and "main display" can move under a window that
        // never resized).
        NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeScreenNotification,
            object: window, queue: .main
        ) { [weak self] _ in self?.recomputeGeometry("window-changed-screen") }

        // Backing-store changes (a display switched to a different scale factor
        // without the screen list changing) move the menu bar's point height.
        NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeBackingPropertiesNotification,
            object: window, queue: .main
        ) { [weak self] _ in self?.recomputeGeometry("backing-properties-changed") }

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
    /// Re-measure the screen the surface is on, cheaply, before anything that
    /// depends on it. Returns without touching the view tree when nothing moved,
    /// which is the common case — this runs on every state change.
    @discardableResult
    private func syncGeometry(_ reason: String) -> Bool {
        let next = NotchGeometry.current(for: NotchGeometry.screen(hosting: window))
        guard next != geometry else { return false }
        geometry = next
        model.hasNotch = next.hasNotch
        // topInset feeds the view tree — rebuild the root so it picks it up.
        hostView?.rootView = NotchView(model: model, topInset: topInset)
        NotchLog.log("geometry changed (\(reason)): screen=\(NotchLog.rect(next.screenFrame)) hasNotch=\(next.hasNotch) barH=\(Int(next.barHeight)) cutoutW=\(Int(next.cutoutWidth))")
        return true
    }

    /// A display was connected, disconnected, rearranged or rescaled, or the
    /// surface moved between screens. Re-measure and re-lay-out in place — no
    /// restart, no animation (nothing "moved"; the world did).
    private func recomputeGeometry(_ reason: String) {
        syncGeometry(reason)
        let r = resolve(model.state)
        model.bar = r.placement
        model.content = r.content
        window.applyFrame(r.frame, animated: false)
        // The pill is bottom-anchored to the PRIMARY display's visible frame, so
        // it has to move too — plugging in a monitor, or moving the menu bar to
        // one, relocates both surfaces together. Its size preference does not
        // re-fire on a screen change, so refit explicitly from the current frame.
        pillWindow?.fit(geometry: geometry)   // the pad rides inside it
        NotchLog.log("geometry recomputed (\(reason)): screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) → window=\(NotchLog.rect(r.frame))")
    }
}
