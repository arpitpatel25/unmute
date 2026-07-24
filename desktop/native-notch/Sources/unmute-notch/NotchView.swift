import SwiftUI

// The one morphing surface. A single NotchShape fills the window (sized per
// state, top-pinned by AppController); content swaps by state — never a second
// window, never a crossfade of sibling surfaces.
struct NotchView: View {
    @ObservedObject var model: NotchModel
    /// Content inset that clears the physical notch / menu bar (display safety:
    /// no control ever renders under the camera housing).
    let topInset: CGFloat

    var body: some View {
        let sh = NotchShape(bottomRadius: Theme.radius(for: model.state))
        ZStack {
            sh.fill(expanded ? Theme.fillElevated : Theme.fill)
            sh.stroke(borderColor, lineWidth: model.state == .attention ? 1.5 : 1)
            content
            if model.proposal != nil || model.proposalLoadingId != nil {
                SkillPopupView(model: model)
            }
            if let toast = model.toast {
                VStack { Spacer()
                    Text(toast)
                        .font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.text)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Color(white: 0.09)))
                        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.16), lineWidth: 1))
                        .padding(.bottom, 14)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.all)
        .contentShape(sh)
        .onTapGesture { if !expanded { model.emit(.tap) } }
        .animation(Theme.morph, value: model.state)
    }

    private var expanded: Bool { model.state == .task || model.state == .cockpit }

    private var borderColor: Color {
        if model.state == .attention { return Theme.accent }
        if model.state == .dormant { return .clear }
        return Theme.hairline
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .dormant, .idle:
            EmptyView()
        case .active:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).frame(width: 12, height: 12)
                Spacer(minLength: 0)
                Text(model.working == 1 ? "1 running" : "\(model.working) running")
                    .font(.system(size: 12, weight: .medium)).foregroundColor(Theme.textDim)
            }
            .padding(.horizontal, 14)
        case .attention:
            HStack(spacing: 9) {
                Circle().fill(Theme.accent).frame(width: 7, height: 7)
                Text(attentionLabel)
                    .font(.system(size: 12, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
                Spacer(minLength: 0)
                if model.attention > 1 {
                    Text("\(model.attention)")
                        .font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.textDim)
                }
            }
            .padding(.horizontal, 14)
        case .task:
            TaskSurfaceView(model: model, topInset: topInset)
        case .cockpit:
            if model.focusedId != nil {
                StageView(model: model, topInset: topInset)
            } else {
                WallView(model: model, topInset: topInset)
            }
        }
    }

    private var attentionLabel: String {
        guard let t = model.task else { return "Something needs you" }
        switch t.status {
        case .needsUser: return t.title
        case .stuck:     return "Stuck: \(t.title)"
        case .failed:    return "Failed: \(t.title)"
        case .ready:     return "Ready: \(t.title)"
        default:         return t.title
        }
    }
}
