import SwiftUI
import Combine

// Observable state the SwiftUI surface renders. AppController mutates it in
// response to commands; views emit user intents through `emit`.
final class NotchModel: ObservableObject {
    // Ladder + counts (pushed by main).
    @Published var state: NotchState = .dormant
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
    @Published var content: BarContent = BarContent()
    @Published var attention: Int = 0
    @Published var working: Int = 0

    // The fronted task (attention strip + task surface).
    @Published var task: TaskDetail? = nil

    // The wall.
    @Published var cockpit: CockpitData? = nil

    // Focused Stage (cockpit view-state lives HERE, on the Swift side, for
    // snappiness; main is told via focusTask/closeStage so voice routing tracks).
    @Published var focusedId: String? = nil
    @Published var stageTask: TaskDetail? = nil
    @Published var stageFull: Bool = false

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

    /// THE POCKET. What you set aside: still alive, still in the crank, still
    /// reachable by voice — and costing you nothing but the notch until you
    /// either speak or tap it open.
    @Published var pocket: PocketP = .empty

    // Terminal visibility (task surface toggle; Stage shows it by default when alive).
    @Published var taskTerminalOpen: Bool = false
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

    // Capture / voice chip: "listening → X", "routing…", "landed → X".
    @Published var capturePhase: String? = nil
    @Published var captureTarget: String? = nil

    // Transient toast (accept errors etc.).
    @Published var toast: String? = nil

    /// Whether the primary display has a hardware notch (drives idle content:
    /// text on a dummy notch would sit under the camera housing on real ones).
    @Published var hasNotch: Bool = false

    /// Event sink. Real emitter by default; overridable for tests/probe.
    var emit: (Event) -> Void = IPC.emit
    /// Hover relay → AppController (dormant ⇄ idle wake lives there).
    var onHover: (Bool) -> Void = { _ in }
    /// BACK, not close. Wired to AppController.stepDown — the graded walk back
    /// out of whatever you drilled into. Escape and an outside click no longer
    /// do this; they close outright, which is what those two gestures mean
    /// everywhere else on the platform.
    var onBack: () -> Void = {}

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
