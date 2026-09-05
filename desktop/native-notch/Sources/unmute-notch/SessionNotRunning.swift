import SwiftUI

/// What stands where the composer would be when there is no live executor.
///
/// The alternative — and what shipped before — was a text box over a dead
/// session: you typed, pressed send, and the draft was retained and refused with
/// nothing said. The app already knew why (`deliveryError` is set at the
/// capability gate and shipped in the detail payload); there was simply nowhere
/// showing it. So this says the true thing and offers the action that fixes it.
struct SessionNotRunning: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    /// The engine's own words when it has them — "This CLI session cannot verify
    /// task draft submission", "Codex is not connected to Unmute". Preferred over
    /// anything invented here, because it names the actual blocker.
    let reason: String?
    var canResume = true

    var body: some View {
        HStack(spacing: 10) {
            Text(reason ?? "This session isn’t running.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if canResume {
                Button("Resume") { model.emit(.resume(id: taskId)) }
                    .buttonStyle(.borderless)
                    .font(.system(size: 12, weight: .semibold))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.06))
        )
    }
}
