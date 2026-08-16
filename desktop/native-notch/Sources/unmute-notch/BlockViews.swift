import SwiftUI
import AppKit
import ConversationSupport

// THE CHAT VIEW, drawn from blocks.
//
// Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md
//
// One view per block kind, and a fallback for kinds this build does not know.
// Every provider maps its own source into this vocabulary, so Codex CLI, Codex
// Desktop and Claude Code all render here — each showing exactly what its own
// source can support and nothing invented.
//
// Measured against the apps these mirror: your message is a right-aligned
// bubble; the whole tool run collapses to one line once the turn ends; the
// answer is left-aligned full-width markdown with no label and no avatar.

// MARK: - the turn

struct BlockTurnView: View {
    let turn: BlockTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let prompt = turn.prompt, let text = prompt.text {
                BlockUserBubble(text: text)
            }
            // THE PLAN IS NOT A STEP. It is what the turn intends, so it sits
            // above the work rather than inside it.
            if let plan = turn.work.last(where: { $0.kind == "plan" }) {
                PlanCard(block: plan)
            }
            if !workSteps.isEmpty {
                WorkGroup(turn: turn)
            }
            // THESE SURFACE OUT OF THE GROUP, all for the same reason: they are
            // consequences, not steps. What a turn did to your files, what it
            // refused to do, and what broke are the things you must see without
            // opening anything.
            ForEach(Array(surfaced.enumerated()), id: \.offset) { _, b in
                switch b.kind {
                case "fileChange": FileChangeRow(block: b)
                case "denied":     NoticeRow(text: "You rejected: \(b.what ?? "a tool call")", tone: .warn)
                case "error":      NoticeRow(text: b.message ?? "Error", tone: .error)
                case "compaction": NoticeRow(text: compactionText(b), tone: .quiet)
                default:           EmptyView()
                }
            }
            if let reply = turn.reply, let text = reply.text {
                BlockAnswer(text: text)
            }
        }
    }

    private static let surfacedKinds: Set<String> = ["fileChange", "denied", "error", "compaction"]
    private var surfaced: [Block] { turn.work.filter { Self.surfacedKinds.contains($0.kind) } }
    private var workSteps: [Block] {
        turn.work.filter { !Self.surfacedKinds.contains($0.kind) && $0.kind != "plan"
            && $0.kind != "turnStart" && $0.kind != "turnEnd" }
    }

    private func compactionText(_ b: Block) -> String {
        if let before = b.before, let after = b.after {
            return "Context compacted · \(before / 1000)k → \(after / 1000)k"
        }
        return "Context compacted"
    }
}

/// A consequence the user must see without opening anything.
private struct NoticeRow: View {
    enum Tone { case warn, error, quiet }
    let text: String
    let tone: Tone

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(border, lineWidth: 0.5))
    }

    private var color: Color {
        switch tone {
        case .warn:  return Theme.cNeeds
        case .error: return Theme.cError
        case .quiet: return Theme.textFaint
        }
    }
    private var border: Color {
        switch tone {
        case .warn:  return Theme.cNeeds.opacity(0.3)
        case .error: return Theme.cError.opacity(0.3)
        case .quiet: return Theme.hairline
        }
    }
}

/// What the turn intends, and how far along it is.
private struct PlanCard: View {
    let block: Block

    var body: some View {
        let steps = block.steps ?? []
        let done = steps.filter { $0.status == "done" }.count
        VStack(alignment: .leading, spacing: 6) {
            Text("PLAN · \(done) OF \(steps.count)")
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .tracking(0.8)
            ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
                HStack(alignment: .top, spacing: 8) {
                    Text(s.status == "done" ? "✓" : s.status == "active" ? "▸" : "·")
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(Theme.textFaint)
                        .frame(width: 10, alignment: .leading)
                    Text(s.text)
                        .font(.system(size: 12.5))
                        .foregroundColor(s.status == "active" ? Theme.text : Theme.textDim)
                        .strikethrough(s.status == "done", color: Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 0.5))
    }
}

// MARK: - work group

private struct WorkGroup: View {
    let turn: BlockTurn
    @State private var open: Bool?
    /// Drives the running clock. One tick a second, and ONLY while the turn is
    /// live — a wall of settled turns must not each hold a timer.
    @State private var now = Date()
    private static let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// OPEN WHILE IT RUNS, SHUT ONCE IT IS DONE — unless you have said
    /// otherwise. While a turn is working the steps ARE the content; once the
    /// answer arrives they are provenance, and Codex collapses them for the
    /// same reason. `open` stays nil until the user touches it, so their choice
    /// survives the turn finishing under them.
    private var isOpen: Bool { open ?? turn.meta.isRunning }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) { open = !isOpen }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(Theme.textFaint)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(headline)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textDim)
                    if turn.meta.isRunning { RunningDot() }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(headline)

            // THE COUNTS BELONG TO THIS TURN and are shown whether the group is
            // open or shut, so a collapsed running turn still reports itself.
            if let summary = turn.meta.summary {
                Text(summary)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
                    .padding(.leading, 15)
                    .padding(.top, 3)
            }

            if isOpen {
                // BOUNDED AND SCROLLED IN PLACE. Expanding used to insert every
                // step into the page, so the panel reflowed under the cursor and
                // a forty-step turn pushed the answer off screen. Codex opens a
                // scroll area of a fixed size and the surrounding layout does
                // not move; this does the same.
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(runs) { run in
                            WorkRunView(run: run)
                        }
                        if !turn.sources.isEmpty { SourcesSection(sources: turn.sources) }
                    }
                    .padding(.trailing, 6)
                }
                .frame(maxHeight: expandedHeight)
                .padding(.top, 8)
                .padding(.leading, 15)
            }
        }
        .onReceive(Self.tick) { t in
            guard turn.meta.isRunning else { return }
            now = t
        }
    }

    /// Consequences and the plan are drawn outside the group — see the turn
    /// view — so they are not repeated inside it.
    private static let outside: Set<String> = ["fileChange", "denied", "error", "compaction", "plan"]
    private var runs: [WorkRun] {
        WorkRun.runs(of: turn.work.filter { !Self.outside.contains($0.kind) }, id: turn.id)
    }

    /// Tall enough to read a run without scrolling, short enough that the answer
    /// below stays in view. A short turn shrinks to fit rather than padding out.
    private var expandedHeight: CGFloat {
        let rows = runs.reduce(0) { $0 + 1 + $1.steps.count }
        return min(340, max(90, CGFloat(rows) * 34))
    }

    private var headline: String {
        // WHILE IT RUNS, COUNT. The old header summed step durations and said
        // "Worked for 44s" — past tense, and forty minutes short of the truth on
        // a thinking-heavy turn. Codex counts elapsed wall time and says so.
        if turn.meta.isRunning {
            guard let started = turn.meta.startedAt, started > 0 else { return "Working" }
            let elapsed = Int(now.timeIntervalSince1970 * 1000) - started
            return elapsed > 0 ? "Working for \(formatDuration(elapsed))" : "Working"
        }
        if let ms = turn.meta.durationMs, ms > 0 { return "Worked for \(formatDuration(ms))" }
        return "Worked"
    }
}

/// One stretch of work: what the model said, then what it did.
private struct WorkRunView: View {
    let run: WorkRun
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let note = run.note {
                // NARRATION IS MARKDOWN. Codex writes **bold headings** into it,
                // and rendering it as plain text put the asterisks on screen.
                MarkdownText(text: note, size: 12.5, color: Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !run.steps.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.14)) { open.toggle() } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 7.5, weight: .semibold))
                            .foregroundColor(Theme.textFaint)
                            .rotationEffect(.degrees(open ? 90 : 0))
                        Text(run.summary)
                            .font(.system(size: 11.5))
                            .foregroundColor(Theme.textFaint)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if open {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(run.steps.enumerated()), id: \.offset) { _, b in
                            CallRow(block: b)
                        }
                    }
                    .padding(.leading, 13)
                }
            }
        }
        .padding(.vertical, 5)
    }
}

private func formatDuration(_ ms: Int) -> String {
    if ms < 1000 { return "\(ms)ms" }
    let s = ms / 1000
    if s < 60 { return String(format: "%.1fs", Double(ms) / 1000) }
    return "\(s / 60)m \(String(format: "%02d", s % 60))s"
}

private struct RunningDot: View {
    @State private var on = false
    var body: some View {
        Circle()
            .fill(Theme.cNeeds)
            .frame(width: 5, height: 5)
            .opacity(on ? 1 : 0.25)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { on = true }
            }
            // Respect the system setting rather than animating regardless.
            .accessibilityHidden(true)
    }
}

// MARK: - LEVEL 3, one call

/// ONE CALL, NAMED AS A SENTENCE, with its payload one more click away.
///
/// Codex shows `Start session ›` and nothing else until you ask. The raw
/// identifier, the command line and the output all live at level 4. Printing
/// them inline is what made a forty-step turn unreadable and pushed the answer
/// off the screen.
private struct CallRow: View {
    let block: Block
    @State private var open = false

    private var hasDetail: Bool {
        detailBlocks.isEmpty == false
    }

    var body: some View {
        // Rows with nothing underneath are not buttons — a disclosure that
        // opens onto nothing is a small lie about there being more.
        VStack(alignment: .leading, spacing: 0) {
            if hasDetail {
                Button { withAnimation(.easeOut(duration: 0.13)) { open.toggle() } } label: { head }
                    .buttonStyle(.plain)
            } else {
                head
            }
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(detailBlocks.enumerated()), id: \.offset) { _, d in
                        OutputBox(tag: d.tag, text: d.text)
                    }
                }
                .padding(.leading, 22)
                .padding(.top, 5)
                .padding(.bottom, 7)
            }
        }
    }

    private var head: some View {
        HStack(spacing: 8) {
            if hasDetail {
                Image(systemName: "chevron.right")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundColor(Theme.textFaint)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 8)
            } else {
                Spacer().frame(width: 8)
            }
            Text(glyph)
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .frame(width: 13)
            Text(WorkRun.callTitle(block))
                .font(.system(size: 12.5))
                .foregroundColor(block.status == "failed" ? Theme.cError : Theme.textDim)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var trailing: String? {
        if let ms = block.durationMs { return formatDuration(ms) }
        if let n = block.lines { return "\(n) lines" }
        if block.kind == "subAgent" { return block.status }
        if block.kind == "search" { return (block.results?.count).map { "\($0) results" } }
        return nil
    }

    /// Level 4. Each payload gets its own labelled, scrollable box — the label
    /// is what Codex uses to tell plaintext from json at a glance.
    private var detailBlocks: [(tag: String, text: String)] {
        var out: [(String, String)] = []
        switch block.kind {
        case "command":
            if let c = block.command, !c.isEmpty { out.append(("command", c)) }
            if let o = block.output, !o.isEmpty { out.append((block.status == "failed" ? "stderr" : "stdout", o)) }
        case "mcpCall":
            let id = [block.server, block.tool].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !id.isEmpty { out.append(("tool", id)) }
            if let a = block.args, a != "{}", !a.isEmpty { out.append((looksJSON(a) ? "json" : "arguments", a)) }
        case "fileRead":
            if let p = block.path, !p.isEmpty { out.append(("path", p)) }
        case "search":
            if let q = block.query, !q.isEmpty { out.append(("query", q)) }
        case "unknown":
            if let r = block.raw, !r.isEmpty { out.append(("raw", r)) }
        default:
            break
        }
        return out.map { (tag: $0.0, text: $0.1) }
    }

    private func looksJSON(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.hasPrefix("{") || t.hasPrefix("[")
    }

    private var glyph: String {
        switch block.kind {
        case "command":    return "›_"
        case "mcpCall":    return "⌘"
        case "fileRead":   return "◇"
        case "search":     return "⌕"
        case "subAgent":   return "⑂"
        case "fileChange": return "±"
        default:           return "·"
        }
    }
}

// MARK: - LEVEL 4, a payload

/// Labelled by type, bounded, and scrolled in its own box — never spilling into
/// the conversation around it.
private struct OutputBox: View {
    let tag: String
    let text: String
    /// Code is allowed past the prose column — see the note in
    /// BlockConversation. A terminal line wants the room a paragraph must not
    /// take.
    @Environment(\.codeMeasure) private var codeMeasure

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(tag)
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.02))
                .overlay(Rectangle().fill(Theme.hairline).frame(height: 0.5), alignment: .bottom)
            ScrollView {
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Theme.textDim)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 11).padding(.vertical, 8)
            }
            .frame(maxHeight: 170)
        }
        .frame(maxWidth: codeMeasure, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

// MARK: - sources

/// EVIDENCE FOR THE WORK, NOT MESSAGES IN THE CONVERSATION — so they live
/// inside the work group rather than as rows in the chat.
private struct SourcesSection: View {
    let sources: [BlockSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("SOURCES · \(sources.count)")
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .tracking(0.8)
            ForEach(Array(sources.enumerated()), id: \.offset) { _, s in
                Button { open(s.url) } label: {
                    HStack(spacing: 8) {
                        Text(s.monogram)
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundColor(.black)
                            .frame(width: 17, height: 17)
                            .background(RoundedRectangle(cornerRadius: 4)
                                .fill(Color(hue: s.hue, saturation: 0.52, brightness: 0.72)))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.title)
                                .font(.system(size: 11.5))
                                .foregroundColor(Theme.text)
                                .lineLimit(1)
                            Text(s.shortDomain)
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundColor(Theme.textFaint)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(Theme.textFaint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(s.url)
            }
        }
        .padding(.top, 10)
    }

    /// Opens in the user's default browser. The notch is not a web view and
    /// must not become one.
    private func open(_ url: String) {
        guard let u = URL(string: url), u.scheme == "https" || u.scheme == "http" else { return }
        NSWorkspace.shared.open(u)
    }
}

// MARK: - file change

private struct FileChangeRow: View {
    let block: Block

    var body: some View {
        HStack(spacing: 9) {
            Text(block.verb ?? "Edited")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(Theme.textDim)
            Text(shortPath(block.path ?? ""))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Theme.text)
                .lineLimit(1)
                .truncationMode(.head)
                .help(block.path ?? "")
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                Text("+\(block.added ?? 0)")
                    .foregroundColor(Theme.cWorking)
                Text("−\(block.removed ?? 0)")
                    .foregroundColor(Theme.cError)
            }
            .font(.system(size: 11, design: .monospaced))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 0.5))
    }
}

/// Paths are long and the interesting end is the right one — truncation happens
/// at the head, and the last two components always survive.
private func shortPath(_ path: String) -> String {
    let parts = path.split(separator: "/")
    guard parts.count > 2 else { return path }
    return parts.suffix(2).joined(separator: "/")
}

// MARK: - message

private struct BlockUserBubble: View {
    let text: String
    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 40)
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                // A bubble that grows to a 1,100pt panel stops reading as a
                // bubble; it reads as another paragraph.
                .frame(maxWidth: 520, alignment: .trailing)
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 0.5))
                .textSelection(.enabled)
        }
    }
}

private struct BlockAnswer: View {
    let text: String
    var body: some View {
        MarkdownText(text: text, size: 13.5, color: Theme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }
}
