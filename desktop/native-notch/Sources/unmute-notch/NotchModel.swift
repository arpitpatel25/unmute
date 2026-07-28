import SwiftUI
import Combine

// Observable state the SwiftUI surface renders. AppController mutates it in
// response to commands; views emit user intents through `emit`.
final class NotchModel: ObservableObject {
    // Ladder + counts (pushed by main).
    @Published var state: NotchState = .dormant
    /// The rung MAIN last asked for. `state` is what is rendered and flips
    /// instantly; the window frame animates behind it, so during a morph the two
    /// disagree. Anything whose appearance must not survive into the next state
    /// — the attention colour wash above all — gates on BOTH.
    @Published var commandedState: NotchState = .dormant
    /// Is the pointer over the surface right now?
    ///
    /// Only idle reads it, and only on notched hardware: at rest unmute is
    /// invisible there, so hovering is the one way to ask whether it is running.
    /// Published because the WIDTH of the window follows what the tongue says,
    /// and on notched hardware idle says nothing until you hover.
    @Published var hovering: Bool = false
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

    // Terminal visibility (task surface toggle; Stage shows it by default when alive).
    @Published var taskTerminalOpen: Bool = false

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

    // Terminal byte fan-out: TerminalHost subscribes; AppController publishes.
    let termBytes = PassthroughSubject<(id: String, bytes: [UInt8]), Never>()

    /// The task the Stage/task-surface currently shows (stage wins in cockpit).
    var frontDetail: TaskDetail? { state == .cockpit ? stageTask : task }
}
