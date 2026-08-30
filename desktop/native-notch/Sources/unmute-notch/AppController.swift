import AppKit
import SwiftUI
import SwiftTerm
import HoverStateSupport
import SurfaceSizeSupport
import SurfaceTransitionSupport
import SurfaceStateSupport
import StageSupport

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
    /// The Agent's caption. Its own window, deliberately not the notch — a
    /// surface descending from the top of the display reads as the notch
    /// talking rather than the computer.
    private var captionWindow: CaptionWindow?
    private var captionTimer: Timer?
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
    // ── QUIET AT REST ────────────────────────────────────────────
    //
    // A held task used to keep its sentence on screen for as long as the state
    // stayed true — "1 waiting on you" parked over the user's browser tabs for
    // hours. Seeing it a second time never made it more actionable; it just
    // made the surface furniture.
    //
    // So an announceable rung now says its piece and stands down. This is
    // PRESENTATION ONLY: `commandedState` still holds what main asked for, the
    // same way the dormant⇄idle hover ladder never fights main. Nothing is
    // forgotten — hovering restores exactly the rung that decayed, and a click
    // still opens what it always opened.
    private var restTimer: Timer?
    /// The rung that decayed, kept so hover can put it back. nil = not rested.
    private var restedFrom: NotchState?
    /// The rung the stand-down clock is currently counting down on, so a repeat
    /// of the SAME command does not keep restarting it. Main re-sends a live
    /// rung on ordinary activity — measured gaps of 0s and 2s during one task —
    /// and an unconditional re-arm meant the 2s clock was reset faster than it
    /// could ever fire. That is why "Working" never stood down.
    private var restPending: NotchState?
    /// What was on the surface when it rested — the rung plus the task and
    /// status it was describing. A later command carrying the SAME thing is not
    /// news and must not re-announce: the engine re-reports a live task every
    /// few seconds, so an unconditional re-announce turned "say it once" into
    /// "say it every fifteen seconds", which is the original complaint wearing
    /// a timer. Only a genuine change — a different rung, task, or status —
    /// earns the surface back.
    /// ONE ANNOUNCEMENT PER TASK, EVER.
    ///
    /// The rule, as stated by the owner: a banner shows for two seconds and
    /// then goes, and it never comes back until a NEW task needs attention.
    /// Three tasks waiting announce once between them; a fourth arriving
    /// announces once more, because that id has not been seen.
    ///
    /// THIS REPLACED FIVE MOVING PARTS: a 120s quiet window, an 8-minute
    /// reflash, a four-field signature, and the two bookkeeping fields they
    /// needed. Every one of them was TIME-based, and time was the wrong axis —
    /// it let the same task announce again once the window lapsed, and it
    /// swallowed a genuinely new task that arrived inside one. Identity is the
    /// axis the rule was always about.
    ///
    /// Never pruned, deliberately. Pruning would mean deciding a task has
    /// "stopped waiting", and the engine flaps that very fact — a task
    /// alternating demanding/processing every few seconds would re-announce on
    /// every flip. An id seen once is done.
    private var announcedTaskIds: Set<String> = []

    /// The tasks currently asking for the user, by id. Falls back to the front
    /// task when the pocket has not sent slots yet, so a banner shown before
    /// any pocket payload still counts as announced rather than repeating.
    private func attentionTaskIds() -> Set<String> {
        let waiting = model.pocket.slots.filter { $0.demanding == true }.map(\.id)
        if !waiting.isEmpty { return Set(waiting) }
        if let t = model.task { return [t.id] }
        return []
    }

    /// How long an announceable rung holds the eye before standing down.
    private static let restAfter: TimeInterval = 2.0
    /// Only a rung that is BLOCKED ON THE USER earns a second interruption.
    /// Working and Done say their piece once and stay quiet.
    private var departureTransition = SurfaceDepartureTransition()
    private var departureReturnTimer: Timer?
    private var expandedContentGeneration: UInt64 = 0
    private var toastTimer: Timer?
    private var agentActivityTimer: Timer?


    /// Sole authority for visit-scoped interaction. Domain data remains in the
    /// model; controls, geometry and user choices are projected from this value.
    private var interaction = SurfaceInteractionState()
    /// The effect reconciler's applied value. Rendering a terminal never opens
    /// a stream itself; changing the desired value performs one diffed effect.
    private var subscribedTerminalID: String?
    /// SwiftTerm must exist before the controller requests replay bytes. Mount
    /// state is an input to the effect reconciler, never an effect from a view.
    private var mountedTerminalCounts: [String: Int] = [:]

    override init() {
        geometry = NotchGeometry.current()
        super.init()
        NotchLog.log("geometry: screen=\(NotchLog.rect(geometry.screenFrame)) hasNotch=\(geometry.hasNotch) barH=\(Int(geometry.barHeight)) cutoutW=\(Int(geometry.cutoutWidth))")
        window = NotchWindow(geometry: geometry)
        // Tell the engine the moment this window stops being key, so no composer
        // keeps claiming the caret after the user has clicked away. Without it
        // the claim was permanent and every dictated image went to that draft.
        window.onWindowUnfocused = { [weak self] in
            self?.model.emit(.windowUnfocused)
        }
        // A plain container holds the SwiftUI view and the resize border as
        // SIBLINGS. The border cannot live inside the hosting view — SwiftUI
        // owns that view's subviews and is free to reorder or drop them.
        // FirstMouseHostingView, not a plain one. The container below is also
        // a FirstMouseView, but AppKit asks the view that is actually HIT, and
        // this hosting view covers the container completely — so the parent's
        // override was never consulted and the first click stayed swallowed.
        let host = FirstMouseHostingView(rootView: NotchView(model: model, topInset: topInset))
        host.sizingOptions = []   // WE own the window size
        hostView = host
        let container = FirstMouseView(frame: .zero)
        container.autoresizingMask = [.width, .height]
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        window.contentView = container
        host.frame = container.bounds
        window.resizer = self
        model.hasNotch = geometry.hasNotch
        model.pocketTopInset = geometry.pocketTopInset
        model.pocketCutoutWidth = geometry.cutout?.width ?? 0
        model.emit = { [weak self] ev in
            NotchLog.log("EVENT out: \(ev.json)")
            IPC.emit(ev)
            self?.afterEmit(ev)
        }
        model.onHover = { [weak self] entering in self?.handleHover(entering) }
        model.onBack = { [weak self] in self?.stepDown() }
        model.selectSurfaceFill = { [weak self] fill in self?.selectSurface(fill) }
        model.setTaskTerminalVisible = { [weak self] visible in
            guard let self else { return }
            self.interaction.reduce(.terminalVisibilityChanged(visible))
            self.projectInteraction()
            self.reconcileTerminalSubscription()
        }
        model.setStageTerminalVisible = { [weak self] visible in
            guard let self else { return }
            self.model.stageTerminalOpen = visible
            self.reconcileTerminalSubscription()
        }
        model.setTerminalMounted = { [weak self] id, mounted in
            guard let self else { return }
            if mounted { self.mountedTerminalCounts[id, default: 0] += 1 }
            else {
                let remaining = max(0, self.mountedTerminalCounts[id, default: 0] - 1)
                if remaining == 0 { self.mountedTerminalCounts.removeValue(forKey: id) }
                else { self.mountedTerminalCounts[id] = remaining }
            }
            self.reconcileTerminalSubscription()
        }
        installPill()
        let start = resolve(.dormant)
        model.bar = start.placement
        model.content = start.content
        window.applyFrame(start.frame, animated: false)
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
        let host = FirstMouseHostingView(rootView: AnyView(PillHost(model: pillModel, scratch: scratchModel)))
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
        case let .bootstrap(appearance, tone, fill, show, terminalAutoExpand, present):
            Appearance.shared.preference = appearance
            Appearance.shared.tone = tone
            NotchGeometry.SurfaceFill.user = min(max(fill, 0.5), 0.95)
            let sharing: NSWindow.SharingType = show ? .readOnly : .none
            window.sharingType = sharing
            pillWindow.sharingType = sharing
            model.terminalAutoExpand = terminalAutoExpand
            autoPresent = present
            NotchLog.log("CMD bootstrap appearance=\(appearance.rawValue) tone=\(tone.rawValue) fill=\(fill) capture=\(show) terminal=\(terminalAutoExpand) present=\(present)")

        case .present:
            if !window.isVisible { window.present() }
            NotchLog.log("CMD present — bootstrap and replay complete")

        case let .setState(state, attention, working):
            NotchLog.log("CMD setState \(state.rawValue) attention=\(attention) working=\(working)")
            model.attention = attention
            model.working = working
            // A cached detail is not evidence that the task is still running —
            // but a FINISHED task's detail is not making that claim in the
            // first place, so it is not this check's business to evict it.
            //
            // This used to read `model.task?.status != .processing` — clearing
            // model.task on ANY compact-active refresh whose task was not the
            // one live worker, terminal statuses included. A refresh like that
            // fires constantly from ordinary ambient activity, not just from
            // the task actually finishing. Observed in the field: open a
            // finished task's detail (Inspect session), close it, and the very
            // next ambient refresh silently wiped it — reopening the panel any
            // normal way after that landed on "All clear. Nothing needs you."
            // forever, with no way back to that task's Resume/terminal short
            // of re-triggering whatever explicit action showed it the first
            // time.
            //
            // The thing actually worth correcting is a STALE claim: cached
            // detail says .processing while the fresh worker count says
            // otherwise. A done/failed/stuck/needsUser task was never claiming
            // to be running, so it is left alone here — the explicit dismiss
            // path (below) is still how the user actually closes it, and
            // .dormant still clears unconditionally on system idle.
            if state == .dormant {
                model.task = nil
            } else if state == .active, model.task?.status == .processing, working != 1 {
                model.task = nil
            }
            commandedState = state
            // A REPEAT OF WHAT ALREADY RESTED STAYS RESTED. The engine re-reports
            // a live task every few seconds; measured in the field, "1 waiting on
            // you" stood down and then blinked back roughly every fifteen seconds
            // because each report re-announced it. Nothing had changed, so there
            // was nothing to say. It is still one hover away.
            // Two suppressions, both only for a rung that announces:
            // NOTHING NEW TO SAY → SAY NOTHING.
            //
            // A banner is earned by a task id nobody has been told about yet.
            // Everything else — the same task reporting again, a count going
            // 2→3, the pocket flapping open and closed — is the engine talking
            // to itself, and none of it is news to the person watching.
            if isBannerRung(state), !isExpanded(state), !model.hovering {
                let ids = attentionTaskIds()
                NotchLog.log("banner: consider \(state.rawValue) ids=\(ids.sorted()) alreadyTold=\(announcedTaskIds.count) pocketOpen=\(model.pocket.isOpen) slots=\(model.pocket.slots.count)")
                if !ids.isEmpty, ids.isSubset(of: announcedTaskIds) {
                    NotchLog.log("banner: SUPPRESS — nothing new to say")
                    if restedFrom == nil { restedFrom = state }
                    // Put it down rather than merely declining to re-arm: a
                    // repeat arriving while the bar is up must settle too.
                    if model.state != .dormant, !isExpanded(model.state) { applyState(.dormant) }
                    return
                }
                let fresh = ids.subtracting(announcedTaskIds)
                announcedTaskIds.formUnion(ids)
                NotchLog.log("banner: ANNOUNCE \(state.rawValue) new=\(fresh.sorted()) told=\(announcedTaskIds.count)")
            }
            scheduleRest(for: state)
            switch departureTransition.receive(isExpanded: isExpanded(state)) {
            case .applyNormally:
                applyState(state)
            case .applyHidden:
                applyState(state, animated: false)
            case .applyImmediatelyAndShow:
                departureReturnTimer?.invalidate()
                applyState(state, animated: false)
                window.present()
                NotchLog.log("automatic departure settled compact — showing without destination-space collapse")
            }

        case let .agentActivity(activity):
            agentActivityTimer?.invalidate()
            model.agentActivity = activity
            if model.state == .dormant {
                applyState(.idle)
            } else if !isExpanded(model.state) {
                refreshBar()
            }
            if activity.state == .complete || activity.state == .failed {
                agentActivityTimer = Timer.scheduledTimer(withTimeInterval: 2.2, repeats: false) { [weak self] _ in
                    guard let self else { return }
                    self.model.agentActivity = nil
                    if self.commandedState == .dormant && self.model.state == .idle {
                        self.applyState(.dormant)
                    } else if !self.isExpanded(self.model.state) {
                        self.refreshBar()
                    }
                }
            }

        case let .showTask(task):
            NotchLog.log("CMD showTask id=\(task.id) status=\(task.status.rawValue)")
            // The task surface's SIZE now depends on the backend, and detail can
            // arrive independently of the setState that opened the surface —
            // cranking from a PTY task to a Codex one sends showTask with the
            // state unchanged. Without this the frame would keep the previous
            // task's proportions until the next state change.
            let fillChanged = model.task?.hasTerminal != task.hasTerminal
            model.prepareTaskConversation(task)
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
            if model.state == .task {
                interaction.reduce(.taskEntered(
                    id: task.id,
                    terminalDefaultOpen: model.terminalAutoExpand,
                    requiresTerminal: needsTerminalToAnswer(task)))
                projectInteraction()
            }
            reconcileTerminalSubscription()
            if model.state == .task && fillChanged { refit(animated: true) }
            // At bar level the fronted task IS the message — the right half
            // carries its activity, and the mass is as wide as what it says.
            else if !isExpanded(model.state) && model.state != .dormant { refreshBar() }

        case let .stageDetail(task):
            NotchLog.log("CMD stageDetail id=\(task.id) status=\(task.status.rawValue)")
            // Only meaningful while this task is (still) the focused one.
            if model.focusedId == nil || model.focusedId == task.id {
                model.focusedId = task.id
                model.prepareStageConversation(task)
                model.stageTask = task
                if needsTerminalToAnswer(task) { model.stageTerminalOpen = true }
                refit()
                reconcileTerminalSubscription()
            }

        case let .setCockpit(data):
            NotchLog.log("CMD setCockpit groups=\(data.groups.count) queue=\(data.queue.count) skills=\(data.skills.count)")
            model.cockpit = data
            // Focused task vanished (removed/purged) → back to the wall.
            if let f = model.focusedId, !data.groups.flatMap(\.cards).contains(where: { $0.id == f }) {
                model.focusedId = nil
                model.stageTask = nil
                model.clearStageConversation()
                reconcileTerminalSubscription()
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
            model.pocket = p
            let pocketIsVisible = !isExpanded(model.state) || model.state == .attention
            NotchLog.log("CMD pocket mode=\(p.mode) at=\(p.at) slots=\(p.slots.count)")
            // ONE STATE, SO ONE KIND OF CHANGE. Opening, closing, moving to the
            // next slot and a data-only update are all just "the surface says
            // something else now", which is a refit like any other. There is no
            // second size to sequence against.
            if pocketIsVisible { refit(animated: true) }

        case let .toast(text):
            showToast(text)

        case .notchGeometry:
            recomputeGeometry("explicit-push")

        case let .surfaceTone(tone):
            NotchLog.log("CMD surfaceTone \(tone.rawValue)")
            // Setting the @Published value is the whole job: Theme.plane and
            // Theme.railBg read Appearance.shared.tone, and every surface reads
            // those, so SwiftUI repaints an already-open surface on its own.
            // Same contract as `appearance` directly below.
            Appearance.shared.tone = tone

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
            let wasAimed = model.captureAimed
            model.captureAimed = state.phase == .recording
                && state.kind == .remote
                && model.capturePhase == "listening"
            // THE AIM CHANGES WHAT THE POCKET SAYS — the words give way to the
            // mic, in place — and the surface is as wide as what it says, so a
            // change of aim is a size change like any other. `pill` arrives for
            // every microphone-level sample, so only a CHANGE may move the
            // window, not 60 samples a second.
            if model.captureAimed != wasAimed, model.pocket.isOpen, !isExpanded(model.state) {
                refit(animated: true)
            }
            reconcileSurfaces()

        case let .scratchpad(payload):
            NotchLog.log("CMD scratchpad enabled=\(payload.enabled) armed=\(payload.armed) delivering=\(payload.delivering) entries=\(payload.pad?.entries.count ?? 0)")
            scratchModel.state = payload
            reconcileSurfaces()

        case let .caption(text, dwellMs, hold):
            showCaption(text: text, dwellMs: dwellMs, hold: hold)

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

    private func applyState(_ commanded: NotchState, animated: Bool = true) {
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
            expandedContentGeneration &+= 1
            let contentPrepared = state == .task ? model.task != nil
                : state == .cockpit ? model.cockpit != nil
                : true
            if SurfaceContentHandoff.shouldDelayExpandedContent(
                expandingFromPocket: expandingFromPocket,
                contentPrepared: contentPrepared
            ) && !Motion.reduceMotion {
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
        if state == .task, let task = model.task {
            interaction.reduce(.taskEntered(
                id: task.id,
                terminalDefaultOpen: model.terminalAutoExpand,
                requiresTerminal: needsTerminalToAnswer(task)))
        } else if model.state == .task && state != .task {
            interaction.reduce(.taskLeft)
        }
        projectInteraction()
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
        withAnimation(animated && !Motion.reduceMotion ? Motion.resize : nil) {
            model.state = state
            model.bar = r.placement
            model.content = r.content
        }
        reconcileTerminalSubscription()
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
        let contentGeneration = expandedContentGeneration
        let revealExpandedContent: (() -> Void)? = expandingFromPocket && !Motion.reduceMotion
            && !preserveContentHandoff && !model.expandedContentReady
            ? { [weak self] in
                guard let self, self.expandedContentGeneration == contentGeneration,
                      isExpanded(self.model.state) else { return }
                withAnimation(Theme.contentIn) {
                    self.model.expandedContentReady = true
                    self.model.transitionPocket = nil
                }
            }
            : nil
        window.applyFrame(r.frame, animated: animated, completion: revealExpandedContent)
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
                // ONE SHAPE ON EVERY DISPLAY. The notched case used to size a
                // bar-height mass from PocketRowMetrics and render a row across
                // the housing's shoulders. That is gone: the card is the only
                // arrangement, and on a notched Mac it opens BELOW the cutout —
                // `pocketTopInset` is the clearance, and pocketCardFrame adds it
                // to the height so the window is tall enough to hold it.
                //
                // The card is shorter when the task is not asking anything —
                // the middle row is dropped rather than filled with an echo of
                // the footer, so the window must not reserve room for it.
                let asking = !(model.pocket.current?.ask ?? "").isEmpty
                return (geometry.pocketCardFrame(hasAsk: asking), geometry.panelPlacement, BarContent())
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
    private func refreshBar(animated: Bool = true, completion: (() -> Void)? = nil) {
        let r = resolve(model.state)
        withAnimation(animated && !Motion.reduceMotion ? Motion.resize : nil) {
            model.bar = r.placement
            model.content = r.content
        }
        window.applyFrame(r.frame, animated: animated, completion: completion)
        NotchLog.log("bar \(model.state.rawValue) window=\(NotchLog.rect(r.frame)) mass=[\(Int(r.placement.left))|\(Int(r.placement.middle))|\(Int(r.placement.right))] left=\(r.content.left ?? "—") right=\(r.content.right ?? "—")")
    }

    // setPocketDetails / reducePocketInteraction / settlePocketGeometry /
    // finishPocketContentExit LIVED HERE, and they are gone with the second
    // pocket size they existed to sequence: grow the window, wait for it to
    // settle, then fade the extra controls in; on the way out, fade first and
    // contract after; never reverse a leg in flight; and a 0.18s debounce on
    // the exit because SwiftUI rebuilt its tracking region mid-resize and
    // reported a pointer exit the pointer had not made — which oscillated the
    // window between 64 and 146pt. One state has none of these problems.

    private func projectInteraction() {
        let p = interaction.presentation
        model.hovering = p.barHovered
        model.taskTerminalOpen = interaction.terminalVisible
    }

    private func reconcileTerminalSubscription() {
        let desired: String? = {
            if model.state == .task, model.taskTerminalOpen,
               let task = model.task, task.hasTerminal,
               mountedTerminalCounts[task.id, default: 0] > 0 { return task.id }
            if model.state == .cockpit, model.stageTerminalOpen,
               let task = model.stageTask, task.hasTerminal,
               mountedTerminalCounts[task.id, default: 0] > 0 { return task.id }
            return nil
        }()
        guard desired != subscribedTerminalID else { return }
        if let old = subscribedTerminalID { model.emit(.termClose(id: old)) }
        subscribedTerminalID = desired
        if let next = desired { model.emit(.termOpen(id: next)) }
    }

    /// The pointer contract is derived from the stable presentation, never the
    /// currently animated NSWindow frame. Expanded pixels cannot keep themselves
    /// expanded merely because they still exist during collapse.
    private func stableHitFrame(for region: SurfaceRegion) -> CGRect {
        switch region {
        case .bar:
            var content = BarContent.make(for: model, state: model.state, hovering: false)
            let mass = geometry.mass(left: content.leftWidth, right: content.wantsRightWidth)
            if mass.right == 0 { content.right = nil }
            return geometry.barFrame(mass)
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
        guard isExpanded(s) else { return s }
        let hasRecentGesture = lastGestureAt.map {
            Date().timeIntervalSince($0) < Self.gestureWindow
        } ?? false
        guard !SurfacePresentationPolicy.allowsExpandedRequest(
            autoPresent: autoPresent,
            surfaceIsAlreadyExpanded: isExpanded(model.state),
            hasRecentGesture: hasRecentGesture
        ) else { return s }
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
    private func refit(animated: Bool = false, completion: (() -> Void)? = nil) {
        refreshBar(animated: animated, completion: completion)
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
        if !isExpanded(model.state) { NotchLog.log("toast while collapsed — showing in bar: \(text)") }
        model.toast = text
        if model.pocket.isOpen { refit(animated: false) }
        else if !isExpanded(model.state) { refreshBar() }
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 1.8, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.model.toast = nil
            if self.model.pocket.isOpen { self.refit(animated: false) }
            else if !self.isExpanded(self.model.state) { self.refreshBar() }
        }
    }

    /// Local reactions to our own emits (snappy UI; main remains authoritative).
    private func afterEmit(_ ev: Event) {
        // THE USER JUST ASKED FOR SOMETHING ON THIS SURFACE. Recorded so that an
        // expansion arriving from main a moment later can be told apart from one
        // the app decided on by itself — see presentableState.
        if SurfacePresentationIntent.isExplicitGesture(presentationGesture(for: ev)) {
            lastGestureAt = Date()
        }
        switch ev {
        case .focusTask(let id):
            model.focusedId = id
            model.stageTask = nil // stageDetail arrives from main
            model.stageFull = stageFullState(current: model.stageFull, action: .focusTask)
        case .closeStage:
            model.focusedId = nil
            model.stageTask = nil
            model.stageFull = stageFullState(current: model.stageFull, action: .close)
        case .suggestionAccept, .suggestionReject:
            model.proposal = nil
            model.convLog = ""
        default: break
        }
    }

    private func presentationGesture(for event: Event) -> SurfacePresentationGesture {
        switch event {
        case .tap: return .tap
        case .openDashboard: return .openDashboard
        case .next: return .next
        case .prev: return .previous
        case .focusTask: return .focusTask
        case .pocketExpand: return .pocketExpand
        default: return .other
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
            if !interaction.presentation.barHovered {
                interaction.reduce(.pointerEntered(.bar))
                projectInteraction()
                if !isExpanded(model.state), model.state != .dormant { refreshBar() }
            }
            // A rested rung outranks the plain reveal: the question a quiet
            // notch raises is "is anything waiting on me", and idle cannot
            // answer it. Falls through to idle when nothing is held.
            if model.state == .dormant, restoreRestedRung() {
                // restored
            } else if model.state == .dormant && commandedState == .dormant {
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
                switch HoverExitDecision.resolve(pointerInsideSurface: self.stableHitFrame(for: .bar).contains(NSEvent.mouseLocation)) {
                case .keepRevealed:
                    return
                case .acceptExit:
                    break
                }

                let willSleep = self.model.state == .idle
                    && self.commandedState == .dormant
                    && self.geometry.hasNotch
                if self.interaction.presentation.barHovered {
                    self.interaction.reduce(.pointerExited(.bar))
                    self.projectInteraction()
                    if !self.isExpanded(self.model.state), self.model.state != .dormant, !willSleep {
                        self.refreshBar()
                    }
                }
                // A rung restored by hover goes back to sleep on exit —
                // otherwise one stray pointer pass reinstates the furniture
                // this whole change exists to remove.
                if self.isAnnounceable(self.model.state), self.commandedState == self.model.state,
                   !self.model.pocket.isOpen {
                    self.scheduleRest(for: self.model.state)
                    return
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
    // MARK: - Quiet at rest

    /// Rungs that announce and then stand down.
    ///
    /// `active` CARRIES TWO DIFFERENT THINGS and only one of them may rest.
    /// It is the rung for a live capture — where the user is inside it and the
    /// waveform is the feedback — but it is ALSO the rung that renders
    /// "Working" for N running tasks (see BarContent's `.active` case, which
    /// draws Theme.statusLabel(.processing) with a `working` badge). The first
    /// must persist; the second is the exact sentence that was parking over
    /// people's browser tabs. `capturePhase` is what separates them.
    ///
    /// `task` and `cockpit` are the EXPANDED surfaces — isExpanded() is those
    /// two — and an expanded surface is one the user opened. It stays.
    /// The rungs that can ever be a banner, IGNORING the pocket. Used for
    /// suppression, which must not be defeated by a flapping pocket payload:
    /// if it consulted the pocket, every flip to `open` would let a duplicate
    /// through, which is how "3 waiting on you" kept re-announcing.
    /// The phases where the microphone is actually hot. ONLY these keep the
    /// surface: the waveform is live feedback and pulling it mid-sentence
    /// would be wrong.
    ///
    /// `routing` is NOT one of them, and assuming it was is what kept the
    /// banner on screen. It is the POST-capture phase — the utterance is
    /// already taken and is being dispatched — but the old test was
    /// `capturePhase == nil`, so every routing phase read as "dictation in
    /// progress" and the bar never got a stand-down clock. The field log said
    /// so in as many words: `no clock — active is not announceable
    /// (capturePhase=routing)`, seven times in one session.
    private static let liveCapturePhases: Set<String> = ["listening", "recording"]

    private func isCaptureLive() -> Bool {
        guard let phase = model.capturePhase else { return false }
        return Self.liveCapturePhases.contains(phase)
    }

    private func isBannerRung(_ s: NotchState) -> Bool {
        switch s {
        case .attention: return true
        case .active:    return !isCaptureLive()
        default:         return false
        }
    }

    private func isAnnounceable(_ s: NotchState) -> Bool {
        // THE BANNER ALWAYS RESTS. No pocket condition here any more.
        //
        // It was tried twice and defeated both times by the same thing: the
        // pocket payload oscillates open→closed→open with an unchanged slot
        // count, so whether the bar "was a banner" depended on which side of a
        // flap a command happened to land. As a reschedule inside the timer it
        // made the banner immortal. Moved here to schedule time, a command
        // arriving while the pocket read `open` got no clock at all — the bar
        // appeared and simply stayed. That is what "1 waiting on you" sitting
        // there was, in both directions.
        //
        // It is also unnecessary. Dormant takes down the BAR only; the pocket
        // is a separate surface with its own render path (NotchView gates it
        // on model.pocket.isOpen), so standing the bar down does not close a
        // pocket someone is reading. The condition was guarding a problem that
        // does not exist, at the cost of the one guarantee that does.
        switch s {
        case .attention: return true
        case .active:    return !isCaptureLive()
        default:         return false
        }
    }

    /// Starts the stand-down clock for a rung that has just been shown.
    private func scheduleRest(for state: NotchState) {
        // Already counting down on this exact rung: let the clock run. Only a
        // CHANGE of rung, or a rung arriving while rested, starts a new one.
        if restPending == state, let t = restTimer, t.isValid { return }
        // A STATE THAT CANNOT ANNOUNCE MUST NOT DISARM ONE THAT DID.
        //
        // This used to invalidate the pending clock and then bail on the guard
        // below, so any `task` command landing inside a banner's two seconds
        // destroyed its countdown and never replaced it — the banner then sat
        // on screen until some later command happened to start AND finish a
        // clock of its own. Measured: 9 clocks started, 7 rests, and a 14s gap
        // where a banner was simply stranded. It is the reason "1 waiting on
        // you" stayed up until the task was opened by hand.
        //
        // Leaving the clock alone is right in both directions. If the new
        // state replaces the banner visually, the timer fires against a rung
        // that is no longer commanded and its own guard drops it harmlessly.
        // If it does not, the banner still stands down on schedule.
        guard isAnnounceable(state) else {
            NotchLog.log("banner: \(state.rawValue) cannot announce — leaving any live clock alone (capturePhase=\(model.capturePhase ?? "nil"))")
            return
        }
        restTimer?.invalidate(); restTimer = nil
        restedFrom = nil
        restPending = state
        NotchLog.log("banner: clock started, \(Self.restAfter)s → \(state.rawValue)")
        restTimer = Timer.scheduledTimer(withTimeInterval: Self.restAfter, repeats: false) { [weak self] _ in
            guard let self else { return }
            // IT ALWAYS GOES AWAY. There is no condition under which an
            // announceable rung outstays its couple of seconds.
            //
            // This used to reschedule while the pointer was on the surface or
            // the pocket payload said "open", meaning to be polite about not
            // yanking something away mid-read. With two tasks waiting the
            // pocket IS open, so the reschedule fired every two seconds
            // forever and the banner never left — "2 waiting on you" sat on
            // screen for minutes with exactly one rest in the whole log. A
            // politeness that can become permanent is not politeness.
            //
            // Hovering needs no special case: the pointer entering restores
            // the rung through the hover ladder, which is the designed way to
            // ask "what is waiting?" — a pull, not a residency.
            // DECIDED AT ANNOUNCE TIME, NOT RE-LITIGATED HERE.
            //
            // This used to re-ask isAnnounceable() when the timer fired, which
            // reads model.pocket. The field log shows the pocket payload
            // oscillating closed→open→closed→open with a constant slot count,
            // so a banner scheduled while it was closed found it open two
            // seconds later, bailed, and never rested — one rest event in a
            // whole session while "3 waiting on you" stayed on screen.
            //
            // Whether the bar was a banner is a fact about the moment it was
            // SHOWN. A flap arriving during its two seconds does not retroact
            // into it having been a surface all along.
            //
            // Still checked: that this timer is not stale (a newer command
            // schedules its own), and that a live capture has not claimed the
            // rung — resting mid-dictation would drop the waveform out from
            // under it. Neither of those flaps.
            guard self.commandedState == state,
                  !self.isCaptureLive() else {
                self.restPending = nil
                NotchLog.log("banner: clock ABANDONED — commanded=\(self.commandedState.rawValue) expected=\(state.rawValue) capture=\(self.model.capturePhase ?? "nil")")
                return
            }
            self.restPending = nil
            self.restedFrom = state
            NotchLog.log("rest: \(state.rawValue) → dormant (held, restorable on hover)")
            self.applyState(.dormant, animated: true)
        }
    }

    /// Puts back the rung that decayed. Used by the hover ladder in place of
    /// the plain dormant → idle reveal, so hovering answers the only question
    /// a quiet notch raises: is anything waiting on me?
    private func restoreRestedRung() -> Bool {
        guard let rung = restedFrom, commandedState == rung else { return false }
        restTimer?.invalidate(); restTimer = nil
        restedFrom = nil
        restPending = nil
        NotchLog.log("hover-reveal: dormant → \(rung.rawValue) (restored)")
        applyState(rung)
        return true
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
                // AN IMAGE PASTE IS NOT A TEXT PASTE, AND MUST NOT DEPEND ON
                // THE RESPONDER WALK FINDING THE RIGHT VIEW.
                //
                // ⌘V into the composer did nothing at all — text box focused,
                // image on the pasteboard, no attachment and no text — while
                // the same clipboard pasted fine into the terminal beside it.
                // Typing worked, because raw characters go straight to the
                // first responder; only the menu-borne commands were lost. So
                // when the focused view is a composer and the board carries an
                // image, stage it directly instead of hoping sendAction lands.
                if ch == "v", !shift,
                   let editor = self.window.firstResponder as? AttachmentTextView,
                   editor.stagePasteboardImage() {
                    NotchLog.log("edit command handled: ⌘V → composer attachment")
                    return nil
                }
                if let action, NSApp.sendAction(action, to: nil, from: nil) {
                    NotchLog.log("edit command handled: ⌘\(ch)")
                    return nil
                }
                if ch == "v" { NotchLog.log("⌘V reached NO responder — paste dropped") }
            }

            if typing { return e }
            guard self.model.state == .cockpit || self.model.state == .task else { return e }
            if e.keyCode == 48 { self.model.emit(.next); return nil }            // Tab → crank
            // ARROWS WALK THE CRANK, and only here.
            //
            // The Prev/Next buttons were the only way through a wall of tasks,
            // and reaching for a mouse to read the next one is the wrong shape
            // for a surface you opened with your voice.
            //
            // SCOPED TO THE ENGAGED SURFACES ON PURPOSE. Task and cockpit are
            // already key windows — `allowsKey = engaged` above — so this is a
            // LOCAL monitor consuming a key the panel legitimately owns, and it
            // costs nothing anywhere else. The pocket is deliberately excluded:
            // it never takes key, so arrows there would need a system-wide tap,
            // and arrows are pressed far more than Escape ever was — the video
            // playing behind the notch seeks with them. That is the same tap
            // that cost us dictation-cancel on 2026-08-16.
            //
            // The `typing` guard above already yields to the composer, so a
            // caret in a draft still moves a caret.
            if e.keyCode == 124 { self.model.emit(.next); return nil }           // →
            if e.keyCode == 123 { self.model.emit(.prev); return nil }           // ←
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
                if self.departureTransition.cancel() == .keepHidden {
                    NotchLog.log("automatic departure returning — hidden pending restored expanded state")
                    self.scheduleDepartureReturnFallback()
                } else if self.departureTransition.returnToExpanded(
                    isExpanded: self.isExpanded(self.model.state)
                ) == .hideUntilExpanded {
                    self.window.orderOut(nil)
                    NotchLog.log("automatic departure returning from compact — hidden pending restored expanded state")
                    self.scheduleDepartureReturnFallback()
                }
                self.model.emit(.userReturned)
            } else if self.isExpanded(self.model.state) {
                NotchLog.log("user left for \(app?.bundleIdentifier ?? "?") — collapsing")
                self.beginAutomaticDeparture(reason: "blur")
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
            self.beginAutomaticDeparture(reason: "space")
        }
    }

    private func beginAutomaticDeparture(reason: String) {
        departureReturnTimer?.invalidate()
        guard departureTransition.begin(isExpanded: isExpanded(model.state)) == .hide else { return }
        // The notification is delivered on the destination Space. Hide before
        // the IPC round-trip so no frame of the large surface can shrink there.
        window.orderOut(nil)
        NotchLog.log("automatic departure \(reason) — hidden pending compact state")
        model.emit(.userLeft(reason: reason))
    }

    private func scheduleDepartureReturnFallback() {
        departureReturnTimer?.invalidate()
        departureReturnTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
            guard let self,
                  self.departureTransition.abandonReturn() == .showCompact else { return }
            self.window.present()
            NotchLog.log("automatic departure return not restored — showing compact fallback")
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

    // ─── The caption ────────────────────────────────────────────────────
    //
    // EXACTLY ONE ON SCREEN, EVER. Concurrency is deliberately deferred, and
    // this constraint is what keeps it deferrable: a second answer replaces
    // the first rather than stacking, so there is never a queue to reason
    // about and never two captions competing for the same eye.

    /// A HELD caption is never left on screen forever.
    ///
    /// It has no dwell because the point is to read it slowly, but a surface
    /// with no clock and no owner is how the notch process once outlived the
    /// app that started it. Ten minutes is far past reading and far short of
    /// abandonment.
    private static let heldCaptionCeiling: TimeInterval = 600

    private func showCaption(text: String, dwellMs: Int, hold: Bool = false) {
        captionTimer?.invalidate()
        captionTimer = nil

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A held answer carries no dwell, so only the empty text means "down".
        guard !trimmed.isEmpty, hold || dwellMs > 0 else {
            dismissCaption()
            return
        }

        let window = captionWindow ?? CaptionWindow()
        captionWindow = window
        let host = NSHostingView(rootView: CaptionView(text: trimmed, holding: hold) { [weak self] in
            self?.dismissCaption()
        })
        host.setFrameSize(host.fittingSize)
        window.contentView = host
        window.setContentSize(host.fittingSize)
        // Held open, the body scrolls, so it must accept the clicks a caption
        // deliberately refuses.
        window.ignoresMouseEvents = false
        window.positionOnActiveScreen()
        window.orderFrontRegardless()

        // Dwell is computed by the sender from the text length: video captions
        // are timed to speech, and these have no clock.
        captionTimer = Timer.scheduledTimer(
            withTimeInterval: hold ? Self.heldCaptionCeiling : Double(dwellMs) / 1000.0,
            repeats: false
        ) { [weak self] _ in
            self?.dismissCaption()
        }
        NotchLog.log("caption shown chars=\(trimmed.count) dwellMs=\(dwellMs) hold=\(hold)")
    }

    private func dismissCaption() {
        captionTimer?.invalidate()
        captionTimer = nil
        captionWindow?.orderOut(nil)
    }

}
