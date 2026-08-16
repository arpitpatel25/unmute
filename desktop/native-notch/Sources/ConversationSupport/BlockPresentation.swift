import Foundation

// TURNS, NOT ROWS.
//
// A conversation is a sequence of turns: you asked, it worked, it answered.
// Everything between two messages is ONE work group, and that group owns its
// own counts.
//
// COUNTS ARE PER TURN, NEVER PER PANEL. The first design pinned a progress strip
// under the panel header. It was wrong twice: it described a single turn while
// floating above all of them, and once you scrolled up it reported something
// off-screen. In a three-turn thread "4 steps" does not say which turn. Here
// each group carries its own, so turn one still reads "Worked for 8s · 2 steps"
// a week later while turn three is still running.

public struct BlockTurnMeta: Equatable, Sendable {
    /// "running" | "done" | "failed"
    public let status: String
    public let durationMs: Int?
    /// Epoch ms the turn began. The header counts from this while running,
    /// rather than summing step times — those only cover the seconds spent in
    /// subprocesses, so a turn that thought for four minutes and ran commands
    /// for forty seconds reported "44s" while Codex's own window said "4m 19s".
    public let startedAt: Int?
    public let steps: Int
    public let files: Int
    public let added: Int
    public let removed: Int
    public let planDone: Int?
    public let planTotal: Int?

    public var isRunning: Bool { status == "running" }

    /// The one-line summary under a work group's head. Nil when there is
    /// nothing worth saying — an empty line is worse than no line.
    public var summary: String? {
        var parts: [String] = []
        if steps > 0 { parts.append(steps == 1 ? "1 step" : "\(steps) steps") }
        if files > 0 {
            let f = files == 1 ? "1 file" : "\(files) files"
            parts.append("\(f) +\(added) −\(removed)")
        }
        if let done = planDone, let total = planTotal, total > 0 { parts.append("\(done) of \(total)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public struct BlockTurn: Identifiable, Equatable, Sendable {
    public let id: String
    public let prompt: Block?
    public let work: [Block]
    public let reply: Block?
    public let meta: BlockTurnMeta
    /// Every source cited by the work in this turn, deduplicated by URL.
    /// Rendered as a section INSIDE the work group — sources are evidence for
    /// the work, not messages in the conversation.
    public let sources: [BlockSource]
}

public enum BlockPresentation {
    public static func build(_ blocks: [Block]) -> [BlockTurn] {
        var turns: [BlockTurn] = []
        var prompt: Block?
        var work: [Block] = []
        var index = 0

        func close(_ reply: Block?) {
            // Do not manufacture an empty turn out of nothing.
            if prompt == nil && reply == nil && work.isEmpty { return }
            turns.append(BlockTurn(
                id: "turn-\(index)",
                prompt: prompt,
                work: work,
                reply: reply,
                meta: meta(of: work),
                sources: sources(of: work)
            ))
            index += 1
            prompt = nil
            work = []
        }

        for block in blocks {
            if block.isUser {
                // A NEW QUESTION ENDS WHATEVER CAME BEFORE, answered or not. An
                // unanswered turn is a real state — interrupted, or still
                // thinking when you typed again — and it must keep its own work
                // rather than donate it to the next turn.
                close(nil)
                prompt = block
            } else if block.isAssistant {
                close(block)
            } else {
                work.append(block)
            }
        }
        close(nil)
        return turns
    }

    static func meta(of work: [Block]) -> BlockTurnMeta {
        var steps = 0, files = 0, added = 0, removed = 0
        var running = false, failed = false
        var planDone: Int?, planTotal: Int?
        var startedAt: Int?
        var durationMs: Int?

        for b in work {
            // The clock markers bound the turn; they are not steps the user did.
            if b.kind == "turnStart" { startedAt = b.startedAt; continue }
            if b.kind == "turnEnd" { durationMs = b.durationMs; continue }
            steps += 1
            switch b.kind {
            case "fileChange":
                files += 1
                added += b.added ?? 0
                removed += b.removed ?? 0
            case "command", "subAgent":
                if b.status == "running" { running = true }
                if b.status == "failed" { failed = true }
            case "reasoning":
                if b.streaming == true { running = true }
            case "error":
                failed = true
            case "plan":
                // NEWEST WINS. A plan is republished in full on every update, so
                // summing them would count the same step several times.
                if let steps = b.steps {
                    planTotal = steps.count
                    planDone = steps.filter { $0.status == "done" }.count
                }
            default:
                break
            }
        }

        // Running beats failed: a turn that hit an error and carried on is still
        // working, and settling it would stop a card that is still moving.
        // A turn with a start and no end is still going, whatever its steps say
        // — the last command can have finished while the model keeps thinking.
        if startedAt != nil && durationMs == nil { running = true }
        let status = running ? "running" : (failed ? "failed" : "done")
        return BlockTurnMeta(status: status, durationMs: durationMs, startedAt: startedAt,
                             steps: steps, files: files, added: added, removed: removed,
                             planDone: planDone, planTotal: planTotal)
    }

    static func sources(of work: [Block]) -> [BlockSource] {
        var seen = Set<String>()
        var out: [BlockSource] = []
        for b in work where b.kind == "search" {
            for s in b.results ?? [] where !seen.contains(s.url) {
                seen.insert(s.url)
                out.append(s)
            }
        }
        return out
    }
}

// MARK: - runs

/// A RUN OF WORK, SUMMARISED THE WAY CODEX SUMMARISES IT.
///
/// Codex does not list twenty steps. It shows one line per stretch of work —
/// "Loaded a tool, read files", "Used Unmute Computer integration, read files,
/// ran a command" — with its narration in between, and the steps themselves one
/// click away. A flat list of `exec · 200ms` twenty times over is the transport,
/// not the story.
///
/// A run ends where narration begins: the model saying something is the natural
/// boundary between one stretch of work and the next.
public struct WorkRun: Identifiable, Equatable, Sendable {
    public let id: String
    /// The narration that introduced this run, if any.
    public let note: String?
    public let steps: [Block]

    /// "Read files, ran 2 commands" — what happened, in the order it reads
    /// best, counted rather than listed.
    public var summary: String {
        var parts: [String] = []
        let n = { (kind: String) in self.steps.filter { $0.kind == kind }.count }

        let mcp = steps.filter { $0.kind == "mcpCall" }
        if !mcp.isEmpty {
            let servers = Set(mcp.compactMap { $0.server }.filter { !$0.isEmpty })
            parts.append(servers.count == 1
                ? "Used \(servers.first!)"
                : "Used \(servers.count) integrations")
        }
        let reads = n("fileRead")
        if reads > 0 { parts.append(reads == 1 ? "read a file" : "read \(reads) files") }
        let cmds = n("command")
        if cmds > 0 { parts.append(cmds == 1 ? "ran a command" : "ran \(cmds) commands") }
        let searches = n("search")
        if searches > 0 { parts.append(searches == 1 ? "searched the web" : "made \(searches) searches") }
        let subs = n("subAgent")
        if subs > 0 { parts.append(subs == 1 ? "ran a sub-agent" : "ran \(subs) sub-agents") }

        if parts.isEmpty { return steps.count == 1 ? "1 step" : "\(steps.count) steps" }
        // Sentence case: the first fragment leads.
        let first = parts[0]
        let rest = parts.dropFirst()
        return rest.isEmpty ? first : "\(first), \(rest.joined(separator: ", "))"
    }
}

public extension WorkRun {
    /// Cut a turn's work into runs at each piece of narration.
    static func runs(of work: [Block], id: String = "turn") -> [WorkRun] {
        var out: [WorkRun] = []
        var note: String?
        var steps: [Block] = []

        func flush(_ index: Int) {
            if note == nil && steps.isEmpty { return }
            out.append(WorkRun(id: "\(id)-run-\(index)", note: note, steps: steps))
            note = nil
            steps = []
        }

        for (i, b) in work.enumerated() {
            if b.kind == "turnStart" || b.kind == "turnEnd" { continue }
            if b.kind == "reasoning" {
                // Narration starts a new run rather than joining the last one,
                // so the text sits above the work it describes.
                flush(i)
                note = b.text
                continue
            }
            steps.append(b)
        }
        flush(work.count)
        return out
    }
}

public extension BlockSource {
    /// No logo field exists on any search result — measured across 1,988 of
    /// them. Deriving a letter from the domain beats fetching a favicon, which
    /// would hand the user's browsing to a third-party icon host from inside
    /// the notch.
    var monogram: String {
        let host = domain.hasPrefix("www.") ? String(domain.dropFirst(4)) : domain
        return String(host.prefix(1)).uppercased()
    }

    var shortDomain: String {
        domain.hasPrefix("www.") ? String(domain.dropFirst(4)) : domain
    }

    /// A stable hue per domain, so the same source keeps the same colour
    /// wherever it appears.
    var hue: Double {
        var h = 0
        for ch in shortDomain.unicodeScalars { h = (h &* 31 &+ Int(ch.value)) % 360 }
        return Double(h) / 360.0
    }
}
