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

/// The conversation's content width, published upward by a canvas so the card
/// can re-lay its drawing out when the panel is resized. A preference rather
/// than a GeometryReader wrapper, so measuring costs no layout.
struct CanvasWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if next > 0 { value = next }
    }
}

struct BlockTurnView: View {
    let turn: BlockTurn
    let taskId: String
    var canEdit: Bool = false
    @State private var canvasWidth: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let prompt = turn.prompt, let text = prompt.text {
                VStack(alignment: .trailing, spacing: 5) {
                    BlockUserBubble(text: text)
                    MessageActions(text: text, at: prompt.at, taskId: taskId, canEdit: canEdit)
                }
            }
            // ATTACHMENTS ARE A ROW, NOT A COLUMN.
            //
            // Each tile used to be its own full-width line, so six screenshots
            // sent in one message pushed the entire conversation off screen and
            // the transcript became a list of filenames. They belong to ONE
            // message and read as one thing: a single row beside it, scrolling
            // sideways when there are more than fit, so the cost of attaching
            // ten is the same as attaching one.
            //
            // maxWidth on the inner row is what keeps a short row pinned right
            // with the bubble it belongs to; without it a lone tile drifts to
            // the left edge, away from its own message.
            // YOURS ONLY. A file the agent fetched is not part of your prompt
            // and must not sit above the reply — it goes at the bottom with the
            // drawings, so the written answer stays whole for anyone listening.
            let attachments = turn.work.filter { $0.kind == "attachment" && $0.role != "assistant" }
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                            if let path = attachment.path, !path.isEmpty {
                                ComposerAttachmentTile(attachment: DraftAttachmentP(id: attachment.id, path: path,
                                    mimeType: attachment.mimeType ?? "application/octet-stream",
                                    name: attachment.name ?? URL(fileURLWithPath: path).lastPathComponent),
                                    remove: {}, restore: {}, readOnly: true, knownBytes: attachment.bytes)
                                    .frame(maxWidth: 168)
                            } else {
                                NoticeRow(text: "Attachment unavailable: \(attachment.name ?? "File")", tone: .warn)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            // THE PLAN IS NOT A STEP. It is what the turn intends, so it sits
            // above the work rather than inside it.
            if let plan = turn.work.last(where: { $0.kind == "plan" }) {
                PlanCard(block: plan)
            }
            if !workSteps.isEmpty {
                WorkGroup(turn: turn, taskId: taskId)
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
                case "sessionBoundary": NoticeRow(text: b.text ?? "New conversation", tone: .quiet)
                // Said about the answer, not by it — e.g. that it came from a
                // fallback model because the chosen one was unavailable.
                case "notice":     NoticeRow(text: b.text ?? "", tone: .quiet)
                default:           EmptyView()
                }
            }
            if let reply = turn.reply, let text = reply.text {
                VStack(alignment: .leading, spacing: 7) {
                    BlockAnswer(text: text)
                    MessageActions(text: text, at: reply.at)
                }
            }
            // THE DRAWING GOES LAST, AFTER EVERY WORD OF THE TURN.
            //
            // Not where the model happened to write it. Two reasons, and the
            // second is the one that matters: a picture between two paragraphs
            // breaks the reading, and the person who asked may have DICTATED
            // the question and be listening rather than looking — so the spoken
            // answer has to be whole before anything visual arrives. canvas.ts
            // already hoists these to the end of the turn; this is where that
            // promise is kept on screen.
            //
            // THE WIDTH IS MEASURED, NOT OWNED. A bare GeometryReader would
            // take all the space offered and reserve the card's maximum height
            // forever, punching a hole under every drawing; reading the width
            // from a clear background leaves the card free to size itself to
            // its own content. The panel is resizable, so this has to track —
            // a drawing re-lays out on a drag rather than scaling a stale
            // bitmap.
            ForEach(Array(canvases.enumerated()), id: \.offset) { _, canvas in
                CanvasCard(block: canvas, width: canvasWidth)
                    .background(GeometryReader { geo in
                        Color.clear.preference(key: CanvasWidthKey.self, value: geo.size.width)
                    })
            }
            // A PICTURE THE AGENT FETCHED, in the tile that already knows how to
            // draw one. Wider than the composer's tray tile because this is the
            // answer rather than a thing you attached — but capped, so a tall
            // photograph cannot push the reply off screen.
            ForEach(Array(fetchedImages.enumerated()), id: \.offset) { _, image in
                if let path = image.path, !path.isEmpty {
                    ComposerAttachmentTile(
                        attachment: DraftAttachmentP(id: image.id, path: path,
                            mimeType: image.mimeType ?? "image/png",
                            name: image.name ?? URL(fileURLWithPath: path).lastPathComponent),
                        remove: {}, restore: {}, readOnly: true, knownBytes: image.bytes)
                }
            }
        }
        .onPreferenceChange(CanvasWidthKey.self) { width in
            if abs(width - canvasWidth) > 1 { canvasWidth = width }
        }
    }

    /// Drawings this turn produced. Kept out of `workSteps` so a canvas never
    /// appears twice — once as a step and once as itself.
    private var canvases: [Block] { turn.work.filter { $0.kind == "canvas" } }
    /// Pictures the agent went and found, as opposed to files you attached.
    private var fetchedImages: [Block] {
        turn.work.filter { $0.kind == "attachment" && $0.role == "assistant" }
    }

    private static let surfacedKinds: Set<String> = ["fileChange", "denied", "error", "compaction", "sessionBoundary", "notice"]
    private var surfaced: [Block] { turn.work.filter { Self.surfacedKinds.contains($0.kind) } }
    private var workSteps: [Block] {
        turn.work.filter { !Self.surfacedKinds.contains($0.kind) && $0.kind != "plan"
            && $0.kind != "turnStart" && $0.kind != "turnEnd" && $0.kind != "attachment"
            && $0.kind != "canvas" }
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
    let taskId: String
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
                withAnimation(.easeOut(duration: 0.16)) {
                    open = !isOpen
                    DisclosureStateMemory.shared.remember(task: taskId, key: disclosureKey, open: open!)
                }
            } label: {
                // Codex, measured: 14pt / 21, white at 60%, 4pt gap, and the
                // chevron AFTER the text rather than before it.
                HStack(spacing: 4) {
                    Text(headline)
                        .font(.system(size: 14))
                        .foregroundColor(Theme.text.opacity(0.6))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.text.opacity(0.45))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
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
                    .font(.system(size: 11.5))
                    .foregroundColor(Theme.text.opacity(0.4))
                    .padding(.top, 2)
            }
            // The rule Codex draws under the work header, separating what it
            // did from what it said.
            Rectangle().fill(Theme.hairline).frame(height: 0.5).padding(.top, 9)

            if isOpen {
                // BOUNDED AND SCROLLED IN PLACE. Expanding used to insert every
                // step into the page, so the panel reflowed under the cursor and
                // a forty-step turn pushed the answer off screen. Codex opens a
                // scroll area of a fixed size and the surrounding layout does
                // not move; this does the same.
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(runs) { run in
                            WorkRunView(run: run, taskId: taskId)
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
        .onAppear { open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) }
        .onChange(of: taskId) { _ in open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) }
    }

    /// Consequences and the plan are drawn outside the group — see the turn
    /// view — so they are not repeated inside it.
    private static let outside: Set<String> = ["fileChange", "denied", "error", "compaction", "sessionBoundary", "notice", "plan", "attachment"]
    private var runs: [WorkRun] {
        WorkRun.runs(of: turn.work.filter { !Self.outside.contains($0.kind) }, id: turn.id)
    }
    private var disclosureKey: String { "work:\(turn.id)" }

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
        if turn.meta.status == "cancelled" { return "Cancelled" }
        if turn.meta.status == "failed" { return "Failed" }
        if turn.meta.status == "denied" { return "Denied" }
        if let ms = turn.meta.durationMs, ms > 0 { return "Worked for \(formatDuration(ms))" }
        return "Worked"
    }
}

/// One stretch of work: what the model said, then what it did.
private struct WorkRunView: View {
    let run: WorkRun
    let taskId: String
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let note = run.note {
                // NARRATION IS MARKDOWN, and Codex writes **bold headings**
                // into it — which showed their asterisks under the inline-only
                // renderer this replaces.
                RichText(text: note, size: 14, color: Theme.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !run.steps.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.14)) {
                    open.toggle(); DisclosureStateMemory.shared.remember(task: taskId, key: disclosureKey, open: open)
                } } label: {
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
                        ForEach(Array(run.steps.enumerated()), id: \.offset) { index, b in
                            CallRow(block: b, taskId: taskId, disclosureKey: "call:\(run.id):\(index):\(b.id)")
                        }
                    }
                    .padding(.leading, 13)
                }
            }
        }
        .padding(.vertical, 5)
        .onAppear { open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) ?? false }
        .onChange(of: taskId) { _ in open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) ?? false }
    }
    private var disclosureKey: String { "run:\(run.id)" }
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

// MARK: - Waiting for the first word back

/// One dot of the typing indicator. `delay` staggers it against its siblings,
/// which is what makes three dots read as a wave rather than a blink.
private struct TypingDot: View {
    let delay: Double
    /// The view-level answer, per the note on Theme.resize: SwiftUI tracks the
    /// preference here and re-renders when it flips.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    var body: some View {
        Circle()
            .fill(Theme.textDim)
            .frame(width: 5, height: 5)
            // REDUCE MOTION KEEPS THE DOTS, LOSES THE WAVE. The indicator is
            // the only thing on screen saying the message was received, so
            // suppressing it entirely would hand that person back the silence
            // this exists to remove. A static mid-opacity row still reads as
            // "pending" — it just does not move.
            .opacity(reduceMotion ? 0.55 : (up ? 1 : 0.28))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(delay)) {
                    up = true
                }
            }
    }
}

/// Three dots, shown under the newest message from the moment it is sent until
/// the turn produces anything of its own.
///
/// WHY THIS EXISTS. The transcript had no tail: `ChatStatusView` carries
/// "Working…" but is mounted OUTSIDE the transcript (see its own header), and
/// the only in-transcript status hung off the JumpToLatest pill as
/// `meta.summary` — which is nil until a turn has at least one step or one
/// changed file. So between sending and the first work block there was nothing
/// under your message at all, and no way to tell a received message from a
/// dropped one.
///
/// DELIBERATELY NOT A BUBBLE. Answers in this view are plain leading-aligned
/// text (BlockAnswer), not chrome, so a bubble here would announce a shape the
/// agent never uses. A low-contrast pill is enough to mark the spot the reply
/// is about to occupy.
struct TypingIndicator: View {
    var body: some View {
        HStack(spacing: 5) {
            TypingDot(delay: 0)
            TypingDot(delay: 0.18)
            TypingDot(delay: 0.36)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.raised))
        // One element with one label: three separately-announced dots is noise
        // to anyone listening, and the row means a single thing.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Waiting for a reply")
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
    let taskId: String
    let disclosureKey: String
    @State private var open = false

    private var hasDetail: Bool {
        detailBlocks.isEmpty == false
    }

    var body: some View {
        // Rows with nothing underneath are not buttons — a disclosure that
        // opens onto nothing is a small lie about there being more.
        VStack(alignment: .leading, spacing: 0) {
            if hasDetail {
                Button { withAnimation(.easeOut(duration: 0.13)) {
                    open.toggle(); DisclosureStateMemory.shared.remember(task: taskId, key: disclosureKey, open: open)
                } } label: { head }
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
        .onAppear { open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) ?? false }
        .onChange(of: taskId) { _ in open = DisclosureStateMemory.shared.value(task: taskId, key: disclosureKey) ?? false }
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
        if let status = block.status { return status == "ok" || status == "done" ? "succeeded" : status }
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
            if let cwd = block.cwd { out.append(("working directory", cwd)) }
            if let o = block.output, !o.isEmpty { out.append((block.status == "failed" ? "stderr" : "stdout", o)) }
        case "mcpCall":
            let id = [block.server, block.tool].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !id.isEmpty { out.append(("tool", id)) }
            if let a = block.args, a != "{}", !a.isEmpty { out.append((looksJSON(a) ? "json" : "arguments", a)) }
            if let output = block.output { out.append(("result", output)) }
            if let error = block.error, error != block.output { out.append(("error", error)) }
        case "fileRead":
            if let p = block.path, !p.isEmpty { out.append(("path", p)) }
        case "subAgent":
            if let output = block.output { out.append(("subagent result", output)) }
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
struct OutputBox: View {
    let tag: String
    let text: String
    /// Code is allowed past the prose column — see the note in
    /// BlockConversation. A terminal line wants the room a paragraph must not
    /// take.
    @Environment(\.codeMeasure) private var codeMeasure

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(tag)
                Spacer()
                Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
                    .buttonStyle(.plain).accessibilityLabel("Copy \(tag)")
            }
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
        AppController.CardLink.clicked()
        NSWorkspace.shared.open(u)
    }
}

// MARK: - file change

private struct FileChangeRow: View {
    let block: Block
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let changes = block.changes {
                ForEach(Array(changes.enumerated()), id: \.offset) { _, change in
                    FileChangeRow(block: Block(kind: "fileChange", status: block.status, path: change.path, verb: change.verb,
                        added: change.added, removed: change.removed, diff: change.diff))
                }
            } else {
                Button { expanded.toggle() } label: { header }.buttonStyle(.plain)
                if expanded {
                    OutputBox(tag: "path", text: block.path ?? "")
                    if let diff = block.diff { OutputBox(tag: "diff", text: diff) }
                    if let status = block.status { Text(status).font(.caption).foregroundColor(Theme.textDim) }
                }
            }
        }
    }
    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
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
    /// See Theme.userBubble: the lift is tone-aware, and a computed colour
    /// changing does not invalidate a view on its own.
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 40)
            // YOUR TEXT IS THE SAME SIZE AS THE AGENT'S. The 16pt I measured
            // off Codex belonged to its composer, not its prompt bubble — set
            // on a reply it read as shouting next to the 14pt answer beneath.
            // Everything else here is measured: radius 20, padding 8×12.
            //
            // THE FILL IS NOT MEASURED ANY MORE. It was a literal white-at-5%,
            // tuned against Space Gray, and 5b0ff42 fixed exactly that value
            // on ConversationPanel's UserBubble without reaching this one — so
            // the surface you get when the terminal is HIDDEN kept the bug the
            // commit was about: on black, white at 5% is rgb(13,13,13) and
            // your own message vanishes into the ground. It now shares the
            // tone-aware token, and takes the matching edge that came with it.
            FoldableUserText(text: text, lineSpacing: 22 - 14 * 1.2)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.userBubble))
                .overlay(RoundedRectangle(cornerRadius: 20)
                    .stroke(Theme.userBubbleEdge, lineWidth: 0.5))
        }
    }
}

private struct BlockAnswer: View {
    let text: String
    var body: some View {
        // Every native conversation surface uses the same cmark-gfm-backed
        // renderer. Keeping a second block parser here caused valid tables to
        // be flattened into literal pipe-delimited paragraphs.
        SelectableMessage(text: text, size: 14, color: Theme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Actions belong to a whole message, including all paragraphs and tables.
private struct MessageActions: View {
    let text: String
    let at: Double?
    var taskId: String = ""
    var canEdit: Bool = false
    @State private var copied = false
    @State private var editing = false
    @State private var replacement = ""
    @State private var submitting = false
    @State private var editError: String?
    var body: some View {
        HStack(spacing: 10) {
            if let at {
                Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.day().month(.abbreviated).hour().minute())
            }
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
            .buttonStyle(.plain).help("Copy message").accessibilityLabel("Copy message")
            if canEdit {
                Button { replacement = text; editError = nil; editing = true } label: { Image(systemName: "pencil") }
                    .buttonStyle(.plain).help("Edit latest message").accessibilityLabel("Edit latest message")
            }
        }.font(.system(size: 10.5)).foregroundColor(Theme.textFaint)
        .popover(isPresented: $editing) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Edit latest message").font(.headline)
                TextEditor(text: $replacement).font(.system(size: 14)).frame(width: 480, height: 180)
                    .disabled(submitting)
                if let editError { Text(editError).foregroundColor(Theme.cError) }
                HStack {
                    Button("Cancel") { editing = false }.disabled(submitting)
                    Spacer()
                    Button(submitting ? "Regenerating…" : "Save and regenerate") {
                        submitting = true; editError = nil
                        IPC.emit(.editLatestMessage(id: taskId, expected: text, text: replacement))
                    }.disabled(submitting || replacement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(18)
        }
        .onReceive(NotificationCenter.default.publisher(for: .init("UnmuteMessageEditStatus"))) { event in
            guard event.userInfo?["id"] as? String == taskId else { return }
            submitting = false
            if event.userInfo?["accepted"] as? Bool == true { editing = false }
            else { editError = event.userInfo?["error"] as? String }
        }
    }
}
