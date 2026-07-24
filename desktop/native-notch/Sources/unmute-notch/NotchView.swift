import SwiftUI

// The morphing notch. One rounded shape that springs between three footprints,
// top-anchored inside the (panel-sized) window canvas. Content cross-fades in
// sync with the size change so the whole thing reads as one living surface.
struct NotchView: View {
    @ObservedObject var model: NotchModel

    private var radius: CGFloat {
        switch model.state {
        case .idle:  return Theme.idleRadius
        case .peek:  return Theme.peekRadius
        case .panel: return Theme.panelRadius
        }
    }

    // The window is now sized to the state and top-pinned, so the shape simply
    // FILLS the window. No floating inside a giant canvas; no safe-area inset.
    var body: some View {
        shape
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(.all)
    }

    private var shape: some View {
        ZStack {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(model.state == .panel ? Theme.fillElevated : Theme.fill)
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1)
                )
                .overlay(glow)

            content
                .padding(.horizontal, model.state == .panel ? 20 : 14)
                .padding(.vertical, model.state == .panel ? 16 : 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(Theme.morph, value: model.state)
        .animation(Theme.morph, value: model.attention)
        .contentShape(Rectangle())
        .onTapGesture { handleTap() }
    }

    // Amber ring only when there is your-move attention; a faint working glow
    // otherwise. Never both, never motion at idle-with-nothing.
    @ViewBuilder private var glow: some View {
        if model.attention > 0 {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Theme.accent.opacity(0.9), lineWidth: 1.5)
        } else if model.working > 0 && model.state == .idle {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Theme.accentDim, lineWidth: 1)
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .idle:
            // Nothing at rest — calm. (A working count could show here later.)
            EmptyView()
        case .peek:
            HStack(spacing: 10) {
                Circle().fill(Theme.accent).frame(width: 7, height: 7)
                Text(peekLabel).font(.system(size: 13, weight: .medium)).foregroundColor(Theme.text)
                Spacer(minLength: 0)
                if model.attention > 1 {
                    Text("\(model.attention)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(Theme.textDim)
                }
            }
        case .panel:
            PanelView(model: model)
        }
    }

    private var peekLabel: String {
        guard let t = model.task else { return "Something needs you" }
        switch t.state {
        case .needsUser: return t.title
        case .stuck:     return "Stuck: \(t.title)"
        case .errored:   return "Failed: \(t.title)"
        case .ready:     return "Ready: \(t.title)"
        }
    }

    private func handleTap() {
        switch model.state {
        // The notch is ALWAYS tappable. With nothing needing you, a tap is a
        // request to see everything → open the cockpit. A peek is a request to
        // handle the one task → open the attention panel.
        case .idle:  model.emit(.openDashboard)
        case .peek:  model.emit(.tap)          // main decides → sends setState:panel
        case .panel: break                      // taps inside handled by PanelView
        }
    }
}
