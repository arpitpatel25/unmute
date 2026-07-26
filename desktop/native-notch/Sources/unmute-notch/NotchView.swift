import SwiftUI

// The one morphing surface. A single NotchShape fills the window (sized per
// state, top-pinned by AppController); content swaps by state — never a second
// window, never a crossfade of sibling surfaces.
//
// The layer split (see Theme):
//   * SMALL states (dormant/idle/active/attention) are pure chrome — nothing
//     behind them but wallpaper — so they are WHOLLY GLASS and their content
//     sits directly on the material.
//   * LARGE states (task/cockpit) are a glass SHELL around an OPAQUE PLANE.
//     Every card, terminal and transcript lives on the plane, never on glass.
struct NotchView: View {
    @ObservedObject var model: NotchModel
    /// Content inset that clears the physical notch / menu bar (display safety:
    /// no control ever renders under the camera housing).
    let topInset: CGFloat

    var body: some View {
        let sh = NotchShape(bottomRadius: Theme.radius(for: model.state))
        ZStack {
            GlassSurface(
                shape: sh,
                state: model.state,
                rimHighlight: rimHighlight,
                rimWidth: model.state == .attention ? 1.5 : 1,
                tint: materialTint
            )
            content
            if model.proposal != nil || model.proposalLoadingId != nil {
                SkillPopupView(model: model)
            }
            if let toast = model.toast { toastView(toast) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.all)
        .contentShape(sh)
        .onTapGesture { if !expanded { model.emit(.tap) } }
        // Hover: wake dormant → idle (AppController owns the ladder) and show a
        // pointing hand on the small states so the surface reads as clickable.
        .onHover { hovering in
            model.onHover(hovering)
            if hovering && !expanded { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
        }
        .animation(Theme.morph, value: model.state)
    }

    private var expanded: Bool { model.state == .task || model.state == .cockpit }

    /// The sanctioned use of tint: a state that genuinely needs the user tints
    /// the WHOLE material, so it reads as one object rather than a black bar
    /// with a coloured pip on it. Apple's tinting maps a tone range to the
    /// brightness underneath, so it stays legible on any wallpaper.
    private var materialTint: Color? {
        model.state == .attention ? Theme.cNeeds : nil
    }

    /// Tint for the specular rim. The rim's SHAPE (bright top, dead sides,
    /// bright lip) is fixed in Glass.rim — this only chooses its hue.
    private var rimHighlight: Color {
        if model.state == .attention { return Theme.cNeeds }
        // A real hardware notch needs no outline; on a dummy notch the resting
        // sliver must be FINDABLE (field feedback: pure black on a dark
        // wallpaper was invisible).
        if model.state == .dormant && model.hasNotch { return .clear }
        return .white
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .dormant:
            EmptyView()

        case .idle:
            // The invitation: hovering woke it, so say who it is. (Suppressed on
            // hardware notches — text would sit under the camera housing.)
            if !model.hasNotch {
                HStack(spacing: 8) {
                    Text("unmute").font(Theme.fCap).fontWeight(.semibold).foregroundColor(Theme.text)
                    if model.working > 0 {
                        Text(model.working == 1 ? "1 running" : "\(model.working) running")
                            .font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                    }
                }
            }

        case .active:
            // NO SPINNER. A ProgressView is motion that pulls the eye at exactly
            // the moment the philosophy says to leave the user alone. The dot
            // breathes instead — informative, never a pull.
            HStack(spacing: 9) {
                Dot(status: .processing, size: 7, breathing: true)
                Text(model.working == 1 ? "1 running" : "\(model.working) running")
                    .font(Theme.fCap).foregroundColor(Theme.text)
                Spacer(minLength: 0)
                if let e = model.task?.elapsed { NumText(text: e) }
            }
            .padding(.horizontal, 15)

        case .attention:
            HStack(spacing: 9) {
                Dot(status: model.task?.status ?? .needsUser, size: 7)
                Text(attentionLabel)
                    .font(Theme.fSub).foregroundColor(Theme.text).lineLimit(1)
                Spacer(minLength: 0)
                if model.attention > 1 {
                    Badge(text: "\(model.attention)", color: Theme.cNeeds)
                }
            }
            .padding(.leading, 15).padding(.trailing, 10)

        case .task:
            plane { TaskSurfaceView(model: model, topInset: topInset) }

        case .cockpit:
            plane {
                if model.focusedId != nil {
                    StageView(model: model, topInset: topInset)
                } else {
                    WallView(model: model, topInset: topInset)
                }
            }
        }
    }

    /// The opaque content plane inside the glass shell.
    ///
    /// CONCENTRIC by construction: the plane's radius is the panel's minus the
    /// padding (18 − 6 = 12), so the two curves share a centre and nest without
    /// the optical pinch you get from two independently-chosen radii.
    @ViewBuilder private func plane<Content: View>(@ViewBuilder _ body: () -> Content) -> some View {
        body()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: Theme.planeRadius).fill(Theme.plane))
            .clipShape(RoundedRectangle(cornerRadius: Theme.planeRadius))
            .padding(Theme.panelPadding)
    }

    private func toastView(_ toast: String) -> some View {
        VStack {
            Spacer()
            Text(toast)
                .font(Theme.fSub).foregroundColor(Theme.text)
                .padding(.horizontal, 15).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.raisedHover))
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
                    .stroke(Theme.hairline, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
                .padding(.bottom, 18)
        }
    }

    private var attentionLabel: String {
        guard let t = model.task else { return "Something needs you" }
        switch t.status {
        case .needsUser: return t.question?.text ?? t.title
        case .stuck:     return "Stuck — \(t.title)"
        case .failed:    return "Errored — \(t.title)"
        case .ready:     return "Ready — \(t.title)"
        default:         return t.title
        }
    }
}
