import SwiftUI

/// The GUI-agent equivalent of the live terminal.
///
/// A Claude Code task shows a raw PTY because that IS its conversation. A Codex
/// thread has no PTY, and rendering an empty terminal frame for it is what made
/// the task panel read as a giant black void with two meaningless buttons.
///
/// So this shows the conversation itself — deliberately the LAST FEW TURNS, not
/// a scrollback. The distinction matters: ORCHESTRATE-VISION §3 forbids
/// re-rendering the other app's chat ("the delete-the-wall test"), and the
/// terminal escapes that rule only because it is the real thing shown raw. A
/// short, unstyled tail is the same bargain: enough to re-enter and answer,
/// never a nicer chat client than the app it came from. The full conversation is
/// always one tap away via "open in Codex".
struct ConversationPanel: View {
    let turns: [TurnP]

    var body: some View {
        if turns.isEmpty {
            // Honest empty state. The old behaviour here was an empty terminal
            // frame, which looked like something had broken.
            HStack(spacing: 6) {
                Text("no messages yet")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(turn.role == "user" ? "you" : "codex")
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundColor(turn.role == "user" ? Theme.textFaint : Theme.cReady)
                        Text(turn.text)
                            .font(.system(size: 12.5))
                            .foregroundColor(turn.role == "user" ? Theme.textDim : Theme.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            // Content-sized, never the terminal's full-height frame: a two-line
            // exchange must not occupy the whole panel.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
