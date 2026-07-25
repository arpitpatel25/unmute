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

// MARK: - Small shared components

/// Status dot (the one color variable).
struct Dot: View {
    let status: TaskStatus
    var size: CGFloat = 8
    var body: some View {
        Circle().fill(Theme.status(status)).frame(width: size, height: size)
    }
}

/// Tiny mono badge ("Q1", "↳ agent", "↑ now a session", "unmute").
struct Badge: View {
    let text: String
    var color: Color = Theme.textFaint
    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
            .foregroundColor(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(color.opacity(0.45), lineWidth: 1))
    }
}

/// Stage-header key button ("kill", "resume", "next", …).
struct KeyButton: View {
    let label: String
    var danger: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(danger ? Theme.cError : Theme.text)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 7)
                    .stroke(danger ? Theme.cError.opacity(0.35) : Color.white.opacity(0.12), lineWidth: 1))
        }.buttonStyle(.plain)
    }
}

/// Action button on the task surface / dead panel.
struct ActButton: View {
    let label: String
    var danger: Bool = false
    var go: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 13, weight: go ? .semibold : .regular))
                .foregroundColor(go ? Color(red: 0.14, green: 0.09, blue: 0.01) : (danger ? Theme.cError : Theme.text))
                .padding(.horizontal, 13).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 9)
                    .fill(go ? Theme.accent : Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 9)
                    .stroke(go ? Theme.accent : (danger ? Theme.cError.opacity(0.4) : Color.white.opacity(0.12)), lineWidth: 1))
        }.buttonStyle(.plain)
    }
}

/// Rendered markdown (result detail); graceful plain-text fallback.
struct MarkdownText: View {
    let text: String
    var body: some View {
        if let attr = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attr).font(.system(size: 13)).foregroundColor(Theme.textDim)
        } else {
            Text(text).font(.system(size: 13)).foregroundColor(Theme.textDim)
        }
    }
}
