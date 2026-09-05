import SwiftUI

/// What stands where the composer would be when there is no live executor.
///
/// The alternative — and what shipped before — was a text box over a dead
/// session: you typed, pressed send, and the draft was retained and refused with
/// nothing said. The app already knew why (`deliveryError` is set at the
/// capability gate and shipped in the detail payload); there was simply nowhere
/// showing it. Opening the task now performs the action, while this view reports
/// the reconnect instead of asking the user to manage a provider process.
struct SessionNotRunning: View {
    let reason: String?

    var body: some View {
        HStack(spacing: 10) {
            if reason == nil { ProgressView().controlSize(.small) }
            Text(reason ?? "Reconnecting conversation…")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.06))
        )
    }
}
