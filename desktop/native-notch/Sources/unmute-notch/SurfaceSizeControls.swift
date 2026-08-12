import SwiftUI

/// Icon-only, visit-scoped size controls for an expanded notch surface.
struct SurfaceSizeControls: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        HStack(spacing: 5) {
            Button(action: model.shrinkSurface) {
                Image(systemName: "arrow.down.right.and.arrow.up.left")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(SurfaceSizeButtonStyle())
            .disabled(!model.canShrinkSurface)
            .help("Make surface smaller")
            .accessibilityLabel("Make surface smaller")

            Button(action: model.enlargeSurface) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(SurfaceSizeButtonStyle())
            .disabled(!model.canEnlargeSurface)
            .help("Make surface larger")
            .accessibilityLabel("Make surface larger")
        }
    }
}

private struct SurfaceSizeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(configuration.isPressed ? Theme.text : Theme.textDim)
            .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(configuration.isPressed ? Theme.raisedHover : Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .stroke(Theme.hairline, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
