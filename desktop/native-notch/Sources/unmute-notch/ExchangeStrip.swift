import SwiftUI

/// The latest exchange — what you asked, and what came back — above the terminal.
///
/// WHY THIS EXISTS. The stage used to be an either/or: a driven backend showed a
/// `ConversationPanel` because it has no PTY, and a Claude task showed a raw
/// terminal and nothing else. So the one question a returning user actually has
/// — *what did I ask, and what did it say back* — could only be answered by
/// reading scrollback in a terminal, which is precisely the work the wall exists
/// to save them.
///
/// This is NOT a chat transcript, and the distinction is the whole design:
///
///   * `ConversationPanel` IS the surface for a backend with no terminal. It
///     scrolls, it holds the whole thread, it takes the full pane.
///   * `ExchangeStrip` is a HEADLINE for a backend that has one. Two turns, a
///     bounded height, and the terminal still owns the rest of the stage.
///
/// Keeping it to the latest exchange is what stops it becoming a re-rendered
/// conversation — the bright line in ORCHESTRATE-VISION §3. Everything before
/// this exchange is history, and history is what the terminal below is for.
struct ExchangeStrip: View {
    let turns: [TurnP]
    /// The task's state. "working…" is a claim about the PRESENT, so it may only
    /// be made while the task is actually processing — this said "working…" on a
    /// finished task whose reply had not arrived, turning a display gap into a
    /// lie about what the agent was doing.
    var status: TaskStatus? = nil
    /// Bound so a long answer cannot push the terminal off the stage.
    var maxAnswerHeight: CGFloat = 190

    private var ask: TurnP? { turns.last(where: { $0.role == "user" }) }
    private var reply: TurnP? { turns.last(where: { $0.role == "assistant" }) }

    var body: some View {
        if ask == nil && reply == nil {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let a = ask, !a.text.isEmpty {
                    AskBubble(text: a.text)
                }
                if let r = reply, !r.text.isEmpty {
                    // The model's own prose, rendered as markdown — it was
                    // written for a human to read, so it is shown as one.
                    ScrollView {
                        RichText(text: r.text, size: 13)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: maxAnswerHeight)
                } else if ask != nil, status == .processing {
                    // Mid-turn ONLY: the ask is on screen and the reply has not
                    // landed yet. Saying so beats a blank space that reads as a
                    // bug — but claiming it about a finished task is worse than
                    // saying nothing, so anything not processing shows nothing.
                    Text("working…")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textFaint)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The user's message. Right-aligned and capped in width, because a bubble that
/// spans the column stops reading as one — same rule the full panel uses.
private struct AskBubble: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .lineLimit(4)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.hairline, lineWidth: 0.5))
                .frame(maxWidth: 420, alignment: .trailing)
        }
    }
}
