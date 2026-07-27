import SwiftUI

// The surface shape: square top corners flush to the screen's top edge, only
// the bottom corners round. (The earlier concave "shoulder" fillets were cut —
// on wide surfaces they read as notches carved out of the top border.)
struct NotchShape: Shape {
    var bottomRadius: CGFloat

    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let br = min(bottomRadius, rect.width / 2, rect.height)
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - br, y: rect.maxY),
                       control: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + br, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - br),
                       control: CGPoint(x: rect.minX, y: rect.maxY))
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

/// Dense control — the default. Rounded rect, 7pt.
struct KeyButton: View {
    let label: String
    var danger: Bool = false
    var symbol: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).font(.system(size: 10.5, weight: .medium)) }
                Text(label).font(Theme.fSub)
            }
            .foregroundColor(danger ? Theme.cError : Theme.text)
            .padding(.horizontal, 11).padding(.vertical, 4.5)
            .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(hovering ? Theme.raisedHover : Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .stroke(danger ? Theme.cError.opacity(0.30) : Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

/// Large control — capsule. `go` marks the ONE primary action on a surface and
/// is the only thing that carries the accent tint.
struct ActButton: View {
    let label: String
    var danger: Bool = false
    var go: Bool = false
    var symbol: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .semibold)) }
                Text(label).font(.system(size: 13, weight: go ? .semibold : .regular))
            }
            // The primary's fill is near-white, so its label is dark.
            .foregroundColor(go ? Theme.accentInk : (danger ? Theme.cError : Theme.text))
            .padding(.horizontal, 16).padding(.vertical, 6)
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
        .help("Close (esc)")
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

    var body: some View {
        if let attr = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attr).font(.system(size: size)).foregroundColor(color)
        } else {
            Text(text).font(.system(size: size)).foregroundColor(color)
        }
    }
}

// RichText (inline-markdown body text at conversation scale) lives in
// ConversationPanel.swift — it is the transcript's primary text component and
// is styled alongside the blocks it serves.
