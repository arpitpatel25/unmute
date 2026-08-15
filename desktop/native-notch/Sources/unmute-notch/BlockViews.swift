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
            if !turn.work.isEmpty {
                WorkGroup(turn: turn)
            }
            // FILE CHANGES SURFACE OUT OF THE GROUP. What a turn did to your
            // files is the single most consequential thing it did, and burying
            // it behind a disclosure alongside twenty shell steps is how the
            // old view made "what actually changed" unanswerable.
            ForEach(Array(fileChanges.enumerated()), id: \.offset) { _, b in
                FileChangeRow(block: b)
            }
            if let reply = turn.reply, let text = reply.text {
                BlockAnswer(text: text)
                    // Prose is capped for readability; see READABLE_MEASURE.
                    // Code and diffs keep the full panel.
                    .frame(maxWidth: 680, alignment: .leading)
            }
        }
    }

    private var fileChanges: [Block] { turn.work.filter { $0.kind == "fileChange" } }
}

// MARK: - work group

private struct WorkGroup: View {
    let turn: BlockTurn
    @State private var open: Bool?

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
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, b in
                        BlockStepRow(block: b)
                    }
                    if !turn.sources.isEmpty { SourcesSection(sources: turn.sources) }
                }
                .padding(.top, 8)
                .padding(.leading, 15)
            }
        }
    }

    /// File changes are drawn outside the group, so they are not repeated here.
    private var steps: [Block] { turn.work.filter { $0.kind != "fileChange" } }

    private var headline: String {
        if turn.meta.isRunning { return "Working" }
        if let ms = turn.meta.durationMs { return "Worked for \(formatDuration(ms))" }
        return "Worked"
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

// MARK: - one step

private struct BlockStepRow: View {
    let block: Block

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(glyph)
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .frame(width: 14, alignment: .center)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) { content }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private var content: some View {
        switch block.kind {
        case "reasoning":  ReasoningRow(block: block)
        case "command":    CommandRow(block: block)
        case "mcpCall":    McpRow(block: block)
        case "fileRead":   FileReadRow(block: block)
        case "search":     SearchRow(block: block)
        case "plan":       PlanRow(block: block)
        case "subAgent":   SubAgentRow(block: block)
        case "denied":     DeniedRow(block: block)
        case "error":      ErrorRow(block: block)
        case "compaction": CompactionRow(block: block)
        default:           UnknownRow(block: block)
        }
    }

    private var glyph: String {
        switch block.kind {
        case "reasoning":  return "✳"
        case "command":    return "›_"
        case "mcpCall":    return "⊞"
        case "fileRead":   return "◇"
        case "search":     return "⌕"
        case "plan":       return "☰"
        case "subAgent":   return "⑂"
        case "denied":     return "⊘"
        case "error":      return "!"
        case "compaction": return "≡"
        default:           return "·"
        }
    }
}

// MARK: - the kinds

private struct ReasoningRow: View {
    let block: Block
    var body: some View {
        Text(block.text ?? "")
            .font(.system(size: 12))
            .italic()
            .foregroundColor(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct CommandRow: View {
    let block: Block
    var body: some View {
        HStack(spacing: 8) {
            Text(block.label ?? "Ran command")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(block.status == "failed" ? Theme.cError : Theme.text)
            Spacer(minLength: 0)
            if let ms = block.durationMs {
                Text(formatDuration(ms))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        Text(block.command ?? "")
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        if let out = block.output, !out.isEmpty {
            Text(out)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .lineLimit(6)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 8)
                .overlay(Rectangle().fill(Theme.hairline).frame(width: 1), alignment: .leading)
        }
    }
}

private struct McpRow: View {
    let block: Block
    var body: some View {
        HStack(spacing: 8) {
            Text("\(block.server ?? "") · \(block.tool ?? "")")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Theme.text)
            Spacer(minLength: 0)
            if let ms = block.durationMs {
                Text(formatDuration(ms))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        if let args = block.args, args != "{}" {
            Text(args)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
                .lineLimit(2)
        }
    }
}

private struct FileReadRow: View {
    let block: Block
    var body: some View {
        HStack(spacing: 8) {
            Text("Read").font(.system(size: 12, weight: .medium)).foregroundColor(Theme.text)
            Spacer(minLength: 0)
            if let n = block.lines {
                Text("\(n) lines")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        Text(shortPath(block.path ?? ""))
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Theme.textDim)
            .lineLimit(1).truncationMode(.head)
    }
}

private struct SearchRow: View {
    let block: Block
    var body: some View {
        HStack(spacing: 8) {
            Text("Searched the web").font(.system(size: 12, weight: .medium)).foregroundColor(Theme.text)
            Spacer(minLength: 0)
            let n = block.results?.count ?? 0
            if n > 0 {
                Text(n == 1 ? "1 result" : "\(n) results")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        Text(block.query ?? "")
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct PlanRow: View {
    let block: Block
    var body: some View {
        let steps = block.steps ?? []
        let done = steps.filter { $0.status == "done" }.count
        Text("PLAN · \(done) OF \(steps.count)")
            .font(.system(size: 9.5, design: .monospaced))
            .foregroundColor(Theme.textFaint)
            .tracking(0.8)
        ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
            HStack(alignment: .top, spacing: 7) {
                Text(marker(step.status))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
                    .frame(width: 10, alignment: .leading)
                Text(step.text)
                    .font(.system(size: 12))
                    .foregroundColor(step.status == "active" ? Theme.text : Theme.textDim)
                    .strikethrough(step.status == "done", color: Theme.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func marker(_ status: String) -> String {
        switch status {
        case "done":   return "✓"
        case "active": return "▸"
        default:       return "·"
        }
    }
}

private struct SubAgentRow: View {
    let block: Block
    var body: some View {
        HStack(spacing: 8) {
            Text(block.name ?? "sub-agent")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Theme.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(block.status ?? "")
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Theme.textFaint)
        }
    }
}

/// A tool call you REFUSED. It used to render exactly like one that ran, which
/// is the surface lying about what happened.
private struct DeniedRow: View {
    let block: Block
    var body: some View {
        Text("You rejected: \(block.what ?? "a tool call")")
            .font(.system(size: 11.5))
            .foregroundColor(Theme.cNeeds)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ErrorRow: View {
    let block: Block
    var body: some View {
        Text(block.message ?? "Error")
            .font(.system(size: 11.5))
            .foregroundColor(Theme.cError)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct CompactionRow: View {
    let block: Block
    var body: some View {
        Text(detail)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundColor(Theme.textFaint)
    }
    private var detail: String {
        if let b = block.before, let a = block.after {
            return "Context compacted · \(b / 1000)k → \(a / 1000)k"
        }
        return "Context compacted"
    }
}

/// A kind this build does not know. Quiet, honest, and never a message — see
/// the open rule in Blocks.swift.
private struct UnknownRow: View {
    let block: Block
    var body: some View {
        Text(block.kind)
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Theme.textFaint)
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
