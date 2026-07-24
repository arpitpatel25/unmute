import SwiftUI

// The single-task surface (~55% of the screen). One task at a time: read it,
// tap an offered option, or answer by voice; Next cranks to the next your-move
// task; "Open dashboard" morphs up to the cockpit. Spacious, since the surface
// is large now — content sits at the top, actions pinned to the bottom.
struct TaskView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.top, notchInset)
            if let t = model.task {
                if let summary = t.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.system(size: 15))
                        .foregroundColor(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 14)
                }
                if let options = t.options, !options.isEmpty {
                    optionButtons(options).padding(.top, 18)
                } else {
                    Text(promptHint(for: t.state))
                        .font(.system(size: 13)).foregroundColor(Theme.textDim)
                        .padding(.top, 14)
                }
            } else {
                Text("All clear — nothing needs you.")
                    .font(.system(size: 15)).foregroundColor(Theme.textDim).padding(.top, 14)
            }
            Spacer(minLength: 16)
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 28)
        .padding(.bottom, 22)
    }

    // Clear the physical notch on notched hardware.
    private var notchInset: CGFloat { 18 }

    private var header: some View {
        HStack(spacing: 9) {
            Circle().fill(stateColor).frame(width: 9, height: 9)
            Text(model.task?.title ?? "Attention")
                .font(.system(size: 19, weight: .semibold)).foregroundColor(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            if model.attention > 0 {
                Text("1 of \(model.attention)")
                    .font(.system(size: 13, weight: .medium)).foregroundColor(Theme.textDim)
            }
        }
    }

    private func optionButtons(_ options: [String]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(options.enumerated()), id: \.offset) { idx, label in
                Button(action: { model.emit(.chooseOption(index: idx)) }) {
                    Text(label)
                        .font(.system(size: 15, weight: .medium)).foregroundColor(Theme.text)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 11).fill(Color(white: 0.14)))
                }.buttonStyle(.plain)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button(action: { model.emit(.openDashboard) }) {
                Text("Open dashboard").font(.system(size: 13, weight: .medium)).foregroundColor(Theme.textDim)
            }.buttonStyle(.plain)
            Spacer(minLength: 0)
            Button(action: { model.emit(.next) }) {
                Text("Next →").font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.text)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 11).fill(Color(white: 0.16)))
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
        case .ready, .none: return Theme.textDim
        default: return Theme.accent
        }
    }
}
