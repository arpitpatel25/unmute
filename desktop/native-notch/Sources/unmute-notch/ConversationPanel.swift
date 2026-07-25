import SwiftUI

/// The GUI-agent equivalent of the live terminal.
///
/// A Claude Code task shows a raw PTY because that IS its conversation, shown
/// unstyled. The honest equivalent for a Codex thread is Codex's own item
/// stream — so this keeps the distinctions Codex draws instead of flattening
/// them to prose:
///
///   you          what you asked
///   commentary   the running "I'll do X next" line
///   step         something it ran — its own title, the code, the output
///   answer       the final message
///
/// Flattening was real loss, not a style choice. A turn that opened a browser,
/// searched YouTube, verified the channel and opened the video rendered as one
/// grey sentence, because only the final message survived the parse.
struct ConversationPanel: View {
    let turns: [TurnP]

    var body: some View {
        if turns.isEmpty {
            // Honest empty state. The old behaviour here was an empty terminal
            // frame, which read as something having broken.
            Text("no messages yet")
                .font(.system(size: 12))
                .foregroundColor(Theme.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in
                    entry(turn)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func entry(_ t: TurnP) -> some View {
        switch t.role {
        case "tool":  StepRow(turn: t)
        case "user":  message(label: "you", text: t.text, tint: Theme.textFaint, body: Theme.textDim)
        case "commentary":
            // Codex greys its running commentary and reserves full weight for
            // the answer; matching that is what makes a long thread skimmable.
            Text(t.text)
                .font(.system(size: 12.5))
                .foregroundColor(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:      message(label: "codex", text: t.text, tint: Theme.cReady, body: Theme.text)
        }
    }

    private func message(label: String, text: String, tint: Color, body: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(0.6)
                .foregroundColor(tint)
            MarkdownText(text: text)
                .foregroundColor(body)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One thing Codex ran: collapsed to its title, expandable to code + output.
///
/// Collapsed by default because a single turn routinely contains a dozen steps
/// whose bodies are thousands of characters of DOM snapshot — expanding them
/// all would bury the answer, which is the opposite of the point.
private struct StepRow: View {
    let turn: TurnP
    @State private var open = false

    private var hasBody: Bool {
        !(turn.code ?? "").isEmpty || !(turn.output ?? "").isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: { if hasBody { open.toggle() } }) {
                HStack(spacing: 7) {
                    Text(open ? "▾" : "▸")
                        .font(.system(size: 9))
                        .foregroundColor(Theme.textFaint)
                        .opacity(hasBody ? 1 : 0)
                    Text(turn.ok == false ? "✗" : "•")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(turn.ok == false ? Theme.cError : Theme.textFaint)
                    Text(turn.title ?? "step")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let ms = turn.durationMs, ms > 0 {
                        Text(duration(ms))
                            .font(.system(size: 10.5, design: .monospaced))
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
        .frame(maxHeight: 220)
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.35)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 1))
        .padding(.leading, 16)
    }

    private func duration(_ ms: Int) -> String {
        ms < 1000 ? "\(ms)ms" : String(format: "%.1fs", Double(ms) / 1000)
    }
}

/// Type into a Codex thread from unmute.
///
/// A Codex chat is never "over" — it ends when you delete it in Codex, not when
/// a turn finishes. So unlike a Claude question box this is NOT gated on
/// `needs-user`: there is always something to say. It sends through the same
/// path right-Option dictation already uses (answerText → answer/followUp), so
/// speaking and typing land identically.
struct CodexComposer: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("reply to Codex — or hold right ⌥ and speak", text: $text, onCommit: send)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
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
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.32)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(focused ? Theme.cReady.opacity(0.45) : Theme.hairline, lineWidth: 1))
    }

    private func send() {
        let v = text.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        model.emit(.answerText(id: taskId, text: v))
        text = ""
    }
}
