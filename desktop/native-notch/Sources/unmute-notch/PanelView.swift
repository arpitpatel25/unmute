import SwiftUI

// The attention panel: exactly one task at a time, at panel size (never the
// dashboard). Reads the task, offers its tappable options (needs-user) or a
// prompt-by-voice hint, and a Next + "i of N" crank. "Open dashboard" hands off
// to the Electron cockpit. Terminal-in-panel is deferred (Stage 6) — for now a
// button asks main to open the cockpit.
struct PanelView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let t = model.task {
                if let summary = t.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 13))
                        .foregroundColor(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let options = t.options, !options.isEmpty {
                    optionButtons(options)
                } else {
                    Text(promptHint(for: t.state))
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textDim)
                }
            } else {
                Text("All clear — nothing needs you.")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.textDim)
            }
            Spacer(minLength: 0)
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(stateColor).frame(width: 8, height: 8)
            Text(model.task?.title ?? "Attention")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            if model.attention > 0 {
                Text("1 of \(model.attention)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Theme.textDim)
            }
        }
    }

    private func optionButtons(_ options: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { idx, label in
                Button(action: { model.emit(.chooseOption(index: idx)) }) {
                    Text(label)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Theme.text)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.14)))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button(action: { model.emit(.openDashboard) }) {
                Text("Open dashboard").font(.system(size: 12, weight: .medium))
                    .foregroundColor(Theme.textDim)
            }.buttonStyle(.plain)
            Spacer(minLength: 0)
            Button(action: { model.emit(.next) }) {
                Text("Next →").font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Theme.text)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.16)))
            }.buttonStyle(.plain)
        }
    }

    private func promptHint(for state: TaskAttentionState) -> String {
        switch state {
        case .needsUser: return "Hold the Remote key to answer, or type."
        case .stuck:     return "Hold the Remote key to redirect it."
        case .errored:   return "Hold the Remote key to retry or redirect."
        case .ready:     return "Hold the Remote key to give it the next step."
        }
    }

    private var stateColor: Color {
        switch model.task?.state {
        case .errored: return Theme.accent
        case .needsUser, .stuck: return Theme.accent
        case .ready: return Theme.textDim
        case .none: return Theme.textDim
        }
    }
}
