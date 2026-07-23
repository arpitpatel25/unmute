import SwiftUI

// The morphing notch. One rounded shape that springs between three footprints,
// top-anchored inside the (panel-sized) window canvas. Content cross-fades in
// sync with the size change so the whole thing reads as one living surface.
struct NotchView: View {
    @ObservedObject var model: NotchModel

    private var size: NSSize { model.size(for: model.state) }
    private var radius: CGFloat {
        switch model.state {
        case .idle:  return Theme.idleRadius
        case .peek:  return Theme.peekRadius
        case .panel: return Theme.panelRadius
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            shape
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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
                .shadow(color: .black.opacity(model.state == .idle ? 0.25 : 0.45),
                        radius: model.state == .idle ? 6 : 18, y: 6)

            content
                .padding(.horizontal, model.state == .panel ? 20 : 14)
                .padding(.vertical, model.state == .panel ? 16 : 8)
        }
        .frame(width: size.width, height: size.height)
        .animation(Theme.morph, value: model.state)
        .animation(Theme.morph, value: model.attention)
        .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
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
        case .idle:  break
        case .peek:  model.emit(.tap)          // main decides → sends setState:panel
        case .panel: break                      // taps inside handled by PanelView
        }
    }
}
