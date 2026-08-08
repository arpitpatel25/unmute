import SwiftUI

// THE ONE MORPHING SURFACE. A single NotchShape fills the window (sized and
// positioned per state by AppController); content swaps by state — never a
// second window, never a crossfade of sibling surfaces.
//
// THE MATERIAL SPLIT (decision D5):
//
//   * BAR LEVEL (dormant/idle/active/attention) is OPAQUE BLACK, ALWAYS. The
//     mass impersonates the physical cutout, and the physical cutout is opaque.
//     Any translucency breaks the illusion at exactly the join the single-path
//     shape exists to remove — a glass mass would show the wallpaper where the
//     housing shows nothing, and the seam would appear precisely at the middle.
//     The Fixed / Live glass / Follow system setting does not reach this
//     surface. It also sidesteps the macOS 26.2 glass-caching bug for the one
//     surface that could not tolerate it.
//
//   * EXPANDED (task/cockpit) is the glass shell around an opaque content
//     plane, and it is where the appearance setting still applies in full.
//
// There is NO rim on the bar-level mass. A stroke around it would outline the
// black against the housing and put back the join by another route.
struct NotchView: View {
    @ObservedObject var model: NotchModel
    /// Content inset that clears the physical cutout / menu bar on the EXPANDED
    /// surfaces (display safety: no control ever renders under the housing).
    let topInset: CGFloat

    /// System Settings → Accessibility → Display → Reduce motion. When it is on
    /// the surface still changes; it simply stops springing.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            surface
            content
            // BOTH OF THESE NEED ROOM, AND THE BAR HAS NONE.
            //
            // The unexpanded surface is exactly menu-bar height now, so a review
            // popup or a toast drawn there would be clipped to a sliver — it was
            // already being clipped by the old 34pt strip, silently. They are
            // drawn only where they fit, and AppController logs the ones that
            // arrive with nowhere to go (see showToast) rather than leaving a
            // message that simply never appeared.
            if expanded {
                if model.proposal != nil || model.proposalLoadingId != nil {
                    // CLEARS THE CUTOUT LIKE EVERY OTHER LARGE SURFACE. This is
                    // drawn OUTSIDE `plane`, so it never received the inset the
                    // task view and the wall get, and its root VStack is
                    // top-anchored with 13pt of padding — on a notched Mac the
                    // housing would eat its header, exactly as it ate the
                    // pocket's title row.
                    //
                    // Found by audit, not by a bug report, and it could not have
                    // been found by use: the skill curator is PARKED, so this
                    // view never renders today. It would have broken on the day
                    // the curator came back, on hardware we cannot test, months
                    // from the change that caused it.
                    SkillPopupView(model: model)
                        .padding(.top, topInset)
                }
                if let toast = model.toast { toastView(toast) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.all)
        .contentShape(shape)
        // CLICK OPENS. Hover never does — see .onHover below.
        // CLICK OPENS — and what it opens is whatever is being held.
        //
        // Tapping a notch that says "3 in your pocket" and getting the task
        // surface would be answering a different question than the one the
        // surface just asked. A tap on the pocket opens the pocket; a tap on
        // the open pocket is handled by its own controls, not here.
        .onTapGesture {
            guard !expanded else { return }
            if model.pocket.isOpen { return }
            model.emit(model.pocket.taskCount > 0 ? .pocketOpen : .tap)
        }
        // HOVER REVEALS, AND THAT IS ALL IT DOES.
        //
        // It grows the mass a little and adds one more level of detail
        // (AppController.handleHover → BarContent.make). It does not open the
        // panel and must never be made to: the menu bar is somewhere the
        // pointer passes through constantly, and a panel that opens on approach
        // becomes something the user fights. This is the main usability failure
        // of NotchNook and its imitators.
        .onHover { hovering in
            model.onHover(hovering)
            if hovering && !expanded { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
        }
        // NO `.animation(_:value: model.state)` HERE.
        //
        // An explicit .animation modifier OVERRIDES the ambient transaction for
        // its whole subtree, so it silently beat the withAnimation in
        // AppController.applyState — the frame moved on one curve while the
        // content was still governed by another. AppController is the single
        // timing authority: every mutation of model.state carries its own
        // animation, matched to the window's by construction (Theme.morph and
        // Theme.springSolver are the same two numbers).
    }

    private var expanded: Bool { model.state == .task || model.state == .cockpit }

    /// The shape, from the placement the controller resolved. Both radii are
    /// animatable, so the fillets travel with the mass instead of being pinned
    /// on top of it.
    private var shape: NotchShape {
        NotchShape(bottomRadius: model.bar.bottomRadius, topFillet: model.bar.fillet)
    }

    // MARK: - Material

    @ViewBuilder private var surface: some View {
        if expanded {
            // ONE MATERIAL, EVERYWHERE. The large surfaces used to be a separate
            // one — Theme.plane, a dark blue-grey, under a white 1pt rim — while
            // the bar and the pocket are pure black because they continue the
            // hardware. Side by side that reads as two apps: the pocket sits in
            // true black with its cards floating on it, and the dashboard is a
            // grey panel in a white outline.
            //
            // Black is also what makes the cards work. `Theme.raised` is white
            // at 5.5%; on black it reads as the soft grey-black the pocket has,
            // and on Theme.plane it is nearly invisible. The card treatment was
            // always designed against this ground.
            //
            // Edge definition is the drop shadow's job now (GlassSurface's own
            // note says as much) plus the faintest hairline — enough to hold the
            // corner against a black wallpaper, far below reading as a border.
            shape.fill(Color.black)
                .overlay(shape.stroke(Theme.hairlineSoft, lineWidth: 0.5))
        } else if model.content.resting {
            restingNub
        } else if model.state == .dormant {
            // DORMANT DRAWS NOTHING VISIBLE.
            //
            // On a notched display the window is the cutout, so filling it black
            // adds no pixel the user can see — those pixels are behind the
            // housing — while keeping a target the pointer can find, which is
            // the gesture people already know. On a display with no cutout there
            // is nothing to hide behind, so nothing is drawn at all.
            if model.hasNotch { shape.fill(Color.black) }
        } else {
            // D5: opaque, always. Pure black, because the hardware it continues
            // is pure black and any other value shows up as a seam at the join.
            shape.fill(Color.black)
                .overlay(alarmGlow)
        }
    }

    /// THE RESTING NUB — off-notch idle, pointer elsewhere.
    ///
    /// DRAWN SMALL, HIT BIG. The window stays a full menu-bar tall, so the
    /// pointer target is unchanged and hovering still wakes it; only the ink
    /// shrinks. Shrinking the window instead would have made the one thing this
    /// state exists for — being findable — harder.
    ///
    /// Not pure black either. D5 makes the mass opaque because it is
    /// impersonating the hardware notch, and at rest on a screen with no cutout
    /// there is no hardware to match: a full-strength black tab reads as a badge
    /// stuck to the desktop. Softened, it reads as part of the bezel.
    @ViewBuilder private var restingNub: some View {
        VStack(spacing: 0) {
            NotchShape(bottomRadius: Self.restRadius, topFillet: Self.restFillet)
                .fill(Color.black.opacity(0.55))
                .frame(height: Self.restHeight)
            Spacer(minLength: 0)
        }
    }

    /// Tall enough to see on a light desktop, short enough to ignore.
    static let restHeight: CGFloat = 7
    static let restRadius: CGFloat = 4
    static let restFillet: CGFloat = 3

    /// THE ONLY GLOW IN THE APP.
    ///
    /// Attention is the one state that gets it: if everything glows, nothing
    /// does. It is an INNER glow, drawn along the inside of the path, because a
    /// drop shadow would have to hang below the menu bar — and nothing hangs
    /// below the bar unless the surface is expanded. The mass itself stays
    /// black (D5); the amber arrives as the dot, the words and this rim.
    ///
    /// GATED ON THE RENDERED STATE ONLY. It used to be gated on the commanded
    /// one as well, to stop attention's colour surviving into a task frame
    /// mid-morph. That guard is now structural — this whole branch is only
    /// reached when the surface is at bar level, and an expanded surface draws
    /// glass instead — and keeping it did real harm: with auto-present off,
    /// `commandedState` holds the expanded rung the engine asked for while the
    /// surface is deliberately held at attention, so the one state that must
    /// glow was the one state that did not.
    @ViewBuilder private var alarmGlow: some View {
        // A BORDER, NOT A GLOW.
        //
        // This was a 2.5pt status-coloured stroke blurred to 3.5 and laid under
        // a second coloured stroke — on a 26pt bar that is a wash of orange
        // across the whole surface, not an accent on it. The state is already
        // said by the dot and by the words; the edge only has to agree with
        // them, quietly.
        if model.state == .attention, let status = model.content.alarm {
            shape.stroke(Theme.status(status).opacity(0.7), lineWidth: 1)
                .clipShape(shape)
                .allowsHitTesting(false)
        }
    }

    // MARK: - Content

    // CONTAINER MORPHS, CONTENT CROSS-FADES, AND THEY ARE OFFSET.
    //
    // Keyed on the state so leaving and arriving are separate events: the old
    // content goes fast and EARLY, before the shape has finished, and the new
    // content arrives after it has committed to its size. Cross-fading in
    // lockstep with the resize looks like two views swapping. Offsetting them
    // looks like one thing becoming another.
    //
    // Under Reduce Motion both halves collapse to the same short fade with no
    // offset — an offset is itself motion.
    @ViewBuilder private var content: some View {
        Group {
            if expanded { expandedContent }
            // THE POCKET, OPEN. Not a rung of its own — it lives between the bar
            // and the panel, so it borrows the bar's states and changes only
            // what is drawn. An expanded task outranks it: you are already
            // looking at one address, and a card naming a second would be two
            // answers to the same question.
            else if model.pocket.isOpen {
                pocketPlane { PocketCard(model: model, listening: model.capturePhase == "listening") }
            }
            else { barRow }
        }
        // The pocket opening is a content swap the state alone cannot express,
        // so it has to take part in the identity or the transition never runs.
        .id("\(model.state.rawValue)-\(model.pocket.isOpen)")
        .transition(.asymmetric(
            insertion: .opacity.animation(reduceMotion ? Theme.reducedFade : Theme.contentIn),
            removal:   .opacity.animation(reduceMotion ? Theme.reducedFade : Theme.contentOut)))
    }

    /// The bar row: left half · the cutout (or a gap) · right half.
    ///
    /// The middle is EMPTY by construction. Nothing readable may sit there —
    /// on a notched display there is no screen behind it — and the mass is
    /// drawn straight through it by the shape, not by anything here.
    private var barRow: some View {
        HStack(spacing: 0) {
            leftHalf
                .frame(width: model.bar.left, alignment: .leading)
                .clipped()
            Color.clear.frame(width: model.bar.middle)
            rightHalf
                .frame(width: model.bar.right, alignment: .trailing)
                .clipped()
        }
        // The fillets are part of the path and they eat into the rect, so the
        // content is inset by exactly as much as they take.
        .padding(.horizontal, model.bar.fillet)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var leftHalf: some View {
        let c = model.content
        if c.dot != nil || c.left != nil {
            HStack(spacing: BarContent.gap) {
                if let d = c.dot {
                    Dot(status: d, size: BarContent.dotSize, breathing: d == .processing)
                }
                // THE IDENTITY IS THE MARK, NOT THE WORD. Idle used to set
                // "unmute" in 9.5pt light type, which on a black bar reads as a
                // small grey label rather than as us.
                if c.emphasis == .wordmark {
                    // Not tinted with `leftInk`: the mark carries the brand's own
                    // colours and must not shift with the bar's state.
                    UnMark(height: BarContent.markHeight)
                } else if let t = c.left {
                    Text(t)
                        .font(.system(size: BarContent.statusSize, weight: .medium))
                        .foregroundColor(leftInk)
                        // NEVER TRUNCATES. The left half carries status, is short
                        // by construction, and is the last thing that may be cut.
                        .fixedSize()
                }
                if let b = c.badge, b > 1 {
                    Badge(text: "\(b)", color: Theme.status(c.alarm ?? c.dot ?? .needsUser))
                }
            }
            .padding(.leading, BarContent.inset)
        }
    }

    @ViewBuilder private var rightHalf: some View {
        if let t = model.content.right, !t.isEmpty, model.bar.right > 0 {
            Text(t)
                .font(.system(size: BarContent.detailSize))
                .foregroundColor(model.state == .attention ? Theme.text : Theme.textDim)
                // Truncates first, and only ever here. Below the width at which
                // it could say something useful it is not drawn at all — the
                // controller has already set `bar.right` to zero.
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.trailing, BarContent.inset)
        }
    }

    private var leftInk: Color {
        let c = model.content
        // The MARK, not a word. 0.52 was tuned for 9.5pt light type, where a
        // dim grey reads as restraint; at that value a drawn glyph just looks
        // smudged. The identity should be legible without being loud.
        if c.emphasis == .wordmark { return Color.white.opacity(model.working > 0 ? 0.92 : 0.85) }
        if let alarm = c.alarm { return Theme.status(alarm) }
        return Theme.text
    }

    @ViewBuilder private var expandedContent: some View {
        switch model.state {
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
        default:
            EmptyView()
        }
    }

    /// The opaque content plane inside the glass shell.
    ///
    /// CONCENTRIC by construction: the plane's radius is the panel's minus the
    /// padding (18 − 6 = 12), so the two curves share a centre and nest without
    /// the optical pinch you get from two independently-chosen radii. The
    /// horizontal padding also clears the concave fillets, which take their
    /// width out of the same rect.
    @ViewBuilder private func plane<Content: View>(@ViewBuilder _ body: () -> Content) -> some View {
        body()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: Theme.planeRadius).fill(Theme.plane))
            .clipShape(RoundedRectangle(cornerRadius: Theme.planeRadius))
            .padding(.vertical, Theme.panelPadding)
            .padding(.horizontal, Theme.panelPadding + model.bar.fillet)
    }

    /// THE POCKET'S PLANE, HELD CLEAR OF THE CAMERA HOUSING.
    ///
    /// The pocket used `plane`, which insets uniformly — a few points on every
    /// side. On a notchless display that is right and the card hangs neatly from
    /// the top. On a MacBook with a cutout those few points are nowhere near
    /// enough: the housing is ~34pt tall and lands squarely on the card's title
    /// row and its buttons.
    ///
    /// Two things went wrong there, and only one of them was the missing text.
    /// The grey plane is a DIFFERENT MATERIAL from the black around it, so where
    /// it passed behind the housing it simply stopped being displayed — taking
    /// chunks of its own rounded corners and hairline with it. That is the
    /// chopped, uneven border reported from the field: not a drawing fault, a
    /// second rounded shape competing with a physical one.
    ///
    /// The answer is NOT to cut this plane around the cutout. NotchShape's own
    /// notes rule that out — "two wings can never look right" — and the black
    /// surface beneath already runs straight through the hole, invisibly,
    /// because it is the same colour as the housing. What must stay clear of it
    /// is anything that ISN'T that black: this plane, and the content on it.
    ///
    /// So the top inset becomes the cutout's height plus breathing room, which
    /// is exactly the number the task surface and the wall already take. The
    /// pocket is the one large surface that was never handed it.
    @ViewBuilder private func pocketPlane<Content: View>(@ViewBuilder _ body: () -> Content) -> some View {
        body()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: Theme.planeRadius).fill(Theme.plane))
            .clipShape(RoundedRectangle(cornerRadius: Theme.planeRadius))
            .padding(.top, topInset)
            .padding(.bottom, Theme.panelPadding)
            .padding(.horizontal, Theme.panelPadding + model.bar.fillet)
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
}
