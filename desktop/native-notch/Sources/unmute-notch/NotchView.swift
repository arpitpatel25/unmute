import SwiftUI

// The one morphing surface. A single NotchShape fills the window (which is sized
// per state, top-pinned by AppController), and the content swaps by state. There
// is never a second view crossfaded in — it's one shape that grows and shrinks.
struct NotchView: View {
    @ObservedObject var model: NotchModel

    private var shapeParams: (bottom: CGFloat, shoulder: CGFloat) { Theme.shape(for: model.state) }

    var body: some View {
        let sh = NotchShape(bottomRadius: shapeParams.bottom, shoulder: shapeParams.shoulder)
        ZStack {
            sh.fill(model.state == .task || model.state == .cockpit ? Theme.fillElevated : Theme.fill)
            sh.stroke(borderColor, lineWidth: model.state == .attention ? 1.5 : 1)
            content
                .padding(.horizontal, contentPadH)
                .padding(.top, contentPadTop)
                .padding(.bottom, contentPadBottom)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.all)
        .contentShape(sh)                       // only the shape is clickable
        .onTapGesture { model.emit(.tap) }       // AppController owns the ladder
        .animation(Theme.morph, value: model.state)
    }

    private var borderColor: Color {
        if model.state == .attention { return Theme.accent }
        if model.state == .dormant { return .clear }
        return Theme.hairline
    }

    // Content sits below the physical notch on notched hardware; a smaller inset
    // otherwise. Filled from the model each state.
    private var contentPadH: CGFloat { (model.state == .task || model.state == .cockpit) ? 0 : 14 }
    private var contentPadTop: CGFloat {
        switch model.state {
        case .dormant, .idle: return 0
        case .active, .attention: return 4
        case .task, .cockpit: return 0
        }
    }
    private var contentPadBottom: CGFloat { model.state == .idle || model.state == .dormant ? 0 : 4 }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .dormant, .idle:
            EmptyView()
        case .active:
            HStack(spacing: 10) {
                ProgressView().scaleEffect(0.5).frame(width: 12, height: 12)
                Spacer(minLength: 0)
                Text(model.working == 1 ? "1 running" : "\(model.working) running")
                    .font(.system(size: 12, weight: .medium)).foregroundColor(Theme.textDim)
            }
        case .attention:
            HStack(spacing: 10) {
                Circle().fill(Theme.accent).frame(width: 7, height: 7)
                Text(attentionLabel).font(.system(size: 12, weight: .medium))
                    .foregroundColor(Theme.text).lineLimit(1)
                Spacer(minLength: 0)
                if model.attention > 1 {
                    Text("\(model.attention)").font(.system(size: 12, weight: .semibold))
                        .foregroundColor(Theme.textDim)
                }
            }
        case .task:
            TaskView(model: model)
        case .cockpit:
            CockpitView(model: model)
        }
    }

    private var attentionLabel: String {
        guard let t = model.task else { return "Something needs you" }
        switch t.state {
        case .needsUser: return t.title
        case .stuck:     return "Stuck: \(t.title)"
        case .errored:   return "Failed: \(t.title)"
        case .ready:     return "Ready: \(t.title)"
        }
    }
}
