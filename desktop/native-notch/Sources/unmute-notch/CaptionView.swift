import SwiftUI

/// One short line, the way a caption looks: light text on a dark slab, centred,
/// no chrome. The visual language is deliberately borrowed from video captions
/// because that is the thing people already read without being asked to.
struct CaptionView: View {
    let text: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(text)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                // The body never takes a click: it must not steal one meant for
                // the app underneath.
                .allowsHitTesting(false)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.75))
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(.white.opacity(0.18)))
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.black.opacity(0.74))
        )
        .fixedSize()
        // Everything outside the slab is empty and click-through: SwiftUI
        // hit-tests against content, so a transparent region with no background
        // returns nil and the app underneath gets the event.
    }
}
