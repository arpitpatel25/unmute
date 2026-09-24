import SwiftUI
import Combine
import ConversationSupport

// Observable state the SwiftUI surface renders. AppController mutates it in
// response to commands; views emit user intents through `emit`.
final class NotchModel: ObservableObject {
    // Ladder + counts (pushed by main).
    @Published var state: NotchState = .dormant {
        didSet {
            // A HOLD BELONGS TO THE OPEN CARD, AND THE RELEASE IS DRIVEN FROM
            // HERE — not from the close event.
            //
            // The engine also releases on `collapsed`, but that is only ONE of
            // the ways a card goes away: onUserLeft collapses the surface when
            // you switch app or swipe to another Space, and never raises it.
            // Releasing there and only there would leave the audio muted with
            // the control gone, which is precisely the state this feature
            // promises cannot happen.
            //
            // Every path ends here, because every path changes the state. So
            // the label and the debt are cleared by the same line and cannot
            // disagree. The engine's own release stays as belt-and-braces; a
            // release with nothing held is a no-op.
            if state != .task && backgroundAudioMuted {
                backgroundAudioMuted = false
                emit(.backgroundAudio(muted: false))
            }
        }
    }

    /// Is the room being held quiet from the open task card? Local to the
    /// surface: the engine owns the actual media debt and settles it on
    /// collapse, this is only what the control says.
    @Published var backgroundAudioMuted: Bool = false
    // NO `commandedState` HERE ANY MORE.
    //
    // It mirrored the rung MAIN last asked for, so a view could refuse to carry
    // an appearance into a state it had already left — the attention colour wash
    // surviving into a task-sized frame mid-morph. That wash is gone (the
    // bar-level mass is opaque black in every state, D5) and the separation is
    // now structural: the mass is only drawn at bar level and the expanded panel
    // draws glass, so nothing needs to ask what was commanded. AppController
    // keeps its own copy for the hover ladder, which is the only thing that
    // still cares.

    /// Is the pointer over the surface right now?
    ///
    /// HOVER REVEALS, NEVER OPENS. It adds one level of detail to whatever the
    /// mass is already saying and grows it a little to fit; it does not change
    /// the state and it does not expand the panel. Published because the WIDTH
    /// of the window follows what the mass says.
    @Published var hovering: Bool = false

    /// WHERE THE MASS IS AND WHAT SHAPE IT IS, resolved by AppController from
    /// the screen the surface is on right now.
    ///
    /// The window frame, the shape path and the content row are all built from
    /// this one value, inside one animation transaction, so they cannot
    /// disagree about how wide the surface is mid-morph.
    @Published var bar: MassPlacement = .empty
    /// What the two halves say. Same story: measured once, rendered once.
    /// SENTENCES THAT HAVE ALREADY HAD THEIR TWO SECONDS.
    ///
    /// THE RULE: anything the bar says is said for two seconds and then stops
    /// being said. Not "the rung stands down" — the rung standing down was
    /// already implemented and did not achieve it, because the content ladder
    /// in `BarContent.make` sits ABOVE the rung switch: the pocket count only
    /// asks whether the state is expanded, so the instant the surface rested to
    /// dormant/idle the identical sentence was rendered again at the identical
    /// width. Measured in one session's notch.log: "N waiting on you" drawn
    /// 6,613 times at `idle` against 4,013 at `attention` — more often in the
    /// rung it had just retreated to than in the rung whose job it was.
    ///
    /// So the silencing is keyed on WHAT IS SAID, not on which rung says it.
    /// A different sentence does not match and speaks for its own two seconds;
    /// the same sentence returning stays quiet.
    ///
    /// A SET, not one value, because two sentences can alternate. A task
    /// flapping done→processing→done makes the bar swing between "Working" and
    /// "1 waiting on you", and a single slot would let the pair re-announce
    /// each other forever. Emptied whenever the bar genuinely has nothing to
    /// say, which is the real end of an episode — see AppController.refreshBar.
    @Published var silenced: Set<String> = []

    @Published var content: BarContent = BarContent()
    @Published var attention: Int = 0
    @Published var working: Int = 0

    /// Ephemeral Unmute Agent progress. It is deliberately separate from tasks:
    /// only a consequential final result is allowed onto the wall.
    @Published var agentActivity: AgentActivityP? = nil
    @Published var helpGuide: HelpGuideP? = nil
    @Published var helpGuidePresented = false

    // The fronted task (attention strip + task surface).
    @Published var task: TaskDetail? = nil
    /// The task whose title is being edited in the expanded view. Set by the
    /// pen (or a click on the title) there, and by the pocket's pen BEFORE it
    /// expands the card, so the editor opens as the card lands. Cleared on
    /// commit, on Escape, and when the editor goes away.
    @Published var renamingTaskId: String? = nil
    @Published private(set) var taskConversationRows: [ConversationRow] = []

    // The wall.
    @Published var cockpit: CockpitData? = nil

    // Focused Stage (cockpit view-state lives HERE, on the Swift side, for
    // snappiness; main is told via focusTask/closeStage so voice routing tracks).
    @Published var focusedId: String? = nil
    @Published var stageTask: TaskDetail? = nil
    @Published private(set) var stageConversationRows: [ConversationRow] = []
    @Published var stageFull: Bool = false

    private var taskConversationSource: [ConversationTurn]?
    private var stageConversationSource: [ConversationTurn]?

    /// The chat view proper. Empty means this task has none yet — which is the
    /// case for a task persisted before blocks shipped, and for a Claude
    /// Desktop conversation we can read but not itemise. Both then fall back to
    /// the row transcript above.
    @Published private(set) var taskBlocks: [Block] = []
    @Published private(set) var stageBlocks: [Block] = []
    @Published private(set) var taskUsage: BlockUsage? = nil
    @Published private(set) var stageUsage: BlockUsage? = nil

    /// Prepare the stable transcript model when IPC data changes, not while
    /// SwiftUI is repeatedly laying the same transcript out during a resize.
    func prepareTaskConversation(_ task: TaskDetail) {
        // BLOCKS WIN WHEN PRESENT. Prepared here, off the layout path, for the
        // same reason the rows are: a resize must not rebuild the transcript.
        taskBlocks = task.blocks ?? []
        taskUsage = task.usage
        let turns = (task.conversation ?? []).map(ConversationTurn.init)
        guard turns != taskConversationSource else { return }
        taskConversationRows = ConversationPresentation.build(turns)
        taskConversationSource = turns
    }

    func prepareStageConversation(_ task: TaskDetail) {
        stageBlocks = task.blocks ?? []
        stageUsage = task.usage
        let turns = (task.conversation ?? []).map(ConversationTurn.init)
        guard turns != stageConversationSource else { return }
        stageConversationRows = ConversationPresentation.build(turns)
        stageConversationSource = turns
    }

    func clearTaskConversation() {
        taskConversationRows = []
        taskConversationSource = nil
        taskBlocks = []
        taskUsage = nil
    }

    func clearStageConversation() {
        stageConversationRows = []
        stageConversationSource = nil
        stageBlocks = []
        stageUsage = nil
    }

    // Skills UI state.
    @Published var skillsExpanded: Bool = false
    @Published var hoverSkill: SkillP? = nil
    /// Hovered row's frame in window coordinates — the detail card anchors
    /// BESIDE the row (field feedback: never at a far corner of the panel).
    @Published var hoverSkillFrame: CGRect = .zero

    // Skill-review popup.
    @Published var proposal: ProposalDetail? = nil
    @Published var proposalLoadingId: String? = nil
    @Published var convLog: String = ""            // streamed review-conversation output

    /// The Agent's routines sheet. On the model rather than view state so
    /// Escape (AppController.stepDown) can close it before the card.
    @Published var routinesSheetOpen: Bool = false

    /// THE POCKET. What you set aside: still alive, still in the crank, still
    /// reachable by voice — and costing you nothing but the notch until you
    /// either speak or tap it open.
    @Published var pocket: PocketP = .empty
    /// How tall the card inside each shoulder is, on a notched display.
    ///
    /// Derived from the MEASURED menu bar (see PocketRowMetrics), so it travels
    /// with the same resolve pass that sizes the window rather than being
    /// recomputed inside the view from a number the view does not have.
    @Published var pocketCardHeight: CGFloat = 27
    /// Fallback for the rare pocket → expanded transition where its destination
    /// data has not arrived yet. Prepared content participates in the resize;
    /// withholding it is what previously produced a large blank panel.
    @Published var transitionPocket: PocketP? = nil
    @Published var expandedContentReady: Bool = true

    // Terminal visibility (task surface toggle; Stage shows it by default when alive).
    @Published var taskTerminalOpen: Bool = false
    /// User intent enters the controller's reducer through this closure. Views
    /// never mutate a second terminal-visibility authority directly.
    var setTaskTerminalVisible: (Bool) -> Void = { _ in }
    /// Live mic level, 0…1, mirrored from the pill's stream while a capture is
    /// running and zero otherwise. The pocket draws it so the card you are
    /// aiming at shows that it is being heard.
    @Published var captureLevel: Double = 0
    /// IS A TASK-DIRECTED CAPTURE RUNNING RIGHT NOW?
    ///
    /// Derived in one place from TWO independent signals, and read by three
    /// surfaces. `capturePhase == "listening"` alone was the condition, and it
    /// is only as reliable as the key-up that ends it: miss that event and the
    /// chip stays lit forever, telling the user their voice is going somewhere
    /// it is not. The pill's own phase is the corroborating witness — it says
    /// whether audio is actually being captured, and of which kind.
    ///
    /// `remote` ONLY. Dictation and the Caps-Lock formatter both put text where
    /// the cursor is, not into a task, so a mic on a card would be a lie about
    /// both.
    @Published var captureAimed: Bool = false
    /// Does opening a CLI task show its terminal immediately?
    ///
    /// OFF by default, which is the behaviour that shipped: the panel opens on
    /// the answer and the terminal is one tap away. People who live in the
    /// terminal want the opposite and were re-opening it on every task, so it
    /// is a preference now rather than a decision made for them.
    @Published var terminalAutoExpand: Bool = false
    /// The orchestrator stage's own terminal toggle. Separate from
    /// `taskTerminalOpen` on purpose: the two surfaces answer different
    /// questions. A task pulled to ATTENTION should greet you with what it
    /// said (closed); a stage you opened deliberately should show the work
    /// (open). One flag for both would force one answer on both.
    @Published var stageTerminalOpen: Bool = true
    var setStageTerminalVisible: (Bool) -> Void = { _ in }
    /// A terminal view reports mount state; AppController remains the sole
    /// owner of the termOpen/termClose effect. This prevents replay bytes from
    /// racing ahead of SwiftTerm during a surface transition.
    var setTerminalMounted: (String, Bool) -> Void = { _, _ in }

    // Capture / voice chip: "listening → X", "routing…", "landed → X".
    @Published var capturePhase: String? = nil
    @Published var captureTarget: String? = nil

    // Transient toast (accept errors etc.).
    @Published var toast: String? = nil
    /// A resumed or forked session just landed in the pocket: the card's title.
    /// A quiet cue, not a toast — nothing went wrong, and the pocket stays shut.
    @Published var pocketLanded: String? = nil
    @Published var newChatPending = false
    @Published var newChatError: String? = nil
    @Published var newChatPreview: ChatPreviewP? = nil
    @Published var newChatPreviewToken: String = ""
    @Published var questionSubmissions: [String: QuestionAcknowledgmentP] = [:]

    func questionBusy(_ id: String, _ question: QuestionP?) -> Bool {
        guard let reference = question?.reference else { return false }
        return question?.acknowledgment != nil || questionSubmissions[id]?.reference == reference
    }
    func beginQuestion(_ id: String, _ question: QuestionP?) -> Bool {
        guard !questionBusy(id, question) else { return false }
        if let reference = question?.reference { questionSubmissions[id] = QuestionAcknowledgmentP(reference: reference, state: "pending") }
        else { questionSubmissions.removeValue(forKey: id) }
        return true
    }
    func questionStatus(_ id: String, _ reference: QuestionReferenceP, _ state: String) {
        guard questionSubmissions[id] == nil || questionSubmissions[id]?.reference == reference else { return }
        if state == "rejected" { questionSubmissions.removeValue(forKey: id) }
        else { questionSubmissions[id] = QuestionAcknowledgmentP(reference: reference, state: state) }
    }
    func restoreQuestionAcknowledgment(_ task: TaskDetail) {
        questionSubmissions[task.id] = mergeChatAcknowledgment(current: questionSubmissions[task.id],
            incoming: task.questionAcknowledgment, displayed: task.question?.reference)
    }

    /// Whether the primary display has a hardware notch (drives idle content:
    /// text on a dummy notch would sit under the camera housing on real ones).
    @Published var hasNotch: Bool = false

    /// How far the open pocket card starts below the top edge. Mirrors
    /// `NotchGeometry.pocketTopInset`, which sizes the window from the same
    /// number — the view must not compute its own or the card gets clipped.
    @Published var pocketTopInset: CGFloat = 6
    /// The housing's width, so the shoulder row can leave a gap the exact size
    /// of the cutout. 0 on a display without one — the row then has no gap and
    /// is simply a header.
    @Published var pocketCutoutWidth: CGFloat = 0

    /// Event sink. Real emitter by default; overridable for tests/probe.
    var emit: (Event) -> Void = IPC.emit
    /// Hover relay → AppController (dormant ⇄ idle wake lives there).
    var onHover: (Bool) -> Void = { _ in }
    /// BACK, not close. Wired to AppController.stepDown — the graded walk back
    /// out of whatever you drilled into. Escape and an outside click no longer
    /// do this; they close outright, which is what those two gestures mean
    /// everywhere else on the platform.
    var onBack: () -> Void = {}

    /// Temporary, expanded-surface-only size controls. The controller owns the
    /// selected fill and clears it when the expansion closes.
    @Published var selectedSurfaceFill: CGFloat = 0.8
    var selectSurfaceFill: (CGFloat) -> Void = { _ in }
    /// A SMALL NOTCH: the size control at 55% or below. Controls that would
    /// otherwise spell themselves out (the footer's keys, Visual, dictation)
    /// show as icons, so the words on the card are the conversation's.
    var compactSurface: Bool { selectedSurfaceFill <= 0.55 }

    /// Is there somewhere to go back TO? False on the bare wall, where the only
    /// move left is closing — and a back arrow that just closes is a lie about
    /// where you are.
    var canGoBack: Bool {
        if proposal != nil || proposalLoadingId != nil { return true }
        if state == .cockpit && focusedId != nil { return true }
        return stageFull
    }

    // Terminal byte fan-out: TerminalHost subscribes; AppController publishes.
    let termBytes = PassthroughSubject<(id: String, bytes: [UInt8]), Never>()

    /// The task the Stage/task-surface currently shows (stage wins in cockpit).
    var frontDetail: TaskDetail? { state == .cockpit ? stageTask : task }
}
