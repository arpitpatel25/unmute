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

        for b in work {
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
        let status = running ? "running" : (failed ? "failed" : "done")
        return BlockTurnMeta(status: status, durationMs: nil, steps: steps, files: files,
                             added: added, removed: removed, planDone: planDone, planTotal: planTotal)
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
