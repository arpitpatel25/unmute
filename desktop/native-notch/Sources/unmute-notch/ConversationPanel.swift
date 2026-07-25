import SwiftUI
import AppKit

/// Scroll anchor: a zero-height marker at the end of the transcript.
private let BOTTOM = "conversation-bottom"

/// A Codex thread, rendered the way Codex renders it.
///
/// This is the GUI-agent equivalent of the live terminal: a Claude task shows a
/// raw PTY because that IS its conversation, and the honest equivalent here is
/// Codex's own item stream in Codex's own shape. The first attempt invented a
/// shape instead — labelled "you"/"codex" rows and a flat list of every tool
/// step — which looked nothing like the app it came from and buried the answer
/// under a dozen rows of plumbing.
///
/// What Codex actually does, measured from its window:
///   * your message: a right-aligned rounded bubble, never full width
///   * the whole tool run: ONE collapsed line, "Worked for 2m 46s ›", rule under
///   * the answer: left-aligned, full width, no label, no avatar, real markdown
///   * an action row under the answer (copy)
struct ConversationPanel: View {
    let turns: [TurnP]

    var body: some View {
        if turns.isEmpty {
            Text("no messages yet")
                .font(.system(size: 13))
                .foregroundColor(Theme.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
        } else {
            // SCROLLS, rather than growing the panel. The latest exchange is
            // what you want in view on open, and a new message should follow —
            // so the scroller is anchored to the bottom and re-anchored when
            // the item count changes.
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                            switch b {
                            case let .user(text):     UserBubble(text: text)
                            case let .answer(text):   AnswerBlock(text: text)
                            case let .work(ms, body): WorkBlock(durationMs: ms, items: body)
                            }
                        }
                        // Anchor: scrolling to a zero-height marker puts the
                        // real last message flush with the bottom edge.
                        Color.clear.frame(height: 1).id(BOTTOM)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 2)
                }
                .onAppear { proxy.scrollTo(BOTTOM, anchor: .bottom) }
                .onChange(of: turns.count) { _ in
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(BOTTOM, anchor: .bottom) }
                }
            }
        }
    }

    private enum Block {
        case user(String)
        case answer(String)
        case work(Int?, [TurnP])
    }

    /// Fold the flat item stream into Codex's three visual units. The parser
    /// already marks where each work run begins (`role == "work"`).
    private var blocks: [Block] {
        var out: [Block] = []
        var i = 0
        while i < turns.count {
            let t = turns[i]
            switch t.role {
            case "user":
                out.append(.user(t.text)); i += 1
            case "work":
                var body: [TurnP] = []
                var j = i + 1
                while j < turns.count, turns[j].role == "tool" || turns[j].role == "commentary" {
                    body.append(turns[j]); j += 1
                }
                out.append(.work(t.durationMs, body)); i = j
            case "tool", "commentary":
                // A run with no marker (older snapshot) — still group it.
                var body: [TurnP] = []
                var j = i
                while j < turns.count, turns[j].role == "tool" || turns[j].role == "commentary" {
                    body.append(turns[j]); j += 1
                }
                out.append(.work(nil, body)); i = j
            default:
                out.append(.answer(t.text)); i += 1
            }
        }
        return out
    }
}

// MARK: - The three units

private struct UserBubble: View {
    let text: String
    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Text(text)
                .font(.system(size: 14))
                .foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.09)))
        }
    }
}

private struct AnswerBlock: View {
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            RichText(text: text, size: 14)
            Button(action: copy) {
                Text(copied ? "copied" : "copy")
                    .font(.system(size: 11))
                    .foregroundColor(copied ? Theme.cReady : Theme.textFaint)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// "Worked for 2m 46s ›" — everything the agent did, behind one line.
private struct WorkBlock: View {
    let durationMs: Int?
    let items: [TurnP]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: { open.toggle() }) {
                HStack(spacing: 6) {
                    Text(label)
                        .font(.system(size: 13))
                        .foregroundColor(Theme.textDim)
                    Text(open ? "⌄" : "›")
                        .font(.system(size: 11))
                        .foregroundColor(Theme.textFaint)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            Rectangle().fill(Theme.hairline).frame(height: 1)

            if open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                        if it.role == "commentary" {
                            Text(it.text)
                                .font(.system(size: 13.5))
                                .foregroundColor(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            StepRow(turn: it)
                        }
                    }
                }
            }
        }
    }

    /// Codex phrases this as elapsed wall time; keep its wording exactly.
    private var label: String {
        guard let ms = durationMs, ms > 0 else { return "Worked on it" }
        let s = ms / 1000
        if s < 60 { return "Worked for \(s)s" }
        let m = s / 60, rem = s % 60
        return rem == 0 ? "Worked for \(m)m" : "Worked for \(m)m \(rem)s"
    }
}

/// One step inside the work block: its title, expandable to code and output.
private struct StepRow: View {
    let turn: TurnP
    @State private var open = false

    private var hasBody: Bool { !(turn.code ?? "").isEmpty || !(turn.output ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: { if hasBody { open.toggle() } }) {
                HStack(spacing: 7) {
                    Text(turn.ok == false ? "✗" : "›")
                        .font(.system(size: 10))
                        .foregroundColor(turn.ok == false ? Theme.cError : Theme.textFaint)
                    Text(turn.title ?? "step")
                        .font(.system(size: 12.5))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let ms = turn.durationMs, ms > 0 {
                        Text(short(ms))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(Theme.textFaint)
                    }
                }
            }
            .buttonStyle(.plain)

            if open {
                if let code = turn.code, !code.isEmpty { block(code, tint: Theme.cReady.opacity(0.85)) }
                if let out = turn.output, !out.isEmpty { block(out, tint: Theme.textDim) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func block(_ text: String, tint: Color) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(tint)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: 200)
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.35)))
        .padding(.leading, 14)
    }

    private func short(_ ms: Int) -> String {
        ms < 1000 ? "\(ms)ms" : String(format: "%.1fs", Double(ms) / 1000)
    }
}

// MARK: - Markdown that renders BLOCKS, not just inline runs

/// `MarkdownText` parses with `.inlineOnlyPreservingWhitespace`, so bold and
/// code work but **lists, headings and paragraphs do not** — a Codex answer full
/// of bullets came out as literal "- " lines. It also hardcodes its own size and
/// colour, silently overriding the caller's.
///
/// This renders block structure (paragraphs, bullets, numbered items, headings)
/// and applies inline markdown within each line, so an answer looks the way it
/// looks in Codex.
struct RichText: View {
    let text: String
    var size: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                switch l {
                case let .paragraph(s):
                    inline(s).fixedSize(horizontal: false, vertical: true)
                case let .heading(s, level):
                    inline(s, weight: .semibold, scale: level == 1 ? 1.25 : 1.1)
                        .fixedSize(horizontal: false, vertical: true)
                case let .bullet(marker, s):
                    HStack(alignment: .top, spacing: 8) {
                        Text(marker)
                            .font(.system(size: size))
                            .foregroundColor(Theme.textDim)
                            .frame(minWidth: 14, alignment: .trailing)
                        inline(s).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    private func inline(_ s: String, weight: Font.Weight = .regular, scale: CGFloat = 1) -> Text {
        let attr = (try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        return Text(attr)
            .font(.system(size: size * scale, weight: weight))
            .foregroundColor(Theme.text)
    }

    private enum Line {
        case paragraph(String)
        case heading(String, Int)
        case bullet(String, String)
    }

    private var lines: [Line] {
        var out: [Line] = []
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: " "))); paragraph = [] }
        }
        for raw in text.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { flush(); continue }
            if t.hasPrefix("#") {
                flush()
                let level = t.prefix(while: { $0 == "#" }).count
                out.append(.heading(String(t.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces), level))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("• ") {
                flush()
                out.append(.bullet("•", String(t.dropFirst(2))))
            } else if let dot = t.firstIndex(of: "."), t[t.startIndex..<dot].allSatisfy(\.isNumber),
                      t.index(after: dot) < t.endIndex, t[t.index(after: dot)] == " " {
                flush()
                out.append(.bullet(String(t[t.startIndex...dot]), String(t[t.index(dot, offsetBy: 2)...])))
            } else {
                paragraph.append(t)
            }
        }
        flush()
        return out
    }
}

/// Type into a Codex thread from unmute.
///
/// A Codex chat is never "over" — it ends when you delete it in Codex, not when
/// a turn finishes. So unlike a Claude question box this is NOT gated on
/// `needs-user`: there is always something to say. It sends through the same
/// path right-Option dictation uses, so speaking and typing land identically.
struct CodexComposer: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    /// Last message that did not get through — shown here, where the retry is.
    let deliveryError: String?
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let e = deliveryError, !e.isEmpty {
                Text("⚠ \(e)")
                    .font(.system(size: 11.5))
                    .foregroundColor(Theme.cError)
            }
            HStack(spacing: 8) {
                TextField("reply to Codex — or hold right ⌥ and speak", text: $text, onCommit: send)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundColor(Theme.text)
                    .focused($focused)
                Button(action: send) {
                    Text("send")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(text.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.textFaint : Theme.cReady)
                }
                .buttonStyle(.plain)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(focused ? Theme.cReady.opacity(0.45) : Theme.hairline, lineWidth: 1))
        }
    }

    private func send() {
        let v = text.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        model.emit(.answerText(id: taskId, text: v))
        text = ""
    }
}
