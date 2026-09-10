import SwiftUI

// THE SURFACE IS ONE SHAPE, AND IT IS DRAWN STRAIGHT THROUGH THE CUTOUT.
//
// On a notched display the mass spans left content · the camera housing · right
// content as a SINGLE path. There is no second view, no pair of wings butted
// against the hardware. Two wings can never look right: the cutout is rounded
// on BOTH of its bottom corners, so anything placed beside it leaves a
// bitten-out curve exactly where the join has to be invisible. Drawing across
// the hole costs nothing — those pixels are not displayed, and the surface and
// the housing are the same black — and it removes the join entirely.
//
// The path therefore knows nothing about the cutout. The controller positions
// the window so the mass's middle sits over it (NotchGeometry.barFrame) and the
// view leaves that middle empty (NotchView.barRow). The shape just runs
// through.
//
// TWO KINDS OF CORNER, and both belong to this path:
//
//   * BOTTOM OUTER — convex, `bottomRadius`, matching the radius macOS uses on
//     the cutout's own bottom corners. Only the outer two: the middle, where
//     the mass crosses the housing, is dead straight.
//
//   * TOP OUTER — CONCAVE, `topFillet`. Where the mass meets the menu bar the
//     black flares OUTWARD in a quarter circle instead of stopping at a right
//     angle. This inverted curve is what separates a surface that belongs to
//     the screen from one pasted on top of it.
//
// The fillets are PART OF THE PATH, deliberately, and not an overlay view. An
// overlay at a fixed size visibly detaches from a mass that is springing to a
// new width — mid-motion, which is exactly when the eye is tracking it. Being
// path geometry they are interpolated by `animatableData` along with the
// radius, so they travel with the shape by construction rather than by anyone
// remembering to keep them in step.
//
// The fillets live INSIDE the rect: the mass body is the rect inset by
// `topFillet` on each side, and the flare fills that inset back out at the top.
// So a caller sizes the window to `body + 2 × fillet` and pads its content by
// `fillet` — see MassPlacement.width.
struct NotchShape: Shape {
    /// Convex radius on the two OUTER bottom corners.
    var bottomRadius: CGFloat
    /// Concave radius where the top of the mass flares out into the menu bar.
    var topFillet: CGFloat
    /// Vertical depth of that flare. Usually equal to `topFillet`; nested
    /// planes keep this aligned with the shell while widening the flare to
    /// leave the side rail visible.
    var topFilletDepth: CGFloat
    init(bottomRadius: CGFloat, topFillet: CGFloat = 0, topFilletDepth: CGFloat? = nil) {
        self.bottomRadius = bottomRadius
        self.topFillet = topFillet
        self.topFilletDepth = topFilletDepth ?? topFillet
    }

    /// BOTH radii animate. A fillet that held still while the radius moved
    /// would be the overlay bug wearing a different hat.
    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(bottomRadius, AnimatablePair(topFillet, topFilletDepth)) }
        set {
            bottomRadius = newValue.first
            topFillet = newValue.second.first
            topFilletDepth = newValue.second.second
        }
    }

    func path(in rect: CGRect) -> Path {
        // Nothing may exceed half the width or the whole height: a mass narrower
        // than its own corners is the collapse animation's last frame, and it
        // must degenerate cleanly rather than fold inside out.
        let f = max(min(topFillet, rect.width / 2), 0)
        let depth = max(min(topFilletDepth, rect.height), 0)
        let body = rect.insetBy(dx: f, dy: 0)
        let br = max(min(bottomRadius, body.width / 2, max(body.height - depth, 0)), 0)

        var p = Path()
        // Top-left, out on the menu bar, then the concave flare inward+down.
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: body.minX, y: rect.minY + depth),
                       control: CGPoint(x: body.minX, y: rect.minY))
        // Down the left wall to the bottom-left convex corner.
        p.addLine(to: CGPoint(x: body.minX, y: rect.maxY - br))
        p.addQuadCurve(to: CGPoint(x: body.minX + br, y: rect.maxY),
                       control: CGPoint(x: body.minX, y: rect.maxY))
        // The bottom edge — DEAD STRAIGHT across the cutout region.
        p.addLine(to: CGPoint(x: body.maxX - br, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: body.maxX, y: rect.maxY - br),
                       control: CGPoint(x: body.maxX, y: rect.maxY))
        // Up the right wall and out through the second flare.
        p.addLine(to: CGPoint(x: body.maxX, y: rect.minY + depth))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY),
                       control: CGPoint(x: body.maxX, y: rect.minY))
        // Closed along the screen's top edge, which is where the shape hangs
        // from. The top is always square: it shares an edge with the display.
        p.closeSubpath()
        return p
    }
}

// MARK: - Status

/// Status dot — the one colour variable.
///
/// `breathing` is for the WORKING state only. It is a slow opacity pulse and
/// never a spin or a scale: a spinner pulls the eye at exactly the moment the
/// product's whole thesis says to leave the user alone. Informative, not a pull.
struct Dot: View {
    let status: TaskStatus
    var size: CGFloat = 7
    var breathing: Bool = false

    @State private var dim = false

    var body: some View {
        Circle()
            .fill(Theme.status(status))
            .frame(width: size, height: size)
            .opacity(dim ? 0.42 : 1)
            .onAppear {
                guard breathing, status == .processing else { return }
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}

/// "Needs you" · "Working" — sentence case, semibold, in the status hue.
struct StatusLabel: View {
    let status: TaskStatus
    var body: some View {
        Text(Theme.statusLabel(status))
            .font(Theme.fStatus)
            .foregroundColor(Theme.status(status))
    }
}

// MARK: - Labels

/// A rail / section label: small, semibold, uppercase, tracked.
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(Theme.fMicro)
            .tracking(0.75)
            .foregroundColor(Theme.textFaint)
    }
}

/// Tabular data — ages, durations, counts, paths. The ONLY place monospace is
/// used outside the terminal.
struct NumText: View {
    let text: String
    var color: Color = Theme.textFaint
    var body: some View {
        Text(text)
            .font(Theme.fNum)
            .monospacedDigit()
            .foregroundColor(color)
    }
}

/// Small tinted pill ("group", "Q1", "agent", "unmute").
struct Badge: View {
    let text: String
    var color: Color = Theme.textDim
    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 5).fill(color.opacity(0.17)))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(color.opacity(0.26), lineWidth: 0.5))
            .fixedSize()
    }
}

// MARK: - Controls
//
// macOS shape rule (NOT the iOS one): mini/small/medium controls stay ROUNDED
// RECTANGLES for compact, high-density layouts; large controls become CAPSULES.
// Emphasis comes from grouping and one tinted primary — never from stacking
// extra borders and fills, which the new system explicitly asks us to remove.

/// Dense control — the default. Quiet enough to sit in a task toolbar without
/// turning every available action into a row of oversized pills.
struct KeyButton: View {
    let label: String
    var danger: Bool = false
    var symbol: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3.5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 9.5, weight: .medium)) }
                Text(label).font(.system(size: 11, weight: .medium))
            }
            .foregroundColor(danger ? Theme.cError : Theme.text)
            .padding(.horizontal, 9).padding(.vertical, 3.5)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(hovering ? Theme.raisedHover : Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6)
                .stroke(danger ? Theme.cError.opacity(0.30) : Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

/// Primary control. It remains the strongest action, but shares the compact
/// toolbar scale instead of becoming a large call-to-action inside the notch.
struct ActButton: View {
    let label: String
    var danger: Bool = false
    var go: Bool = false
    var symbol: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
                Text(label).font(.system(size: 11.5, weight: go ? .semibold : .medium))
            }
            // The primary's fill is near-white, so its label is dark.
            .foregroundColor(go ? Theme.accentInk : (danger ? Theme.cError : Theme.text))
            .padding(.horizontal, 12).padding(.vertical, 4.5)
            .background(
                Capsule().fill(go ? Theme.accent.opacity(hovering ? 0.86 : 1)
                                  : (hovering ? Theme.raisedHover : Theme.raised))
            )
            .overlay(
                Capsule().stroke(go ? Color.clear
                                    : (danger ? Theme.cError.opacity(0.32) : Theme.hairline),
                                 lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

/// A borderless control — for tertiary actions that should not compete.
struct QuietButton: View {
    let label: String
    var symbol: String? = nil
    var color: Color = Theme.textDim
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .medium)) }
                Text(label).font(.system(size: 11.5))
            }
            .foregroundColor(hovering ? Theme.text : color)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(hovering ? Theme.raised : Color.clear))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

/// Close the expanded surface.
///
/// Escape was once the ONLY way out of the cockpit and the task surface — fine
/// when you know it, invisible until then, and unavailable to anyone driving by
/// mouse. Every expanded surface carries this in the same corner.
/// Walks back out of whatever you drilled into — a stage, a review popup —
/// without closing the surface. Rendered only when `canGoBack`, because an
/// arrow that behaves like ✕ teaches people not to trust it.
struct BackButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(hovering ? Theme.text : Theme.textFaint)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.10 : 0.05)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Back")
        .animation(Theme.hover, value: hovering)
    }
}

struct CloseButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(hovering ? Theme.text : Theme.textFaint)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.10 : 0.05)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Close (esc, or click outside)")
        .animation(Theme.hover, value: hovering)
    }
}

// MARK: - Scroll edge effect
//
// The macOS-leaning HARD style: a stronger, more opaque boundary that keeps
// pinned headers and controls legible over content moving beneath them. Applied
// once per scroll view — never nested.
struct ScrollEdge: ViewModifier {
    var height: CGFloat = 26
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            LinearGradient(
                stops: [
                    .init(color: Theme.plane, location: 0),
                    .init(color: Theme.plane.opacity(0.9), location: 0.28),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: height)
            .allowsHitTesting(false)
        }
    }
}

extension View {
    /// One per scroll view. See ScrollEdge.
    func scrollEdge(_ height: CGFloat = 26) -> some View {
        modifier(ScrollEdge(height: height))
    }
}

// MARK: - Text

/// Rendered markdown (result detail); graceful plain-text fallback.
struct MarkdownText: View {
    let text: String
    var size: CGFloat = 13
    var color: Color = Theme.textDim

    /// BLOCK MARKERS ARE NOISE IN A TWO-LINE PREVIEW.
    ///
    /// The parser below is inlineOnly, which is the right choice here — a
    /// heading rendered at heading size would wreck a pocket row — but
    /// "preserving" means the `##` survives as characters, so a card whose
    /// first line was a heading read `## Yes, they're live` on screen
    /// (2026-09-08). Inline emphasis still renders; only the leading block
    /// marker goes, and only when it is followed by a space, so a `#tag` or a
    /// bare `-` is left alone.
    private static let blockMarker = try! NSRegularExpression(
        pattern: "^[ \\t]*(?:#{1,6}|>|[-*+]|\\d{1,3}[.)])[ \\t]+", options: [.anchorsMatchLines])

    private var stripped: String {
        let full = NSRange(text.startIndex..., in: text)
        return MarkdownText.blockMarker.stringByReplacingMatches(in: text, range: full, withTemplate: "")
    }

    var body: some View {
        let source = stripped
        if let attr = try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attr).font(.system(size: size)).foregroundColor(color)
        } else {
            Text(source).font(.system(size: size)).foregroundColor(color)
        }
    }
}

// RichText (inline-markdown body text at conversation scale) lives in
// ConversationPanel.swift — it is the transcript's primary text component and
// is styled alongside the blocks it serves.
