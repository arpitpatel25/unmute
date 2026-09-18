import Foundation

// CHAT VIEW BLOCKS — the Swift side of one open vocabulary.
//
// Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md
//
// Three sources — the Codex app-server, the Codex rollout, and Claude Code's
// transcript — all arrive here as the same block list. Each provider emits only
// the kinds its source can support, and this surface draws a view per kind.
//
// THE OPEN RULE. A kind this build does not recognise decodes to `.unknown` and
// draws as a quiet plain row. It must never be shown as a message. That is not
// defensive politeness: it is what lets the Electron side ship a richer block
// before this binary has learned to draw it, which will happen on every release
// where the two move at different speeds. The failure it replaces was worse
// than blank — the old presenter's `default:` branch turned anything it did not
// recognise into an ANSWER BUBBLE, so an unrecognised row read as the agent
// having said something it never said.

public struct BlockSource: Codable, Equatable, Sendable {
    public let title: String
    public let domain: String
    public let url: String
    public let snippet: String?
}

public struct PlanStep: Codable, Equatable, Sendable {
    public let text: String
    /// "todo" | "active" | "done"
    public let status: String
}

/// One thing the agent did.
///
/// Decoded from a tagged object — `{"kind": "...", ...}` — rather than a Swift
/// enum with associated values, because Swift's synthesised Codable throws on
/// an unknown case and a throw here would empty the whole panel over one row it
/// did not know. Every field is optional and the kind is a String, so an
/// unfamiliar payload costs one degraded row instead of the conversation.
public struct FileChange: Codable, Equatable, Sendable {
    public let path: String
    public let verb: String
    public let added: Int
    public let removed: Int
    public let diff: String?
}

public struct Block: Codable, Equatable, Sendable, Identifiable {
    public let kind: String

    // message
    public let at: Double?
    public let role: String?
    public let text: String?

    // reasoning
    public let streaming: Bool?

    // command
    public let label: String?
    public let command: String?
    public let cwd: String?
    public let exitCode: Int?
    public let output: String?
    public let durationMs: Int?
    /// command: "running" | "ok" | "failed" · subAgent: "running" | "done" | "failed"
    public let status: String?

    // fileChange
    public let path: String?
    public let verb: String?
    public let added: Int?
    public let removed: Int?
    public let diff: String?
    public let changes: [FileChange]?
    // attachment
    public let mimeType: String?
    public let bytes: Int?

    // mcpCall
    public let server: String?
    public let tool: String?
    public let args: String?
    public let ok: Bool?
    public let readOnly: Bool?
    public let error: String?

    // fileRead
    public let lines: Int?

    // search
    public let query: String?
    public let results: [BlockSource]?

    // plan
    public let steps: [PlanStep]?

    // subAgent / denied / error
    public let name: String?
    public let what: String?
    public let reason: String?
    public let message: String?

    // compaction
    public let before: Int?
    public let after: Int?
    public let trigger: String?

    // turnStart / turnEnd — the turn's clock, see BlockTurnMeta.startedAt
    public let startedAt: Int?
    public let outcome: String?

    // canvas — a drawing the agent produced. `format` is "mermaid" | "svg" |
    // "html"; `source` is its text, and it is UNTRUSTED. See CanvasCard.
    public let format: String?
    public let source: String?

    // unknown
    public let raw: String?

    /// Stable within one render pass. Blocks carry no id of their own — the
    /// index is supplied by the presenter, which is the only thing that knows
    /// the position.
    public var id: String { "\(kind)-\(text ?? command ?? path ?? query ?? raw ?? "")" }

    public var isMessage: Bool { kind == "message" }
    public var isUser: Bool { kind == "message" && role == "user" }
    public var isAssistant: Bool { kind == "message" && role == "assistant" }

    public init(kind: String, at: Double? = nil, role: String? = nil, text: String? = nil, streaming: Bool? = nil,
                label: String? = nil, command: String? = nil, cwd: String? = nil, exitCode: Int? = nil,
                output: String? = nil, durationMs: Int? = nil, status: String? = nil,
                path: String? = nil, verb: String? = nil, added: Int? = nil, removed: Int? = nil,
                server: String? = nil, tool: String? = nil, args: String? = nil, ok: Bool? = nil,
                readOnly: Bool? = nil, lines: Int? = nil, query: String? = nil,
                results: [BlockSource]? = nil, steps: [PlanStep]? = nil, name: String? = nil,
                what: String? = nil, reason: String? = nil, message: String? = nil,
                before: Int? = nil, after: Int? = nil, trigger: String? = nil,
                startedAt: Int? = nil, raw: String? = nil, mimeType: String? = nil, bytes: Int? = nil,
                diff: String? = nil, changes: [FileChange]? = nil, error: String? = nil, outcome: String? = nil,
                format: String? = nil, source: String? = nil) {
        self.format = format; self.source = source
        self.diff = diff; self.changes = changes; self.error = error; self.outcome = outcome
        self.mimeType = mimeType; self.bytes = bytes
        self.startedAt = startedAt
        self.at = at
        self.kind = kind; self.role = role; self.text = text; self.streaming = streaming
        self.label = label; self.command = command; self.cwd = cwd; self.exitCode = exitCode
        self.output = output; self.durationMs = durationMs; self.status = status
        self.path = path; self.verb = verb; self.added = added; self.removed = removed
        self.server = server; self.tool = tool; self.args = args; self.ok = ok
        self.readOnly = readOnly; self.lines = lines; self.query = query
        self.results = results; self.steps = steps; self.name = name
        self.what = what; self.reason = reason; self.message = message
        self.before = before; self.after = after; self.trigger = trigger; self.raw = raw
    }
}

/// Which of these kinds this build knows how to draw. A kind outside this set
/// is rendered by the fallback row — see the open rule above.
public enum BlockKind {
    public static let drawable: Set<String> = [
        "message", "reasoning", "command", "fileChange", "mcpCall", "fileRead",
        "search", "plan", "subAgent", "denied", "error", "compaction", "attachment",
        "sessionBoundary", "notice",
    ]
    public static func isDrawable(_ kind: String) -> Bool { drawable.contains(kind) }
}

/// Token usage for the panel footer.
public struct BlockUsage: Codable, Equatable, Sendable {
    public let used: Int
    public let window: Int
    public let rateLimitPercent: Int?
    public let resetsAt: Int?

    public init(used: Int, window: Int, rateLimitPercent: Int? = nil, resetsAt: Int? = nil) {
        self.used = used; self.window = window
        self.rateLimitPercent = rateLimitPercent; self.resetsAt = resetsAt
    }

    /// 0…1, clamped. Zero when the provider did not report a window, which is
    /// honest: an unknown denominator must not draw a full meter.
    public var fraction: Double {
        guard window > 0 else { return 0 }
        return min(1, max(0, Double(used) / Double(window)))
    }
}
