import Foundation
import ConversationSupport
import IPCSupport

// The v2 wire protocol between Electron main and this helper.
// Line-delimited JSON, one object per line, UTF-8.
//
// This is the FULL cockpit/overlay data model (spec 2026-07-24 + the function
// inventory): everything the old React wall + overlay rendered now travels over
// this channel so the native surface can reproduce it function-for-function.
//
// Design notes:
//   * Commands (main → helper) decode via a manual `type` switch — an unknown
//     command is ignored, never a crash.
//   * Events (helper → main) are encoded compactly via `json`.
//   * All stdout writes go through IPC.emit (one line + flush, thread-safe).

// MARK: - Shared enums

enum NotchState: String, Codable {
    case dormant, idle, active, attention, task, cockpit
}

/// Task status exactly as the runtime reports it (UiTaskState).
enum TaskStatus: String, Codable {
    case processing
    case needsUser = "needs-user"
    case ready, stuck, done, failed

    /// One-color rule (R1): color encodes status only.
    var isYourMove: Bool { self == .needsUser || self == .ready || self == .stuck || self == .failed }
}

// MARK: - Payloads (Codable, camelCase on the wire)

struct ArtifactP: Codable { let type: String; let value: String } // "url" | "path"

typealias QuestionReferenceP = ChatQuestionReference
typealias QuestionAcknowledgmentP = ChatQuestionAcknowledgment
struct ChatPreviewP: Codable {
    let allocationId: String
    let path: String
    let permission: String
    let permissionReason: String?
}
struct QuestionP: Codable {
    let reference: QuestionReferenceP?
    let acknowledgment: String?
    let text: String
    var details: String? = nil
    /// "free_text" | "choice" | "confirm" | "terminal_only".
    /// `terminal_only` is a REFUSAL: a picker we have not proven we can drive is
    /// open in the session, so the card shows the whole ask and offers no reply.
    let kind: String?
    let choices: [String]?
    let irreversible: Bool?
}

/// THE POCKET — a small expanded state. See notch-client.ts for the full why.
/// `open` only ever happens because the user opened it: open is aimed, closed
/// is the router, and the pocket must never open itself.
struct PocketSlotP: Codable, Equatable {
    let id: String
    let title: String
    /// WHICH KIND OF THING THIS IS. The pocket holds tasks and it holds the
    /// Agent, and they are not the same object wearing different data: the
    /// Agent is always there, is never in the task queue, and wears the Unmute
    /// mark instead of a provider's. Absent means task, so a payload written
    /// before this existed still reads correctly.
    let kind: String?
    let ask: String?
    let status: String?
    /// Is this one actually waiting on you? The card reads quieter when not,
    /// and only these are ever counted at you.
    let demanding: Bool?
    /// Which backend this slot runs on, so the pocket can show its mark.
    let backend: String?
    /// Owns a terminal — drives the terminal glyph beside the mark.
    let terminal: Bool?
}

struct PocketP: Codable, Equatable {
    let mode: String          // "closed" | "open"
    let at: Int
    /// How many slots are actually waiting on you. THE ONLY NUMBER THE CLOSED
    /// SURFACE MAY EVER SHOW. `slots.count` used to stand in for this and it
    /// counted the seam card and everything you had merely worked in — so a
    /// pocket holding two finished tasks announced "3 in your pocket" and made
    /// a quiet shelf look like a queue.
    let waiting: Int
    /// Which key routes here — "fn" or "right-option".
    let remoteKey: String?
    let slots: [PocketSlotP]

    static let empty = PocketP(mode: "closed", at: 0, waiting: 0, remoteKey: nil, slots: [])

    /// How the routing key is written on the card. RAW DICTATION NEVER LANDS
    /// HERE — it goes to the cursor — so "your voice" claimed a key it does not
    /// own. Name the one that actually routes.
    var routeKeyLabel: String { remoteKey == "fn" ? "Fn" : "Right ⌥" }
    var taskCount: Int { slots.count }
    var current: PocketSlotP? { at >= 0 && at < slots.count ? slots[at] : nil }
    var isOpen: Bool { mode == "open" && !slots.isEmpty }
}

struct ResultP: Codable { let summary: String; let detail: String?; let artifacts: [ArtifactP]? }
struct ErrorP: Codable { let reason: String; let detail: String? }
struct McpGapP: Codable { let message: String; let fixCommand: String }
struct DraftAttachmentP: Codable { let id: String; let path: String; let mimeType: String; let name: String; var reservationOrder: Int? = nil }
struct FollowupP: Codable {
    let id: String; let phase: String; let label: String; let preview: String
    let attachments: [DraftAttachmentP]
    let canCancel: Bool; let canRestore: Bool; let canQueueAgain: Bool
}
struct DraftOperationP: Codable { let id: String; let name: String; let phase: String; let error: String?; let order: Int? }
struct TaskDraftP: Codable {
    let text: String; let attachments: [DraftAttachmentP]; let clientRevision: Int?
    var stagingCount: Int? = nil; var error: String? = nil; var operations: [DraftOperationP]? = nil
    /// The visual tool armed for this message, echoed back by the host so the
    /// chip reflects what the ENGINE believes rather than what the last tap
    /// hoped — the same rule every other composer control follows. Cleared by
    /// the host once the message is accepted, so a tool is never carried into
    /// a message the user did not arm it for.
    var tool: String? = nil
}
/// One command the composer's slash menu can insert.
///
/// EVERY property is defaulted, and that is the contract rather than a style
/// choice: a synthesized decoder makes an undefaulted key mandatory, so one
/// renamed field on the host silently drops the WHOLE TaskDetail and the card
/// stops updating (the CockpitData trap the Checks script exists to catch).
///
/// `token` is provider-native — "/name" for Claude, "$name" for Codex — and is
/// inserted verbatim. Never rebuild it from `name`.
struct CommandP: Codable {
    var name: String = ""
    var title: String = ""
    var description: String = ""
    var argumentHint: String = ""
    var scope: String = ""
    var token: String = ""

    private enum CodingKeys: String, CodingKey { case name, title, description, argumentHint, scope, token }

    /// A DEFAULT VALUE IS NOT A DECODER DEFAULT. The synthesized `init(from:)`
    /// ignores the declarations above and makes every key mandatory, so one
    /// command missing a `title` throws — and the throw takes the whole
    /// TaskDetail with it, not just that row. Read every field as optional.
    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        // `try?` flattens the optional decodeIfPresent returns: a missing key
        // and a wrong-typed one both land on the declaration's default.
        func text(_ key: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: key)) ?? "" }
        name = text(.name)
        title = text(.title)
        description = text(.description)
        argumentHint = text(.argumentHint)
        scope = text(.scope)
        token = text(.token)
    }
}

struct ChatChoiceP: Codable {
    let id: String; let label: String; let description: String?
    /// A provider's own models, for the Agent's picker; nil everywhere else.
    let models: [ChatChoiceP]?; let selected: String?
}
struct ChatConfigP: Codable {
    let provider: String; let providerLabel: String; let model: String; let modelLabel: String
    let providers: [ChatChoiceP]; let models: [ChatChoiceP]; let efforts: [ChatChoiceP]; let effort: String?
    let permissions: [ChatChoiceP]; let permission: String?; let permissionScope: String?
    let cwd: String; let mutable: Bool; let busy: Bool; let error: String?
    let dictation: String?; let dictationError: String?
}

/// Full detail for the fronted task (task surface) or the focused Stage.
struct TaskDetail: Codable {
    var canEditLatestMessage: Bool? = nil
    var olderMessages: Int? = nil
    let id: String
    let title: String
    let origin: String?
    let agentRunId: String?
    let status: TaskStatus
    let kind: String           // "oneoff" | "session"
    let alive: Bool
    let shelved: Bool?
    let dir: String?
    let age: String?
    let elapsed: String?
    let warmup: String?        // thread_context / where-you-left-off
    let note: String?
    let activity: String?      // question.text ‖ error.reason ‖ step ‖ result.summary
    let question: QuestionP?
    var questionAcknowledgment: QuestionAcknowledgmentP? = nil
    var history: ChatHistoryState? = nil
    var turnOutcome: String? = nil
    var mcpStatuses: [ChatMcpStatus]? = nil
    let result: ResultP?
    let error: ErrorP?
    let mcpGap: McpGapP?
    /// Last message that did not reach the agent. NOT a task failure — the
    /// thread is fine, our delivery missed.
    let deliveryError: String?
    /// A message is in flight to the agent.
    let sending: Bool?
    /// What this thread runs on, as Codex labels it ("5.6 Terra High").
    let modelLabel: String?
    let agentCanRetry: Bool?
    /// Which backend runs this task. Absent ⇒ Claude (PTY-backed).
    let backend: String?       // "codex-desktop"
    /// Last few turns — the GUI-agent equivalent of the live terminal. A Codex
    /// thread has no PTY, so the conversation itself is what this panel shows.
    let conversation: [TurnP]?
    /// THE CHAT VIEW. Preferred over `conversation` whenever present; the older
    /// field remains only for tasks persisted before this shipped.
    let blocks: [Block]?
    /// Context usage for the footer, when the provider reports it.
    let usage: BlockUsage?
    /// Codex project name, for the header.
    let project: String?
    let draft: TaskDraftP?
    var followup: FollowupP? = nil
    var composerMode: String? = nil
    var chatConfig: ChatConfigP? = nil
    var canCompose: Bool? = nil
    /// What `/` offers in this thread's composer. Absent for a host older than
    /// the menu, and for a provider that has no commands.
    var commands: [CommandP]? = nil

    /// Does this task have a live terminal? SENT by the engine, which resolves it
    /// from the one provider registry (electron/remote/providers.ts). This is
    /// what picks between SurfaceFill.desktopTask and .terminalTask.
    ///
    /// It used to be decided here, from a local set of desktop backends — a
    /// second source of truth that had ALREADY drifted from the TypeScript one
    /// (it listed a `claude-code-desktop` that does not exist in AgentKind).
    /// Adding a backend meant remembering to edit a Swift file too, and
    /// forgetting silently handed the new agent a terminal's frame.
    let terminal: Bool?

    /// Can a finished task be brought back? SENT, not inferred. The nine
    /// `backend == "codex-desktop"` checks this replaces were each a negation of
    /// one backend, and each one silently mis-answered for the next backend to
    /// arrive — the shape of every recent bug on this surface.
    let resumable: Bool?
    /// Did Unmute spawn the process? Decides Kill (ours to stop) versus Remove
    /// (forget the card, leave the user's app alone).
    let owned: Bool?
    /// The CLI process is being restored for this conversation.
    let resuming: Bool?
    /// Why the latest restore attempt failed, when it did.
    let resumeError: String?

    /// Fallback for an engine older than the `terminal` field, and ONLY that.
    /// Do not add backends here — add them to providers.ts.
    private static let legacyDesktopBackends: Set<String> = ["codex-desktop", "claude-code-desktop"]

    /// Does this task have a live terminal? Absent backend ⇒ Claude's PTY.
    var hasTerminal: Bool {
        if let terminal { return terminal }
        guard let backend else { return true }
        return !Self.legacyDesktopBackends.contains(backend)
    }

    /// Same legacy fallback as `hasTerminal`, and for the same reason: an engine
    /// older than these fields must still classify correctly rather than
    /// defaulting every backend to Claude's answers.
    var canResume: Bool {
        if let resumable { return resumable }
        guard let backend else { return true }
        return !Self.legacyDesktopBackends.contains(backend)
    }
    /// The app this task's work lives in, when it is not ours. Naming is
    /// display; the DECISION to show a door into it is `isOwned` — a capability
    /// — so a backend added tomorrow gets the affordance without a Swift edit,
    /// and only its name is missing rather than the whole button.
    var foreignAppName: String {
        switch backend {
        case "codex-desktop":       return "Codex"
        case "claude-code-desktop": return "Claude"
        default:                    return ""
        }
    }
    var isOwned: Bool {
        if let owned { return owned }
        guard let backend else { return true }
        return !Self.legacyDesktopBackends.contains(backend)
    }
}

/// One turn of a GUI-agent conversation.
struct TurnP: Codable {
    /// "user" | "commentary" | "tool" | "assistant" — Codex's own distinctions,
    /// kept rather than flattened (see codex/rollout.ts).
    let role: String
    let text: String
    /// tool: the step's label, as Codex titles it ("Search YouTube").
    let title: String?
    /// tool: the exact code/command it ran.
    let code: String?
    /// tool: what came back.
    let output: String?
    /// tool: wall time Codex reported, in ms.
    let durationMs: Int?
    /// tool: false when the step reported an error.
    let ok: Bool?
}

// `blocks` and `usage` on TaskDetailP are decoded straight into the
// ConversationSupport types — see Blocks.swift. They are optional on the wire
// so a task rehydrated from a meta.json written before the upgrade still
// renders, through `conversation` below.

extension ConversationTurn {
    init(_ turn: TurnP) {
        self.init(role: turn.role, text: turn.text, title: turn.title,
                  code: turn.code, output: turn.output,
                  durationMs: turn.durationMs, ok: turn.ok)
    }
}

/// A resting card on the wall.
struct CardP: Codable {
    let id: String
    let title: String
    let origin: String?
    let agentRunId: String?
    let activity: String?
    let status: TaskStatus
    let kind: String           // "oneoff" | "session"
    let dir: String?
    let age: String?
    let qpos: Int?             // queue position (1-based) if queued
    let promoted: Bool?        // "↑ now a session"
    let agent: Bool?           // "↳ agent" (spawnedBy)
    let note: String?
    let alive: Bool
    /// Which backend runs this card. Absent ⇒ Claude (PTY-backed).
    let backend: String?
    /// Owns a terminal. Absent ⇒ assume yes for a PTY-era engine.
    let terminal: Bool?
    let project: String?
    /// The model that RAN this task (D6). Absent ⇒ show the agent alone.
    let model: String?
}

struct GroupP: Codable {
    let name: String
    let cards: [CardP]
    /// Settled cards folded away by the 48h rule; nil/0 when nothing is hidden.
    let hidden: Int?
    /// True while this group is showing everything it holds.
    let expanded: Bool?
}   // name "" = ungrouped
struct QueueItemP: Codable { let id: String; let name: String; let status: TaskStatus }
struct OneoffP: Codable { let id: String; let name: String; let status: TaskStatus; let age: String? }
struct ProjectP: Codable { let name: String; let path: String }
struct SuggestionP: Codable { let id: String; let kind: String; let name: String } // new/narrow/split/merge/retire
struct SkillP: Codable {
    let name: String
    let pinned: Bool
    let runs: Int
    let lastUsed: String?
    let description: String?
    let origin: String?        // "unmute" for curator-authored
}

struct AgentOriginPresentation {
    let label: String
    let runId: String?
}

protocol AgentOriginPresenting {
    var origin: String? { get }
    var agentRunId: String? { get }
}

extension AgentOriginPresenting {
    var agentOriginPresentation: AgentOriginPresentation? {
        guard origin == "unmute-agent" else { return nil }
        return AgentOriginPresentation(label: "Unmute", runId: agentRunId)
    }
}

extension TaskDetail: AgentOriginPresenting {}
extension CardP: AgentOriginPresenting {}

enum AgentActivityState: String, Codable {
    case listening, searching, thinking, confirming, complete, failed
}

struct AgentActivityP: Codable {
    let state: AgentActivityState
    let summary: String
    let interactionId: String?
    let agentRunId: String?
    let provider: String?
}
struct ShelfItemP: Codable { let id: String; let name: String }
/// A Claude Code CLI session on this machine that unmute does not have. Exists
/// only to be imported; once it is a task it stops being listed.
struct ImportableP: Codable, Equatable {
    let sessionId: String
    let title: String
    let project: String
    let age: String
    /// WHICH CLI this session belongs to. The engine has always sent it; the
    /// rail simply never read it, so two backends' sessions sat in one
    /// undifferentiated list under a heading that named only Claude.
    let agent: String?
}
struct RouteOfferP: Codable { let newTaskId: String; let altTaskId: String; let altName: String }

/// The whole wall.
struct CockpitData: Codable {
    var projects: [ProjectP]? = nil
    let groups: [GroupP]
    /// Cards folded away across the whole wall.
    let hiddenTotal: Int?
    /// True while "show all" is on for this visit.
    let showingAll: Bool?
    /// Is the 24-hour Today filter on? A filter over the whole wall, NOT the
    /// per-group fold — two controls, two questions, two words.
    let todayOnly: Bool?
    let queue: [QueueItemP]
    let oneoffs: [OneoffP]
    let unmuteSkills: [SkillP]
    let skills: [SkillP]
    let shelf: [ShelfItemP]
    let importable: [ImportableP]?
    let digest: String?        // "while you were away: …" or nil
    let doorbell: Bool
    let routeOffer: RouteOfferP?
    let tmuxAvailable: Bool
}

/// Full skill-review proposal (popup).
struct ProposalDetail: Codable {
    let id: String
    let kind: String           // new/narrow/split/merge/retire
    let name: String
    let evidence: String       // "seen 3× · 3 sessions · ~12 min of work"
    let summary: String
    let bullets: [String]?
    let body: String?          // drafted SKILL.md (create)
    let diff: String?          // unified diff (narrow/split/merge)
}

// MARK: - Commands (main → helper)

struct HelpGuideEntryP: Codable, Identifiable {
    let id: String
    let title: String
    let summary: String
    let shortcut: String?
    let steps: [String]?
    let example: String?
}

struct HelpGuideSectionP: Codable, Identifiable {
    let id: String
    let title: String
    let intro: String
    let entries: [HelpGuideEntryP]
}

struct HelpGuideP: Codable {
    let title: String
    let sections: [HelpGuideSectionP]
}

enum Command {
    /// Complete preferences applied atomically before the helper presents any
    /// window. Also replayed after a supervised restart.
    case bootstrap(appearance: SurfaceAppearance, surfaceTone: SurfaceTone,
                   surfaceFill: CGFloat,
                   screenCaptureVisibility: Bool, terminalAutoExpand: Bool,
                   autoPresent: Bool)
    /// Sent after bootstrap plus replay so no stale/default frame flashes.
    case present
    case setState(state: NotchState, attention: Int, working: Int)
    case messageEditStatus(id: String, accepted: Bool, error: String?)
    case showTask(TaskDetail)                  // fronted task (attention/task surface)
    case stageDetail(TaskDetail)               // focused Stage detail (cockpit)
    case setCockpit(CockpitData)
    case termData(id: String, dataB64: String) // PTY output chunk (base64)
    case proposal(ProposalDetail)              // response to suggestionOpen
    case convData(id: String, text: String)    // review-conversation output chunk
    case capturePhase(phase: String, target: String?)
    case pocket(PocketP)                       // what your next words could land on
    case toast(String)                         // transient message (e.g. accept error)
    case newChatStatus(pending: Bool, error: String?)
    case newChatPreview(token: String, preview: ChatPreviewP?, error: String?)
    case questionAnswerStatus(id: String, reference: QuestionReferenceP, state: String)
    case draftAttachmentError(id: String, operationId: String, error: String)
    case notchGeometry(hasNotch: Bool, x: Double, y: Double, w: Double, h: Double)
    /// Surface material preference, from unmute Settings. "system" (default)
    /// honours System Settings → Accessibility → Reduce Transparency; "glass"
    /// and "solid" are explicit user overrides. See SurfaceAppearance.
    case appearance(SurfaceAppearance)
    /// The ground colour — Space Gray or black. Separate from `appearance`,
    /// which is the material.
    case surfaceTone(SurfaceTone)
    /// May the surface present ITSELF when a task needs attention or finishes?
    /// From unmute Settings → Appearance & notch. DEFAULT ON, and absent means
    /// on — see AppController.presentableState.
    ///
    /// ADDITIVE. The line is `{"type":"autoPresent","on":false}`; an engine that
    /// never sends it leaves the surface at its default, and an engine that
    /// sends it to an older helper is ignored (`default: return .unknown`). No
    /// existing field changed shape.
    case autoPresent(Bool)
    /// ADDITIVE. `{"type":"surfaceFill","fill":0.8}` — the share of the screen
    /// an expanded surface fills. An engine too old to send it leaves the
    /// built-in 0.8, so this is safe to ignore.
    case surfaceFill(CGFloat)
    /// Whether all Unmute surfaces appear in screenshots and screen sharing.
    /// Missing/malformed `show` defaults to true, matching the product default.
    case screenCaptureVisibility(Bool)
    /// `{"type":"terminalAutoExpand","on":true}` — see NotchModel.
    case terminalAutoExpand(Bool)
    /// Full state of the bottom-centre input surface. Pushed on every change,
    /// including the per-frame level during a capture — one float, which is the
    /// only new traffic the capture path gains.
    case pill(PillState)
    /// The scratchpad: a capture HELD instead of delivered, plus where it can
    /// go. See ScratchpadModel — every field on that payload decodes leniently,
    /// so a partial or older push still draws instead of being dropped.
    case scratchpad(ScratchpadPayload)
    case agentActivity(AgentActivityP)
    case helpGuide(HelpGuideP)
    case collapse
    case quit
    case unknown

    static func decode(_ line: String) -> Command {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String
        else { return .unknown }

        func sub<T: Decodable>(_ key: String, _ t: T.Type) -> T? {
            guard let o = obj[key], let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
            return try? JSONDecoder().decode(t, from: d)
        }

        switch type {
        case "bootstrap":
            let appearance = SurfaceAppearance(rawValue: obj["appearance"] as? String ?? "system") ?? .system
            // READ AT BOOTSTRAP, not only on change. The host has always sent
            // this field; dropping it here meant the tone applied live and then
            // reverted to Space Gray on the next launch — a setting that
            // forgets itself every restart.
            let tone = SurfaceTone(rawValue: obj["surfaceTone"] as? String ?? "spaceGray") ?? .spaceGray
            return .bootstrap(
                appearance: appearance,
                surfaceTone: tone,
                surfaceFill: CGFloat(obj["surfaceFill"] as? Double ?? 0.8),
                screenCaptureVisibility: obj["showInScreenCapture"] as? Bool ?? true,
                terminalAutoExpand: obj["terminalAutoExpand"] as? Bool ?? false,
                autoPresent: obj["autoPresent"] as? Bool ?? true)
        case "present":
            return .present
        case "messageEditStatus":
            return .messageEditStatus(id: obj["id"] as? String ?? "", accepted: obj["accepted"] as? Bool ?? false, error: obj["error"] as? String)
        case "setState":
            let state = NotchState(rawValue: obj["state"] as? String ?? "dormant") ?? .dormant
            return .setState(state: state,
                             attention: (obj["attention"] as? NSNumber)?.intValue ?? 0,
                             working: (obj["working"] as? NSNumber)?.intValue ?? 0)
        case "showTask":
            guard let t = sub("task", TaskDetail.self) else { return .unknown }
            return .showTask(t)
        case "stageDetail":
            guard let t = sub("task", TaskDetail.self) else { return .unknown }
            return .stageDetail(t)
        case "setCockpit":
            guard let d = sub("data", CockpitData.self) else { return .unknown }
            return .setCockpit(d)
        case "termData":
            guard let id = obj["id"] as? String, let b64 = obj["data"] as? String else { return .unknown }
            return .termData(id: id, dataB64: b64)
        case "pill":
            guard let p = sub("state", PillState.self) else { return .unknown }
            return .pill(p)
        case "scratchpad":
            // A payload that fails to decode falls back to EMPTY rather than
            // .unknown: every field is optional with a default, so the only way
            // to get here is a malformed `data`, and an empty pad (no panel) is
            // the safe reading of "we do not know what is held".
            return .scratchpad(sub("data", ScratchpadPayload.self) ?? .empty)
        case "agentActivity":
            guard let activity = sub("activity", AgentActivityP.self) else { return .unknown }
            return .agentActivity(activity)
        case "helpGuide":
            guard let guide = sub("guide", HelpGuideP.self) else { return .unknown }
            return .helpGuide(guide)
        case "appearance":
            // An unknown value falls back to `.system` rather than being
            // dropped: a malformed preference must never leave the surface
            // ignoring the user's accessibility setting.
            let raw = obj["value"] as? String ?? "system"
            return .appearance(SurfaceAppearance(rawValue: raw) ?? .system)
        case "surfaceTone":
            // Unknown -> spaceGray, which is what shipped before this was a
            // choice: a malformed value must never silently restyle the surface.
            let raw = obj["value"] as? String ?? "spaceGray"
            return .surfaceTone(SurfaceTone(rawValue: raw) ?? .spaceGray)
        case "terminalAutoExpand":
            return .terminalAutoExpand(obj["on"] as? Bool ?? false)
        case "surfaceFill":
            // A missing or malformed value means the default, not a dropped
            // command — same rule as `appearance` above. AppController clamps
            // it again before anything is resized.
            return .surfaceFill(CGFloat(obj["fill"] as? Double ?? 0.8))
        case "screenCaptureVisibility":
            return .screenCaptureVisibility(obj["show"] as? Bool ?? true)
        case "autoPresent":
            // A MISSING OR MALFORMED `on` MEANS ON. The setting's default is on
            // (engine: overlayAutoPresent), and a surface that silently stopped
            // presenting itself because one line was mistyped is a far worse
            // failure than one that presents when the user asked it not to.
            return .autoPresent(obj["on"] as? Bool ?? true)
        case "proposal":
            guard let p = sub("data", ProposalDetail.self) else { return .unknown }
            return .proposal(p)
        case "convData":
            guard let id = obj["id"] as? String, let text = obj["text"] as? String else { return .unknown }
            return .convData(id: id, text: text)
        case "capturePhase":
            return .capturePhase(phase: obj["phase"] as? String ?? "",
                                 target: obj["target"] as? String)
        case "pocket":
            // A malformed payload falls back to EMPTY-AND-CLOSED, same rule as
            // `scratchpad`: an unreadable pocket must never leave a card up
            // claiming an address we cannot vouch for.
            return .pocket(sub("data", PocketP.self) ?? .empty)
        case "toast":
            return .toast(obj["text"] as? String ?? "")
        case "newChatStatus":
            return .newChatStatus(pending: obj["pending"] as? Bool ?? false, error: obj["error"] as? String)
        case "newChatPreview":
            return .newChatPreview(token: obj["token"] as? String ?? "", preview: sub("preview", ChatPreviewP.self), error: obj["error"] as? String)
        case "questionAnswerStatus":
            guard let reference = sub("reference", QuestionReferenceP.self), let id = obj["id"] as? String else { return .unknown }
            return .questionAnswerStatus(id: id, reference: reference, state: obj["state"] as? String ?? "rejected")
        case "draftAttachmentError":
            guard let id = obj["id"] as? String, let operation = obj["operationId"] as? String else { return .unknown }
            return .draftAttachmentError(id: id, operationId: operation, error: obj["error"] as? String ?? "Could not prepare attachment")
        case "notchGeometry":
            return .notchGeometry(hasNotch: obj["hasNotch"] as? Bool ?? false,
                                  x: (obj["x"] as? NSNumber)?.doubleValue ?? 0,
                                  y: (obj["y"] as? NSNumber)?.doubleValue ?? 0,
                                  w: (obj["w"] as? NSNumber)?.doubleValue ?? 0,
                                  h: (obj["h"] as? NSNumber)?.doubleValue ?? 0)
        case "collapse": return .collapse
        case "quit": return .quit
        default: return .unknown
        }
    }
}

// MARK: - Events (helper → main)

enum Event {
    case ready
    case tap                                       // step up (context decided by main)
    case collapsed                                 // stepped down to baseline
    case openDashboard
    case next                                      // crank forward
    case prev                                      // crank backward
    case editLatestMessage(id: String, expected: String, text: String)
    case loadOlderMessages(id: String)
    case focusTask(id: String)                     // card clicked → voice address
    case pocketFocusTask(id: String)               // session link → open the POCKET on that card
    case showAll(group: String?, on: Bool)         // reveal folded cards (nil = whole wall)
    case today(on: Bool)                           // 24h filter over the whole wall
    case importSession(sessionId: String)          // adopt a CLI session as a task
    case closeStage                                // Stage esc → back to wall
    /// The user left Unmute — another app came forward, so an expanded task
    /// goes to the pocket instead of staying in their way.
    case userLeft(reason: String)                  // "blur" | "screenshot"
    case userReturned                              // …and inside the grace window, it re-opens
    case pocketMove(delta: Int)                    // carousel: which address
    case pocketOpen                                // tap it open (sticky = an explicit aim)
    case pocketRelease                             // let go — back to the notch
    /// Back to the FULL task. The pocket is a glance, not a destination:
    /// it exists because the panel is large, not because it is wrong.
    /// EXPAND THE SLOT THE CARD IS SHOWING, named by id.
    ///
    /// The id is the point. This used to carry nothing and the host opened
    /// `slots[pocketAt]` — a POSITION into a list it recomputed at expand time.
    /// The pocket is ordered by engagement, so the list re-sorts underneath the
    /// index: the card said "Job listing platform", Return arrived, the list had
    /// moved, and position 0 was a different task by then. Reported exactly
    /// that way — "the task that is open is job listing, but when I press enter
    /// I see this task".
    case pocketExpand(id: String?)
    case chooseOption(id: String, index: Int, reference: QuestionReferenceP? = nil)
    case answerText(id: String, text: String, reference: QuestionReferenceP? = nil)
    case setDraftText(id: String, text: String, clientRevision: Int = 0)
    /// The composer gained or lost first responder. Dictation uses this to hand
    /// captured images straight to the focused text box instead of posting a
    /// synthetic ⌘V that may not reach this app — see registerComposerImageSink.
    case composerFocus(id: String, focused: Bool)
    /// This window stopped being key. The counterpart AppKit never gives us:
    /// resignFirstResponder fires only for focus moves inside one window, so
    /// clicking away to another app produced no composerFocus(false) at all.
    case windowUnfocused
    case addDraftImage(id: String, path: String, mimeType: String, name: String, insertionOffset: Int? = nil, selectedLength: Int? = nil, clientRevision: Int? = nil, insertionText: String? = nil, operationId: String? = nil)
    case reserveDraftAttachment(id: String, operationId: String, name: String, insertionOffset: Int, selectedLength: Int, clientRevision: Int, insertionText: String)
    case failDraftAttachment(id: String, operationId: String, error: String)
    case configureChat(id: String, field: String, value: String)
    case toggleDraftDictation(id: String, insertionOffset: Int? = nil, selectedLength: Int? = nil, clientRevision: Int? = nil, insertionText: String? = nil)
    case cancelDraftDictation(id: String)
    case newChat(provider: String, cwd: String?, allocationId: String? = nil, permission: String? = nil)
    case previewChat(token: String, provider: String, permission: String)
    case removeDraftAttachment(id: String, attachmentId: String)
    case restoreDraftAttachment(id: String, attachmentId: String)
    case undoDraftAttachment(id: String, attachmentId: String)
    case redoDraftAttachment(id: String, attachmentId: String)
    /// ARM A VISUAL TOOL FOR THE NEXT MESSAGE ONLY, or clear it with nil.
    ///
    /// The ONLY way a drawing is ever asked for. Nothing infers it from what
    /// you said, and nothing infers it from what the answer looks like — a
    /// surface that decides on your behalf when to draw is one that draws when
    /// you did not want it to, and the cost of that lands on your own tokens.
    /// So the tool is a thing you pick, in the composer, before you send.
    case setDraftTool(id: String, tool: String?)
    case sendDraft(id: String, reference: QuestionReferenceP? = nil)
    case agentSend(submissionId: String, revision: Int)
    case agentRetry
    case agentSwitchProvider(provider: String)
    case agentSetModel(provider: String, model: String)
    /// End the Agent conversation and keep nothing; the next turn starts clean.
    case agentNewConversation
    case cancelTaskFollowup(id: String, queueId: String)
    case restoreTaskFollowup(id: String, queueId: String)
    case queueSavedTaskFollowup(id: String, queueId: String)
    case recoverUncertainFollowup(id: String, queueId: String)
    case mute(id: String)                          // drop from attention/crank this episode
    case kill(id: String)
    case resume(id: String)
    case reloadHistory(id: String)
    case rerun(id: String)                         // re-run fresh from intent
    case remove(id: String)
    case killAll
    case setKind(id: String, kind: String)         // pin/unpin oneoff↔session
    case shelve(id: String, shelved: Bool)
    case rename(id: String, name: String)
    case setNote(id: String, note: String)
    case pinSkill(name: String, pinned: Bool)
    case tapSkill(name: String)                    // type /name unsubmitted into focused task
    case openProject(path: String, name: String)
    case clearFinished
    case digestDismiss
    case bellToggle
    /// Hold the room quiet while a card is open, and give it back on close.
    case backgroundAudio(muted: Bool)
    case surfaceFillChanged(fill: CGFloat)
    case offerAccept(newTaskId: String)
    case openArtifact(type: String, value: String)
    case openInTerminal(id: String)
    case termOpen(id: String)                      // start streaming PTY output
    case termClose(id: String)
    case termInput(id: String, dataB64: String)
    case termResize(id: String, cols: Int, rows: Int)
    case suggestionOpen(id: String)
    case suggestionAccept(id: String)
    case suggestionReject(id: String, reason: String)
    case converseWrite(id: String, text: String)
    case converseStop(id: String)
    // ── The scratchpad ──
    //
    // ARM IS THE ONLY THING THE ICON SENDS. Deliver and discard come from the
    // pad's own footer, where they read as the deliberate acts they are — a
    // toggle that also sent would turn "never mind" into a dispatched task.
    case scratchpadArm(Bool)
    case scratchpadRemove(id: String)
    /// "cursor" | "newTask" | "openTask" — chosen at the END, never at the start.
    case scratchpadDeliver(dest: String)
    case scratchpadDiscard

    var json: [String: Any] {
        switch self {
        case .ready: return ["type": "ready"]
        case .tap: return ["type": "tap"]
        case .collapsed: return ["type": "collapsed"]
        case .openDashboard: return ["type": "openDashboard"]
        case .next: return ["type": "next"]
        case .prev: return ["type": "prev"]
        case .editLatestMessage(let id, let expected, let text): return ["type": "editLatestMessage", "id": id, "expected": expected, "text": text]
        case .loadOlderMessages(let id): return ["type": "loadOlderMessages", "id": id]
        case .focusTask(let id): return ["type": "focusTask", "id": id]
        case .pocketFocusTask(let id): return ["type": "pocketFocusTask", "id": id]
        case let .today(on): return ["type": "today", "on": on]
        case let .importSession(sessionId): return ["type": "importSession", "sessionId": sessionId]
        case .showAll(let group, let on):
            var d: [String: Any] = ["type": "showAll", "on": on]
            if let g = group { d["group"] = g }
            return d
        case .closeStage: return ["type": "closeStage"]
        case let .userLeft(reason): return ["type": "userLeft", "reason": reason]
        case .userReturned: return ["type": "userReturned"]
        case let .pocketMove(delta): return ["type": "pocketMove", "delta": delta]
        case .pocketOpen: return ["type": "pocketOpen"]
        case .pocketRelease: return ["type": "pocketRelease"]
        case .pocketExpand(let id):
            var payload: [String: Any] = ["type": "pocketExpand"]
            if let id { payload["id"] = id }
            return payload
        case .chooseOption(let id, let index, let reference):
            var payload: [String: Any] = ["type": "chooseOption", "id": id, "index": index]
            if let reference { payload["reference"] = reference.payload }; return payload
        case .answerText(let id, let text, let reference):
            var payload: [String: Any] = ["type": "answerText", "id": id, "text": text]
            if let reference { payload["reference"] = reference.payload }; return payload
        case .setDraftText(let id, let text, let revision): return ["type": "setDraftText", "id": id, "text": text, "clientRevision": revision]
        case .composerFocus(let id, let focused): return ["type": "composerFocus", "id": id, "focused": focused]
        case .windowUnfocused: return ["type": "windowUnfocused"]
        case .addDraftImage(let id, let path, let mimeType, let name, let offset, let length, let revision, let text, let operation):
            var payload: [String: Any] = ["type": "addDraftImage", "id": id, "path": path, "mimeType": mimeType, "name": name]
            if let offset { payload["insertionOffset"] = offset }
            if let length { payload["selectedLength"] = length }
            if let revision { payload["clientRevision"] = revision }
            if let text { payload["insertionText"] = text }
            if let operation { payload["operationId"] = operation }
            return payload
        case .reserveDraftAttachment(let id, let operation, let name, let offset, let length, let revision, let text):
            return ["type": "reserveDraftAttachment", "id": id, "operationId": operation, "name": name,
                    "insertionOffset": offset, "selectedLength": length, "clientRevision": revision, "insertionText": text]
        case .failDraftAttachment(let id, let operation, let error):
            return ["type": "failDraftAttachment", "id": id, "operationId": operation, "error": error]
        case .configureChat(let id, let field, let value): return ["type": "configureChat", "id": id, "change": [field: value]]
        case .toggleDraftDictation(let id, let offset, let length, let revision, let text):
            var insertion: [String: Any] = [:]
            if let offset { insertion["insertionOffset"] = offset }
            if let length { insertion["selectedLength"] = length }
            if let revision { insertion["clientRevision"] = revision }
            if let text { insertion["insertionText"] = text }
            return ["type": "toggleDraftDictation", "id": id, "insertion": insertion]
        case .cancelDraftDictation(let id): return ["type": "cancelDraftDictation", "id": id]
        case .newChat(let provider, let cwd, let allocationId, let permission):
            var result: [String: Any] = ["type": "newChat", "provider": provider]
            if let cwd { result["cwd"] = cwd }
            if let allocationId { result["allocationId"] = allocationId }
            if let permission { result["permission"] = permission }
            return result
        case .previewChat(let token, let provider, let permission): return ["type": "previewChat", "token": token, "provider": provider, "permission": permission]
        case .removeDraftAttachment(let id, let attachmentId): return ["type": "removeDraftAttachment", "id": id, "attachmentId": attachmentId]
        case .restoreDraftAttachment(let id, let attachmentId): return ["type": "restoreDraftAttachment", "id": id, "attachmentId": attachmentId]
        case .undoDraftAttachment(let id, let attachmentId): return ["type": "undoDraftAttachment", "id": id, "attachmentId": attachmentId]
        case .redoDraftAttachment(let id, let attachmentId): return ["type": "redoDraftAttachment", "id": id, "attachmentId": attachmentId]
        case .setDraftTool(let id, let tool):
            // NSNull rather than omitting the key: "clear the tool" and "I did
            // not mention the tool" must not be the same message, or disarming
            // would silently do nothing.
            return ["type": "setDraftTool", "id": id, "tool": tool ?? NSNull()]
        case .sendDraft(let id, let reference):
            var payload: [String: Any] = ["type": "sendDraft", "id": id]
            if let reference { payload["reference"] = reference.payload }; return payload
        case .agentSend(let submissionId, let revision):
            return ["type": "agentSend", "submissionId": submissionId, "revision": revision]
        case .agentRetry: return ["type": "agentRetry"]
        case .agentSwitchProvider(let provider): return ["type": "agentSwitchProvider", "provider": provider]
        case .agentSetModel(let provider, let model): return ["type": "agentSetModel", "provider": provider, "model": model]
        case .agentNewConversation: return ["type": "agentNewConversation"]
        case .cancelTaskFollowup(let id, let queueId): return ["type": "cancelTaskFollowup", "id": id, "queueId": queueId]
        case .restoreTaskFollowup(let id, let queueId): return ["type": "restoreTaskFollowup", "id": id, "queueId": queueId]
        case .queueSavedTaskFollowup(let id, let queueId): return ["type": "queueSavedTaskFollowup", "id": id, "queueId": queueId]
        case .recoverUncertainFollowup(let id, let queueId): return ["type": "recoverUncertainFollowup", "id": id, "queueId": queueId]
        case .mute(let id): return ["type": "mute", "id": id]
        case .kill(let id): return ["type": "kill", "id": id]
        case .resume(let id): return ["type": "resume", "id": id]
        case .reloadHistory(let id): return ["type": "reloadHistory", "id": id]
        case .rerun(let id): return ["type": "rerun", "id": id]
        case .remove(let id): return ["type": "remove", "id": id]
        case .killAll: return ["type": "killAll"]
        case .setKind(let id, let kind): return ["type": "setKind", "id": id, "kind": kind]
        case .shelve(let id, let shelved): return ["type": "shelve", "id": id, "shelved": shelved]
        case .rename(let id, let name): return ["type": "rename", "id": id, "name": name]
        case .setNote(let id, let note): return ["type": "setNote", "id": id, "note": note]
        case .pinSkill(let name, let pinned): return ["type": "pinSkill", "name": name, "pinned": pinned]
        case .tapSkill(let name): return ["type": "tapSkill", "name": name]
        case .openProject(let path, let name): return ["type": "openProject", "path": path, "name": name]
        case .clearFinished: return ["type": "clearFinished"]
        case .digestDismiss: return ["type": "digestDismiss"]
        case .bellToggle: return ["type": "bellToggle"]
        case .backgroundAudio(let muted): return ["type": "backgroundAudio", "muted": muted]
        case .surfaceFillChanged(let fill): return ["type": "surfaceFillChanged", "fill": fill]
        case .offerAccept(let id): return ["type": "offerAccept", "newTaskId": id]
        case .openArtifact(let type, let value): return ["type": "openArtifact", "artifactType": type, "value": value]
        case .openInTerminal(let id): return ["type": "openInTerminal", "id": id]
        case .termOpen(let id): return ["type": "termOpen", "id": id]
        case .termClose(let id): return ["type": "termClose", "id": id]
        case .termInput(let id, let b64): return ["type": "termInput", "id": id, "data": b64]
        case .termResize(let id, let cols, let rows): return ["type": "termResize", "id": id, "cols": cols, "rows": rows]
        case .suggestionOpen(let id): return ["type": "suggestionOpen", "id": id]
        case .suggestionAccept(let id): return ["type": "suggestionAccept", "id": id]
        case .suggestionReject(let id, let reason): return ["type": "suggestionReject", "id": id, "reason": reason]
        case .converseWrite(let id, let text): return ["type": "converseWrite", "id": id, "text": text]
        case .converseStop(let id): return ["type": "converseStop", "id": id]
        case .scratchpadArm(let on): return ["type": "scratchpadArm", "on": on]
        case .scratchpadRemove(let id): return ["type": "scratchpadRemove", "id": id]
        case .scratchpadDeliver(let dest): return ["type": "scratchpadDeliver", "dest": dest]
        case .scratchpadDiscard: return ["type": "scratchpadDiscard"]
        }
    }
}

// MARK: - Framing

enum IPC {
    private static let stdout = FileHandle.standardOutput
    private static let lock = NSLock()

    /// Write one JSON line to stdout and flush. Thread-safe.
    static func emit(_ event: Event) { emitRaw(event.json) }

    /// The input surface's events carry their own JSON (see PillEvent) rather
    /// than being folded into the notch's Event enum — they are a separate
    /// surface with a separate vocabulary, and mixing them would let a pill
    /// gesture reach a task handler.
    static func emit(_ event: PillEvent) { emitRaw(event.json) }

    static func emitRaw(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var line = data
        line.append(0x0A)
        lock.lock(); defer { lock.unlock() }
        stdout.write(line)
    }

    /// Read stdin line-by-line on a background thread; decoded commands are
    /// delivered to `onCommand` on the main queue (AppKit-safe).
    static func startReadLoop(onCommand: @escaping (Command) -> Void) {
        Thread.detachNewThread {
            let input = FileHandle.standardInput
            var framer = JSONLineFramer()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { // EOF — parent gone
                    // ASK NICELY, THEN LEAVE ANYWAY.
                    //
                    // This used to dispatch .quit and return, which made the
                    // only escape hatch depend on the main thread being healthy.
                    // When it was not, an orphaned notch kept a screenSaver-level
                    // window over every other app with nothing driving it — and
                    // force-quitting "unmute" never touched it, because this
                    // process is called unmute-notch. People rebooted.
                    Lifecycle.shutdownNow(reason: "stdin-eof", onCommand: onCommand)
                    return
                }
                framer.append(chunk) { lineData in
                    if let line = String(data: lineData, encoding: .utf8),
                       !line.trimmingCharacters(in: .whitespaces).isEmpty {
                        let cmd = Command.decode(line)
                        DispatchQueue.main.async { onCommand(cmd) }
                    }
                }
            }
        }
    }
}
