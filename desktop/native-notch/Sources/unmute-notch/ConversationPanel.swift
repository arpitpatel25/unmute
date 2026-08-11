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
    /// The task this transcript belongs to — switching tasks re-anchors.
    var id: String = ""

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
                // ANCHOR AFTER LAYOUT, NOT DURING IT.
                //
                // `onAppear` fires before SwiftUI has laid the content out, so
                // scrolling there is a no-op — the transcript opened at the very
                // TOP every time. And `onChange(of: turns.count)` was the only
                // other trigger, which never fires when you open a conversation
                // that already has all its messages. Hopping to the next runloop
                // pass puts this after layout, where scrollTo actually lands.
                .onAppear { jump(proxy, animated: false) }
                // `id` changes when the panel switches to a different task, so
                // each task opens at its own latest message rather than
                // inheriting the previous one's scroll position.
                .onChange(of: id) { _ in jump(proxy, animated: false) }
                .onChange(of: turns.count) { _ in jump(proxy, animated: true) }
            }
        }
    }

    private func jump(_ proxy: ScrollViewProxy, animated: Bool) {
        DispatchQueue.main.async {
            if animated { withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(BOTTOM, anchor: .bottom) } }
            else { proxy.scrollTo(BOTTOM, anchor: .bottom) }
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
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 16)
                        .stroke(Theme.hairline, lineWidth: 0.5))
            }
            // A BUBBLE HAS TO BE NARROWER THAN THE COLUMN or it stops reading as
            // one. Codex caps its own at roughly two-thirds; capping by MEASURE
            // rather than a percentage keeps that proportion honest in the
            // notch, which is far narrower than the Codex window — a literal
            // 65% there would be cramped.
            .frame(maxWidth: 460, alignment: .trailing)
        }
    }
}

private struct AnswerBlock: View {
    let text: String
    @State private var copied = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RichText(text: text, size: 14)
            // Codex puts a quiet icon row under each answer. Ours carries the
            // one action we can honestly offer — rating and sharing belong to
            // Codex's account, not to a remote.
            HStack(spacing: 12) {
                Button(action: copy) {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10.5))
                        Text(copied ? "Copied" : "Copy").font(.system(size: 11.5))
                    }
                    .foregroundColor(copied ? Theme.cReady : Theme.textFaint)
                }
                .buttonStyle(.plain)
                .help("Copy this message")
            }
            .opacity(hovering || copied ? 1 : 0.35)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
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
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.textFaint)
                    Text(label)
                        .font(Theme.fSub)
                        .foregroundColor(Theme.textDim)
                    Spacer(minLength: 0)
                    if !items.isEmpty {
                        NumText(text: "\(items.count) step\(items.count == 1 ? "" : "s")")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Rectangle().fill(Theme.hairlineSoft).frame(height: 1)

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
                    Image(systemName: turn.ok == false ? "xmark" : "chevron.right")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundColor(turn.ok == false ? Theme.cError : Theme.textFaint)
                    Text(turn.title ?? "Step")
                        .font(Theme.fSub)
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let ms = turn.durationMs, ms > 0 { NumText(text: short(ms)) }
                }
                .contentShape(Rectangle())
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
    /// Callers that render SECONDARY prose (the warm-up strip) dim this; the
    /// transcript's own answers keep the default. Previously hardcoded, which
    /// silently overrode every caller.
    var color: Color = Theme.text

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                switch l {
                case let .paragraph(s):
                    inline(s).fixedSize(horizontal: false, vertical: true)
                case let .heading(s, level):
                    inline(s, weight: .semibold, scale: level == 1 ? 1.25 : 1.1)
                        .fixedSize(horizontal: false, vertical: true)
                case let .bullet(marker, s, depth):
                    HStack(alignment: .top, spacing: 8) {
                        Text(marker)
                            .font(.system(size: size))
                            .foregroundColor(Theme.textDim)
                            .frame(minWidth: 14, alignment: .trailing)
                        inline(s).fixedSize(horizontal: false, vertical: true)
                    }
                    // NESTING SURVIVES. Leading spaces were trimmed before the
                    // line was classified, so a sub-point sat level with its
                    // parent and a structured answer read as one flat list.
                    .padding(.leading, CGFloat(depth) * 16)
                case let .code(lines, lang):
                    // FENCED BLOCKS ARE THE COMMON CASE IN AGENT OUTPUT and they
                    // fell through to `paragraph`: the ``` printed literally, the
                    // code lost its font, and every line was joined into one
                    // run-on paragraph because blank-line handling flushed on
                    // emptiness. Verbatim, monospaced, on its own ground.
                    VStack(alignment: .leading, spacing: 2) {
                        if let lang, !lang.isEmpty {
                            Text(lang)
                                .font(.system(size: size * 0.72, weight: .semibold))
                                .foregroundColor(Theme.textFaint)
                        }
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, cl in
                            Text(cl.isEmpty ? " " : cl)
                                .font(.system(size: size * 0.88, design: .monospaced))
                                .foregroundColor(color)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, 9).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Theme.sunken))
                case let .quote(s):
                    inline(s)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 9)
                        .overlay(Rectangle().fill(Theme.hairline).frame(width: 2), alignment: .leading)
                case .rule:
                    Rectangle().fill(Theme.hairlineSoft).frame(height: 1)
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
            .foregroundColor(color)
    }

    private enum Line {
        case paragraph(String)
        case heading(String, Int)
        /// marker, text, indent depth (0 = top level)
        case bullet(String, String, Int)
        /// A fenced block: the lines verbatim, and the language if it was given.
        case code([String], String?)
        case quote(String)
        case rule
    }

    private var lines: [Line] {
        var out: [Line] = []
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: " "))); paragraph = [] }
        }
        var fence: [String]? = nil       // lines collected inside ``` … ```
        var fenceLang: String? = nil
        for raw in text.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            // A FENCE SWALLOWS EVERYTHING until it closes — including blank
            // lines and text that looks like a bullet or a heading, which is the
            // point: inside a code block those are code, not markup.
            if t.hasPrefix("```") || t.hasPrefix("~~~") {
                if let body = fence {
                    out.append(.code(body, fenceLang)); fence = nil; fenceLang = nil
                } else {
                    flush()
                    fence = []
                    let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    fenceLang = lang.isEmpty ? nil : lang
                }
                continue
            }
            if fence != nil { fence?.append(raw); continue }   // raw: indentation is content
            if t.isEmpty { flush(); continue }
            // Depth from the ORIGINAL line, before trimming loses it.
            let indent = raw.prefix(while: { $0 == " " || $0 == "\t" }).count
            let depth = min(3, indent / 2)
            if t == "---" || t == "***" || t == "___" { flush(); out.append(.rule); continue }
            if t.hasPrefix("> ") { flush(); out.append(.quote(String(t.dropFirst(2)))); continue }
            if t.hasPrefix("#") {
                flush()
                let level = t.prefix(while: { $0 == "#" }).count
                out.append(.heading(String(t.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces), level))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("• ") {
                flush()
                out.append(.bullet(depth > 0 ? "◦" : "•", String(t.dropFirst(2)), depth))
            } else if let dot = t.firstIndex(of: "."), t[t.startIndex..<dot].allSatisfy(\.isNumber),
                      t.index(after: dot) < t.endIndex, t[t.index(after: dot)] == " " {
                flush()
                out.append(.bullet(String(t[t.startIndex...dot]), String(t[t.index(dot, offsetBy: 2)...]), depth))
            } else {
                paragraph.append(t)
            }
        }
        // An unterminated fence still renders as code — a truncated stream is
        // exactly when you most want to read what it managed to write.
        if let body = fence, !body.isEmpty { out.append(.code(body, fenceLang)) }
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
/// The composer, for any backend you can say something to.
///
/// It began as Codex's — a driven backend has no terminal, so a text field was
/// the ONLY way in. A Claude task has a terminal, which is why it never had one:
/// you could always type into the PTY. But when the stage is already open in
/// front of you, being sent into a terminal to type one line is exactly the
/// friction this surface exists to remove, so the composer is now shared.
///
/// The placeholder keeps voice primary in both cases — it names the key before
/// it names the field.
struct StageComposer: View {
    var placeholder: String = "Reply — or hold right ⌥ and speak"
    @ObservedObject var model: NotchModel
    let taskId: String
    /// Last message that did not get through — shown here, where the retry is.
    let deliveryError: String?
    /// What this thread will run on ("5.6 Terra · High"), when we know.
    var modelLabel: String? = nil
    /// True while a send is in flight.
    var sending: Bool = false
    @State private var text = ""
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let e = deliveryError, !e.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text(e).font(.system(size: 11.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundColor(Theme.cError)
            }
            // Codex's composer is a TALL rounded box with its controls on a row
            // beneath the text, not a one-line field with a button beside it.
            // The shape is most of what makes it read as a place to write.
            VStack(alignment: .leading, spacing: 10) {
                TextField(placeholder, text: $text, onCommit: send)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13.5))
                    .foregroundColor(Theme.text)
                    .focused($focused)
                HStack(spacing: 10) {
                    if let m = modelLabel, !m.isEmpty {
                        Text(m).font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                    }
                    Spacer(minLength: 0)
                    if sending {
                        // Sending is a round-trip through another app's window;
                        // silence for a second reads as "nothing happened".
                        Text("Sending…").font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }
                    // The composer's ONE primary action, and the only tinted
                    // thing on this surface.
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(canSend ? Theme.accentInk : Theme.textFaint)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(canSend ? Theme.accent : Theme.raised))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .animation(Theme.hover, value: canSend)
                }
            }
            .padding(.horizontal, 13)
            .padding(.top, 11)
            .padding(.bottom, 9)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.sunken))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .stroke(focused ? Theme.accent.opacity(0.55) : Theme.hairline, lineWidth: focused ? 1 : 0.5))
            .animation(Theme.hover, value: focused)
        }
    }

    private func send() {
        let v = text.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        model.emit(.answerText(id: taskId, text: v))
        text = ""
    }
}


/// Codex's composer: the shared one, with Codex's own wording.
struct CodexComposer: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    var deliveryError: String? = nil
    var modelLabel: String? = nil
    var sending: Bool = false

    var body: some View {
        StageComposer(placeholder: "Reply to Codex — or hold right ⌥ and speak",
                      model: model, taskId: taskId, deliveryError: deliveryError,
                      modelLabel: modelLabel, sending: sending)
    }
}
