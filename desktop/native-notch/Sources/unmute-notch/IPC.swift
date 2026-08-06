import Foundation

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

struct QuestionP: Codable {
    let text: String
    /// "free_text" | "choice" | "confirm" | "terminal_only".
    /// `terminal_only` is a REFUSAL: a picker we have not proven we can drive is
    /// open in the session, so the card shows the whole ask and offers no reply.
    let kind: String?
    let choices: [String]?
    let irreversible: Bool?
}

/// THE POCKET — see notch-client.ts for why this state exists at all.
/// `closed` lives in the notch as a count; `transient` is showing because you
/// are speaking; `sticky` is showing because you tapped it. Only the last one
/// makes the forefront the voice's address.
struct PocketSlotP: Codable, Equatable {
    let id: String?
    let kind: String          // "auto" | "task" | "new"
    let title: String
    let ask: String?
    let status: String?
}

struct PocketP: Codable, Equatable {
    let mode: String          // "closed" | "transient" | "sticky"
    let at: Int
    let slots: [PocketSlotP]

    static let empty = PocketP(mode: "closed", at: 0, slots: [])
    /// Only the real tasks — the two synthetic stops are not things you set aside.
    var taskCount: Int { slots.filter { $0.kind == "task" }.count }
    var current: PocketSlotP? { at >= 0 && at < slots.count ? slots[at] : nil }
    var isOpen: Bool { mode != "closed" && !slots.isEmpty }
}

struct ResultP: Codable { let summary: String; let detail: String?; let artifacts: [ArtifactP]? }
struct ErrorP: Codable { let reason: String; let detail: String? }
struct McpGapP: Codable { let message: String; let fixCommand: String }

/// Full detail for the fronted task (task surface) or the focused Stage.
struct TaskDetail: Codable {
    let id: String
    let title: String
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
    /// Which backend runs this task. Absent ⇒ Claude (PTY-backed).
    let backend: String?       // "codex-desktop"
    /// Last few turns — the GUI-agent equivalent of the live terminal. A Codex
    /// thread has no PTY, so the conversation itself is what this panel shows.
    let conversation: [TurnP]?
    /// Codex project name, for the header.
    let project: String?

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

    /// Fallback for an engine older than the `terminal` field, and ONLY that.
    /// Do not add backends here — add them to providers.ts.
    private static let legacyDesktopBackends: Set<String> = ["codex-desktop", "claude-code-desktop"]

    /// Does this task have a live terminal? Absent backend ⇒ Claude's PTY.
    var hasTerminal: Bool {
        if let terminal { return terminal }
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

/// A resting card on the wall.
struct CardP: Codable {
    let id: String
    let title: String
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
struct ShelfItemP: Codable { let id: String; let name: String }
struct RouteOfferP: Codable { let newTaskId: String; let altTaskId: String; let altName: String }

/// The whole wall.
struct CockpitData: Codable {
    let groups: [GroupP]
    /// Cards folded away across the whole wall.
    let hiddenTotal: Int?
    /// True while "show all" is on for this visit.
    let showingAll: Bool?
    let queue: [QueueItemP]
    let oneoffs: [OneoffP]
    let unmuteSkills: [SkillP]
    let skills: [SkillP]
    let shelf: [ShelfItemP]
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

enum Command {
    case setState(state: NotchState, attention: Int, working: Int)
    case showTask(TaskDetail)                  // fronted task (attention/task surface)
    case stageDetail(TaskDetail)               // focused Stage detail (cockpit)
    case setCockpit(CockpitData)
    case termData(id: String, dataB64: String) // PTY output chunk (base64)
    case proposal(ProposalDetail)              // response to suggestionOpen
    case convData(id: String, text: String)    // review-conversation output chunk
    case capturePhase(phase: String, target: String?)
    case pocket(PocketP)                       // what your next words could land on
    case toast(String)                         // transient message (e.g. accept error)
    case notchGeometry(hasNotch: Bool, x: Double, y: Double, w: Double, h: Double)
    /// Surface material preference, from unmute Settings. "system" (default)
    /// honours System Settings → Accessibility → Reduce Transparency; "glass"
    /// and "solid" are explicit user overrides. See SurfaceAppearance.
    case appearance(SurfaceAppearance)
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
    /// Full state of the bottom-centre input surface. Pushed on every change,
    /// including the per-frame level during a capture — one float, which is the
    /// only new traffic the capture path gains.
    case pill(PillState)
    /// The scratchpad: a capture HELD instead of delivered, plus where it can
    /// go. See ScratchpadModel — every field on that payload decodes leniently,
    /// so a partial or older push still draws instead of being dropped.
    case scratchpad(ScratchpadPayload)
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
        case "appearance":
            // An unknown value falls back to `.system` rather than being
            // dropped: a malformed preference must never leave the surface
            // ignoring the user's accessibility setting.
            let raw = obj["value"] as? String ?? "system"
            return .appearance(SurfaceAppearance(rawValue: raw) ?? .system)
        case "surfaceFill":
            // A missing or malformed value means the default, not a dropped
            // command — same rule as `appearance` above. AppController clamps
            // it again before anything is resized.
            return .surfaceFill(CGFloat(obj["fill"] as? Double ?? 0.8))
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
    case focusTask(id: String)                     // card clicked → voice address
    case showAll(group: String?, on: Bool)         // reveal folded cards (nil = whole wall)
    case closeStage                                // Stage esc → back to wall
    /// The user left Unmute — another app came forward, so an expanded task
    /// goes to the pocket instead of staying in their way.
    case userLeft(reason: String)                  // "blur" | "screenshot"
    case userReturned                              // …and inside the grace window, it re-opens
    case pocketMove(delta: Int)                    // carousel: which address
    case pocketOpen                                // tap it open (sticky = an explicit aim)
    case pocketRelease                             // let go — back to the notch
    case chooseOption(id: String, index: Int)
    case answerText(id: String, text: String)      // free-text / confirm answer
    case mute(id: String)                          // drop from attention/crank this episode
    case kill(id: String)
    case resume(id: String)
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
        case .focusTask(let id): return ["type": "focusTask", "id": id]
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
        case .chooseOption(let id, let index): return ["type": "chooseOption", "id": id, "index": index]
        case .answerText(let id, let text): return ["type": "answerText", "id": id, "text": text]
        case .mute(let id): return ["type": "mute", "id": id]
        case .kill(let id): return ["type": "kill", "id": id]
        case .resume(let id): return ["type": "resume", "id": id]
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
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { // EOF — parent gone; exit cleanly
                    DispatchQueue.main.async { onCommand(.quit) }
                    return
                }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<nl)
                    buffer.removeSubrange(buffer.startIndex...nl)
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
