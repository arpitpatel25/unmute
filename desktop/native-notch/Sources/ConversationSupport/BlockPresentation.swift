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
    /// - Parameter running: whether the TASK is still working, which the task
    ///   manager knows for certain and the blocks often cannot say. Claude's
    ///   transcript carries no turn markers, so a turn whose last command had
    ///   finished read as "Worked" while the agent was still thinking. The
    ///   agent's own state settles it.
    public static func build(_ blocks: [Block], running: Bool = false) -> [BlockTurn] {
        var turns = buildTurns(blocks)
        // Only the LAST turn can be the live one; everything above it is history
        // whatever the task is doing now.
        if running, let last = turns.indices.last, turns[last].reply == nil || turns[last].meta.isRunning {
            let m = turns[last].meta
            turns[last] = BlockTurn(
                id: turns[last].id, prompt: turns[last].prompt, work: turns[last].work,
                reply: turns[last].reply,
                meta: BlockTurnMeta(status: "running", durationMs: m.durationMs, startedAt: m.startedAt,
                                    steps: m.steps, files: m.files, added: m.added, removed: m.removed,
                                    planDone: m.planDone, planTotal: m.planTotal),
                sources: turns[last].sources)
        }
        return turns
    }

    /// Clock markers bound a turn; they are not work that came after an answer.
    private static func isBoundary(_ b: Block) -> Bool {
        b.kind == "turnStart" || b.kind == "turnEnd"
    }

    static func buildTurns(_ blocks: [Block]) -> [BlockTurn] {
        var turns: [BlockTurn] = []
        var prompt: Block?
        var body: [Block] = []
        var index = 0

        func close() {
            // Do not manufacture an empty turn out of nothing.
            if prompt == nil && body.isEmpty { return }

            // THE ANSWER IS THE LAST THING SAID, AND ONLY IF NOTHING FOLLOWED.
            //
            // This used to end a turn at EVERY assistant message, which is
            // right for Codex and wrong for Claude Code. Codex emits its
            // commentary as `reasoning` and exactly one message per turn, so
            // one turn produced one work group. Claude narrates as it goes —
            // "I'll set it up now", tool calls, "the files are assembled",
            // more tool calls — and every one of those arrives as a message,
            // so a single question produced five or six separate
            // "Worked for…" toggles instead of the one the user expects.
            //
            // The rule that makes both harnesses agree: a turn ends at the
            // USER. Within it, the last assistant message is the reply — but
            // only when nothing but boundary markers follows it. If the agent
            // spoke and then went back to work, that was not the answer, and
            // promoting it would show a reply for a turn still running.
            var work = body
            var reply: Block?
            if let last = body.lastIndex(where: { $0.isAssistant }),
               body[body.index(after: last)...].allSatisfy(isBoundary) {
                reply = body[last]
                work.remove(at: last)
            }

            // Everything else it said mid-turn is narration ABOUT the work,
            // which is what `reasoning` already means here — WorkRun.runs
            // turns it into the note above the steps it describes, exactly
            // where Codex's commentary lands. Left as messages they would fall
            // through to `steps` and draw as unlabelled rows.
            work = work.map { $0.isAssistant ? Block(kind: "reasoning", text: $0.text) : $0 }

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
            body = []
        }

        for block in blocks {
            if block.isUser {
                // A NEW QUESTION ENDS WHATEVER CAME BEFORE, answered or not. An
                // unanswered turn is a real state — interrupted, or still
                // thinking when you typed again — and it must keep its own work
                // rather than donate it to the next turn.
                if prompt != nil || !body.allSatisfy({ $0.kind == "turnStart" }) { close() }
                prompt = block
            } else {
                body.append(block)
            }
        }
        close()
        return turns
    }

    static func meta(of work: [Block]) -> BlockTurnMeta {
        var steps = 0, files = 0, added = 0, removed = 0
        var running = false, failed = false, cancelled = false, denied = false, ended = false
        var outcome: String?
        var planDone: Int?, planTotal: Int?
        var startedAt: Int?
        var durationMs: Int?

        for b in work {
            if b.kind == "attachment" { continue }
            // The clock markers bound the turn; they are not steps the user did.
            if b.kind == "turnStart" { startedAt = b.startedAt; continue }
            if b.kind == "turnEnd" { durationMs = b.durationMs; outcome = b.outcome; ended = true; continue }
            steps += 1
            switch b.kind {
            case "fileChange":
                if let changes = b.changes {
                    files += changes.count
                    added += changes.reduce(0) { $0 + $1.added }
                    removed += changes.reduce(0) { $0 + $1.removed }
                } else { files += 1; added += b.added ?? 0; removed += b.removed ?? 0 }
            case "command", "subAgent", "mcpCall":
                if b.status == "running" { running = true }
                if b.status == "failed" { failed = true }
                if b.status == "cancelled" { cancelled = true }
                if b.status == "denied" { denied = true }
                if b.kind == "mcpCall" && b.status == nil && b.ok == false { failed = true }
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
        if startedAt != nil && !ended { running = true }
        // The provider's final outcome outranks intermediate tool errors.
        // A failed search/command that the agent recovered from is not a failed turn.
        let status = outcome == "completed" ? "done" : outcome == "cancelled" ? "cancelled" : outcome == "failed" ? "failed" : running && !ended ? "running" : failed ? "failed" : cancelled ? "cancelled" : denied ? "denied" : "done"
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

    /// `unmute-computer` → "Unmute Computer". A server id is what the protocol
    /// calls it; a name is what the sentence needs.
    static func integrationName(_ server: String) -> String {
        server.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// `start_session` → "Start session". Codex titles each call as a sentence;
    /// the raw identifier belongs one level down, beside its output.
    public static func callTitle(_ block: Block) -> String {
        switch block.kind {
        case "mcpCall":
            let tool = block.tool ?? ""
            return tool.isEmpty ? (block.server ?? "Tool call") : humanise(tool)
        case "command":    return block.label ?? "Ran a command"
        case "fileRead":   return "Read"
        case "search":     return "Searched the web"
        case "subAgent":   return block.name ?? "Sub-agent"
        case "fileChange": return block.verb ?? "Changed a file"
        default:           return humanise(block.kind)
        }
    }

    static func humanise(_ name: String) -> String {
        var s = ""
        for ch in name {
            if ch == "_" || ch == "-" { s.append(" ") }
            else if ch.isUppercase && !s.isEmpty && s.last != " " { s.append(" "); s.append(ch) }
            else { s.append(ch) }
        }
        let lower = s.trimmingCharacters(in: .whitespaces).lowercased()
        guard let first = lower.first else { return name }
        return String(first).uppercased() + lower.dropFirst()
    }

    /// "Read files, ran 2 commands" — what happened, in the order it reads
    /// best, counted rather than listed.
    public var summary: String {
        var parts: [String] = []
        let n = { (kind: String) in self.steps.filter { $0.kind == kind }.count }

        // NAME THEM, DO NOT COUNT THEM. Codex writes "Used Unmute Computer and
        // Cua Computer Use integrations"; counting was the safe choice and it
        // reads worse — the names are right there and they are the useful part.
        let mcp = steps.filter { $0.kind == "mcpCall" }
        if !mcp.isEmpty {
            var seen: [String] = []
            for s in mcp.compactMap({ $0.server }) where !s.isEmpty && !seen.contains(s) { seen.append(s) }
            if !seen.isEmpty {
                let names = seen.map(Self.integrationName)
                let joined: String
                switch names.count {
                case 1:  joined = names[0]
                case 2:  joined = "\(names[0]) and \(names[1])"
                default: joined = names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
                }
                parts.append("Used \(joined) integration\(names.count == 1 ? "" : "s")")
            }
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
