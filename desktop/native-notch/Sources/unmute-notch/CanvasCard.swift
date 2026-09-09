import SwiftUI
import WebKit
import ConversationSupport

// A DRAWING THE AGENT MADE, RENDERED INSIDE THE CONVERSATION.
//
// WHY A WEBVIEW AT ALL, given this app draws everything else natively. Two
// formats land here — an SVG document and a small HTML page — and neither has a
// native path worth taking. Complex SVG through NSImage renders inconsistently
// (filters, foreignObject, text metrics), and HTML is HTML. One WKWebView is
// less code than two native paths and better at both.
//
// WHAT MAKES THAT SAFE. The source is written by a language model and is
// therefore UNTRUSTED INPUT, in the same category as a web page. Every escape
// route is closed here rather than trusted to the content:
//
//   * NO NETWORK. A Content-Security-Policy of `default-src 'none'` is injected
//     ahead of the agent's own markup, so no fetch, no XHR, no websocket, no
//     remote font, no tracking pixel. This is the load-bearing one: without it
//     a drawing could phone home with whatever text surrounded it.
//   * NO FILESYSTEM. `loadHTMLString(baseURL: nil)` gives the document an
//     opaque origin, so `file://` is unreachable even by an absolute path.
//   * NO NAVIGATION. The delegate cancels every navigation that is not the
//     initial load, so a link cannot replace the card with a real site — and
//     `mailto:`/`tel:` cannot launch an app either. Clicking a link opens it in
//     the user's own browser, which is the one place a web page belongs.
//   * NO SCRIPTS unless the format is `html`. An SVG diagram needs none, so it
//     is not given any; only the interactive format gets JS, and it still gets
//     every restriction above.
//   * NO PERSISTENCE. A non-persistent data store, so nothing survives the card
//     — no localStorage that could accumulate across a conversation.
//
// HEIGHT IS MEASURED, NOT GUESSED. The panel is resizable and the conversation
// is a scroll view, so a fixed-height card would either crop a tall diagram or
// leave a hole under a short one. The document reports its own height back and
// the card animates to it, bounded at both ends: a floor so a failed render is
// still visibly a card, and a ceiling so one drawing cannot own the whole panel.
struct CanvasCard: View {
    let block: Block
    /// The conversation's current content width. The card tracks it so a
    /// resize re-lays the drawing out rather than scaling a stale bitmap.
    var width: CGFloat

    @State private var height: CGFloat = CanvasMetrics.initialHeight
    @State private var failure: String?
    @State private var expanded = false

    private var format: String { block.format ?? "" }
    private var source: String { block.source ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let failure {
                // A DRAWING THAT DID NOT RENDER STILL OWES AN EXPLANATION, and
                // the source with it — the text is the answer's substance and
                // must not be lost because a renderer choked on it.
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure)
                        .font(.system(size: 11.5))
                        .foregroundColor(Theme.textDim)
                    OutputBox(tag: format.isEmpty ? "source" : format, text: source)
                }
                .padding(11)
            } else {
                CanvasWeb(format: format, source: source, width: width,
                          height: $height, failure: $failure)
                    .frame(height: min(height, expanded ? CanvasMetrics.expandedMax : CanvasMetrics.collapsedMax))
                    .frame(maxWidth: .infinity)
                    .clipped()
                if height > CanvasMetrics.collapsedMax {
                    Button(expanded ? "Show less" : "Show more") {
                        withAnimation(Motion.resize) { expanded.toggle() }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundColor(Theme.textDim)
                    .padding(.horizontal, 11)
                    .padding(.bottom, 8)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 0.5))
        .animation(Motion.resize, value: height)
    }

    private var header: some View {
        HStack(spacing: 7) {
            Text(CanvasMetrics.glyph(for: format))
                .font(.system(size: 10, design: .monospaced))
            Text(CanvasMetrics.label(for: format))
                .font(.system(size: 9.5, design: .monospaced))
            Spacer()
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(source, forType: .string)
            }
            .buttonStyle(.plain)
            .font(.system(size: 9.5, design: .monospaced))
            .accessibilityLabel("Copy the source of this drawing")
        }
        .foregroundColor(Theme.textFaint)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.02))
        .overlay(Rectangle().fill(Theme.hairline).frame(height: 0.5), alignment: .bottom)
    }
}

enum CanvasMetrics {
    /// Before the document has measured itself. Small enough not to punch a
    /// hole in the transcript, tall enough to read as a card that is loading.
    static let initialHeight: CGFloat = 120
    /// The tallest a card gets without being asked. Roughly the readable height
    /// of the panel at its default size — past this, a drawing pushes the reply
    /// it belongs to off the screen, which inverts the order the whole lift
    /// exists to guarantee.
    static let collapsedMax: CGFloat = 420
    /// The ceiling even when expanded. A canvas is part of a conversation, not
    /// a document viewer; past this it scrolls inside itself.
    static let expandedMax: CGFloat = 1400

    static func label(for format: String) -> String {
        switch format {
        case "svg":  return "diagram"
        case "html": return "interactive"
        default:     return "canvas"
        }
    }

    static func glyph(for format: String) -> String {
        switch format {
        case "svg":  return "◇"
        case "html": return "▣"
        default:     return "·"
        }
    }
}
