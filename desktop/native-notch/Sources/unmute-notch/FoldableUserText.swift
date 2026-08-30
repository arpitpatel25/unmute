import SwiftUI
import ConversationSupport

/// THE USER'S OWN MESSAGE, CAPPED — shown whole when it fits, folded with a
/// fade when it does not, and given back on a tap.
///
/// A dictated request runs long. Rendered in full it pushes the answer off the
/// screen, so a thread reads as a wall of your own words with the reply
/// somewhere below the fold — and in the notch, where the panel is short,
/// there is often no way to see both at once.
///
/// SHARED BY BOTH BUBBLES ON PURPOSE. There are two user bubbles — this
/// surface's and the block conversation's — and the last time one of them
/// gained a fix the other silently kept the bug for a month (5b0ff42 fixed
/// UserBubble's colour; BlockUserBubble kept its literal until 75bab29). One
/// component means the next change cannot land on only half the app.
///
/// WHY THE MEASUREMENT CANNOT FEED BACK. This view reads a height and then
/// changes a height, which is the shape that froze a core once already (see
/// BottomProximity). It is safe because the height it reads comes from a
/// HIDDEN COPY that always renders in full: folding the visible text cannot
/// change the measured text, so the input is constant with respect to the
/// decision it drives. The dead zone in `userTextOverflows` is the second
/// belt.
struct FoldableUserText: View {
    let text: String
    var lineSpacing: CGFloat = 0

    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0

    /// Only ever true once a real measurement has arrived — see the guard in
    /// `userTextOverflows`, which refuses to fold on a height it does not have.
    private var overflows: Bool { userTextOverflows(fullHeight: fullHeight) }
    private var folded: Bool { overflows && !expanded }

    var body: some View {
        body(of: text)
            .frame(maxHeight: folded ? userBubbleMaxHeight : nil, alignment: .top)
            .clipped()
            // A MASK, NOT A GRADIENT OVERLAY. The bubble fill is translucent
            // white over the panel, so a gradient painted INTO that colour
            // would leave the text showing through and draw a band of its own.
            // Fading the text's alpha to nothing reveals whatever is actually
            // behind it, in either surface tone, with no colour to keep in step.
            .mask(folded ? AnyView(fadeMask) : AnyView(Rectangle()))
            .overlay(alignment: .bottomTrailing) { if overflows { hint } }
            // The hidden copy that does the measuring. It takes the same width
            // as the visible text and its OWN ideal height, which is the number
            // the fold decision needs and the one folding cannot change.
            .background(measuringCopy)
            .onPreferenceChange(UserTextHeightKey.self) { fullHeight = $0 }
            .contentShape(Rectangle())
            // Simultaneous, so it coexists with text selection rather than
            // competing with it — a drag still selects, a click still expands.
            .simultaneousGesture(TapGesture().onEnded {
                guard overflows else { return }
                withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() }
            })
            .help(folded ? "Show the whole message" : (overflows ? "Collapse" : ""))
            .animation(.easeOut(duration: 0.18), value: folded)
    }

    private func body(of value: String) -> some View {
        Text(value)
            .font(.system(size: 14))
            .foregroundColor(Theme.text)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            // NO maxWidth HERE. The bubble hugs its content — a three-word
            // message is a small bubble, and forcing the full column would
            // turn every one of them into a banner.
            .textSelection(.enabled)
    }

    private var fadeMask: some View {
        LinearGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .black,
                      location: max(0, 1 - userBubbleFadeHeight / userBubbleMaxHeight)),
                .init(color: .black.opacity(0), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    /// Small, quiet, and only when there IS something underneath — the fade
    /// says "more"; this says what to do about it.
    private var hint: some View {
        Image(systemName: folded ? "chevron.down" : "chevron.up")
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(Theme.textFaint)
            .padding(.trailing, 2)
            .allowsHitTesting(false)
    }

    private var measuringCopy: some View {
        Text(text)
            .font(.system(size: 14))
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { geo in
                Color.clear.preference(key: UserTextHeightKey.self, value: geo.size.height)
            })
            .hidden()
            .allowsHitTesting(false)
    }
}

private struct UserTextHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    /// MAX, NOT LAST — and this is why the fold did not work when it shipped.
    ///
    /// Only the measuring copy publishes a real height; every other subview in
    /// the stack (the mask, the overlaid hint, the clipped body) contributes
    /// the DEFAULT of zero. `value = nextValue()` keeps whichever reduces last,
    /// so a zero from a sibling overwrote the measurement and `fullHeight` sat
    /// at 0 — which `userTextOverflows` correctly reads as "not measured yet"
    /// and refuses to fold on. The bubble therefore never folded, however long
    /// the message was.
    ///
    /// Taking the maximum makes the answer independent of reduce ORDER, which
    /// is the only safe way to combine a measurement with siblings that have
    /// nothing to say.
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
