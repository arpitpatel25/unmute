import SwiftUI
import SurfaceSizeSupport

/// Explicit, visit-scoped screen-fill controls for an expanded notch surface.
struct SurfaceSizeControls: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        HStack(spacing: 4) {
            ForEach(SurfaceSizeStep.values, id: \.self) { fill in
                Button(action: { model.selectSurfaceFill(fill) }) {
                    Text("\(Int(fill * 100))%")
                        .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                        .frame(width: 38, height: 28)
                }
                .buttonStyle(SurfaceSizeButtonStyle(selected: abs(model.selectedSurfaceFill - fill) < 0.001))
                .accessibilityLabel("Use \(Int(fill * 100)) percent of screen")
            }
        }
    }
}

private struct SurfaceSizeButtonStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(selected ? Theme.accentInk : (configuration.isPressed ? Theme.text : Theme.textDim))
            .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(selected ? Theme.accent : (configuration.isPressed ? Theme.raisedHover : Theme.raised)))
            .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .stroke(Theme.hairline, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
