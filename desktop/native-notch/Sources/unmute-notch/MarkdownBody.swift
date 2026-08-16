import SwiftUI
import ConversationSupport

/// Markdown rendered the way Codex renders it.
///
/// Every number here was MEASURED from the running Codex window over CDP on
/// 2026-08-16, not estimated from a screenshot — see §8a of the spec. Three
/// previous passes at this were eyeballed and all three were wrong.
///
///     body           14pt / 22 line-height, weight 445
///     h2             20pt / 28, weight 600
///     h4             16pt / 24, weight 445
///     bullets        disc then circle, 21pt indent, li padding-left 2
///     nested list    margin-top 8
///     list block     margin-bottom 10
///     inline code    12.88pt mono, white @ 12.6%, padding 1×6, radius 6
struct MarkdownBody: View {
    let text: String
    var size: CGFloat = 14
    var color: Color = Theme.text

    private var blocks: [MDBlock] { Markdown.blocks(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                row(block, isFirst: i == 0)
            }
        }
    }

    @ViewBuilder private func row(_ block: MDBlock, isFirst: Bool) -> some View {
        switch block {
        case .paragraph(let t):
            inline(t)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 10)

        case .bullet(let t, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(Markdown.marker(depth: depth))
                    .font(.system(size: size))
                    .foregroundColor(color)
                    .frame(width: 21, alignment: .leading)
                    .padding(.leading, CGFloat(depth) * 21)
                inline(t)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 2)

        case .ordered(let t, let n, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("\(n).")
                    .font(.system(size: size))
                    .foregroundColor(color)
                    .frame(width: 21, alignment: .leading)
                    .padding(.leading, CGFloat(depth) * 21)
                inline(t)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 2)

        case .heading(let t, let level):
            inline(t, size: level <= 2 ? 20 : 16, weight: level <= 2 ? .semibold : .regular)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Headings need air above them, but not at the very top of a
                // reply where it would read as a gap under the prompt.
                .padding(.top, isFirst ? 0 : 12)
                .padding(.bottom, 8)

        case .code(let t, let lang):
            CodeBlock(text: t, language: lang)
                .padding(.bottom, 10)

        case .rule:
            Rectangle().fill(Theme.hairline).frame(height: 0.5)
                .padding(.vertical, 10)
        }
    }

    /// Inline spans — bold, italics, code, links — are what AttributedString is
    /// genuinely good at, so the block pass hands them straight to it.
    private func inline(_ t: String, size s: CGFloat? = nil, weight: Font.Weight = .regular) -> some View {
        let f = s ?? size
        if let attr = try? AttributedString(
            markdown: t,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return AnyView(Text(attr)
                .font(.system(size: f, weight: weight))
                .foregroundColor(color)
                .lineSpacing(lineSpacing(for: f))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled))
        }
        return AnyView(Text(t)
            .font(.system(size: f, weight: weight))
            .foregroundColor(color)
            .lineSpacing(lineSpacing(for: f))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled))
    }

    /// Codex sets 14/22 and 20/28 — a ratio near 1.57 and 1.4. SwiftUI's
    /// lineSpacing is the GAP, not the line box, so the font's own height comes
    /// off first.
    private func lineSpacing(for f: CGFloat) -> CGFloat {
        let target = f >= 20 ? f * 1.40 : f * 1.57
        return max(0, target - f * 1.20)
    }
}

/// A fenced block inside prose. Bounded and scrollable, like every other
/// payload on this surface.
private struct CodeBlock: View {
    let text: String
    let language: String?
    @Environment(\.codeMeasure) private var codeMeasure

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.02))
                    .overlay(Rectangle().fill(Theme.hairline).frame(height: 0.5), alignment: .bottom)
            }
            ScrollView {
                Text(text)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundColor(Theme.textDim)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 11).padding(.vertical, 8)
            }
            .frame(maxHeight: 220)
        }
        .frame(maxWidth: codeMeasure, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}
