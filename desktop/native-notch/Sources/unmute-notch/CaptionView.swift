import AppKit
import CoreText
import SwiftUI

/// A caption, the way video captions actually look: white text on pure black,
/// centred, wrapped short, and — the part that matters — ONE BOX PER LINE.
///
/// A single `Text` with a background paints one rectangle around the whole
/// wrapped block, which gives an even right edge and reads as a dialog. Real
/// captions are ragged: each line's slab is exactly as wide as that line, so
/// the shape follows the words. SwiftUI has no `box-decoration-break`, so the
/// lines are broken here and stacked, each carrying its own slab.
///
/// WHY IT IS NOT ONE LONG LINE. The eye should not travel the width of a
/// display to read one sentence. A fixed narrow column that wraps downward is
/// read in place, at a glance, which is the only reading this surface can ask
/// for.
///
/// Geometry reviewed on the Caption Bench and chosen there; the numbers below
/// are that decision, not defaults.
struct CaptionView: View {
    let text: String
    /// Held open: no clock, many lines, scrollable. Same slabs, same voice —
    /// this is the caption kept on screen, never a panel or a window.
    var holding: Bool = false
    let onClose: () -> Void

    private static let maxWidth: CGFloat = 470
    private static let fontSize: CGFloat = 23
    private static let weight: NSFont.Weight = .medium
    private static let tracking: CGFloat = 0.12
    private static let padH: CGFloat = 9.2
    private static let padV: CGFloat = 5.8
    /// Lines are separated, not touching: chosen on the bench over one stepped block.
    private static let lineGap: CGFloat = 2.1
    /// Reserves room for the close control so it can sit outside the slabs.
    /// Applied to both sides, because taking it from one would shift the
    /// caption off the centre it is positioned on.
    private static let margin: CGFloat = 14
    /// A held answer stops growing before it becomes a wall of text on the
    /// screen. Past this it scrolls, which is the point of holding it.
    private static let maxHeldHeight: CGFloat = 420

    var body: some View {
        Group {
            if holding {
                ScrollView(.vertical, showsIndicators: false) { slabs }
                    .frame(maxWidth: Self.maxWidth + Self.margin * 2)
                    .frame(maxHeight: Self.maxHeldHeight)
            } else {
                slabs.fixedSize()
            }
        }
        .overlay(alignment: .topTrailing) { closeButton }
    }

    private var slabs: some View {
        VStack(alignment: .center, spacing: Self.lineGap) {
            ForEach(Array(Self.wrap(text).enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: Self.fontSize, weight: .medium))
                    .tracking(Self.tracking)
                    .foregroundStyle(.white)
                    // Each line is already broken to fit; letting SwiftUI wrap
                    // it again would defeat the whole measurement.
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, Self.padH)
                    .padding(.vertical, Self.padV)
                    .background(Color.black)
            }
        }
        // A caption never takes a click: it must not steal one meant for the
        // app underneath. A HELD answer has to, or it cannot be scrolled — and
        // by then the user has deliberately been given something to read.
        .allowsHitTesting(holding)
        .padding(.horizontal, Self.margin)
        .padding(.top, Self.margin)
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white.opacity(0.75))
                .frame(width: 16, height: 16)
                .background(Circle().fill(.black.opacity(0.65)))
        }
        .buttonStyle(.plain)
        .help("Dismiss")
    }

    /// Breaks the caption into display lines at `maxWidth`, using the same font
    /// and tracking the lines are drawn with — a measurement taken with any
    /// other font is a guess.
    ///
    /// Pure: it reads no geometry and writes no state, so it cannot start the
    /// measure-then-resize loop that a caption sized from a `GeometryReader`
    /// would.
    private static func wrap(_ raw: String) -> [String] {
        // Captions are one sentence, but a stray newline must not become an
        // empty slab. A held answer arrives with the paragraphs the model
        // chose, and at that length they are how it is meant to be read — so
        // each source line is wrapped on its own and blank ones are dropped.
        let paragraphs = raw
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if paragraphs.count > 1 { return paragraphs.flatMap { wrapOne($0) } }

        let flat = raw
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !flat.isEmpty else { return [] }
        return wrapOne(flat)
    }

    private static func wrapOne(_ flat: String) -> [String] {
        guard !flat.isEmpty else { return [] }

        let font = NSFont.systemFont(ofSize: fontSize, weight: weight)
        let attributed = NSAttributedString(
            string: flat,
            attributes: [.font: font, .kern: tracking]
        )
        let typesetter = CTTypesetterCreateWithAttributedString(attributed)
        let ns = flat as NSString
        let available = Double(maxWidth - padH * 2)

        var lines: [String] = []
        var start = 0
        while start < ns.length {
            let count = CTTypesetterSuggestLineBreak(typesetter, start, available)
            // A width too narrow for even one glyph returns 0; without this the
            // loop never advances.
            guard count > 0 else { break }
            let piece = ns
                .substring(with: NSRange(location: start, length: count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty { lines.append(piece) }
            start += count
        }
        // Falling back to the whole string keeps a caption on screen even if
        // typesetting refuses it; an unreadably wide line beats no answer.
        return lines.isEmpty ? [flat] : lines
    }
}
