import SwiftUI

/// THE VISUAL TOOLS, and the only way one is ever asked for.
///
/// NOT INFERRED — not from the words you said, not from what the answer looks
/// like, not from a router deciding your sentence sounded visual. A surface
/// that decides on your behalf when to draw is one that draws when you did not
/// want it to, and the bill lands on your own tokens. So a tool is a thing you
/// PICK, in the composer, before you send: it arms for exactly one message and
/// disarms itself the moment that message is accepted.
///
/// That also makes the feature discoverable in the one way a voice-first
/// product cannot manage otherwise. There is no phrase to learn and no incantation
/// to remember — the tools are visible in the composer, and the instruction you
/// give one is an ordinary sentence you can dictate like any other.
enum ComposerTool: String, CaseIterable, Identifiable {
    case diagram
    case interactive
    case image

    var id: String { rawValue }

    var label: String {
        switch self {
        case .diagram:     return "Diagram"
        case .interactive: return "Interactive"
        case .image:       return "Image"
        }
    }

    /// SF Symbols, chosen to say what comes back rather than what is used to
    /// make it: a drawing, something you can press, a picture.
    var symbol: String {
        switch self {
        case .diagram:     return "flowchart"
        case .interactive: return "hand.tap"
        case .image:       return "photo"
        }
    }

    /// What the tool will do, in the words of the person about to use it. Shown
    /// in the picker, because "Interactive" alone does not tell anyone what
    /// they are about to spend a turn on.
    var explanation: String {
        switch self {
        case .diagram:     return "Draw the answer as a diagram, under the reply."
        case .interactive: return "Build something you can step through or press."
        case .image:       return "Find a real picture and put it in the reply."
        }
    }

    /// A conservative fallback for the symbol, because `flowchart` is recent
    /// and an unavailable symbol renders as nothing at all — an invisible
    /// button being strictly worse than a plain one.
    var fallbackSymbol: String {
        switch self {
        case .diagram:     return "square.on.circle"
        case .interactive: return "hand.tap"
        case .image:       return "photo"
        }
    }
}

/// The composer's tool control: one chip that opens a short menu, and shows
/// what is armed once something is.
struct ComposerToolPicker: View {
    /// nil = nothing armed, which is the resting state and must look like it.
    let armed: ComposerTool?
    let pick: (ComposerTool?) -> Void

    @State private var open = false
    @State private var hovering = false

    var body: some View {
        Button {
            // ARMED IS A TOGGLE, NOT A TRAP. Tapping the lit chip disarms it
            // rather than reopening the menu — undoing a choice should never
            // cost more taps than making it.
            if armed != nil { pick(nil) } else { open.toggle() }
        } label: {
            // IT HAS TO BE READABLE AT REST, and the first cut was not.
            //
            // Unarmed, this was a bare 10.5pt glyph in Theme.textFaint with no
            // label and no background until the pointer touched it. Shipped
            // that way and measured immediately: two sessions, both wanting a
            // visual, ZERO armings in the log — the person asked for a diagram,
            // got an HTML file to open in a browser, and reasonably concluded
            // the feature was broken. It was never invoked. An entry point that
            // reads as decoration is not an entry point, and this is the only
            // one the feature has.
            //
            // So it wears a word. A named chip is what every other control in
            // this row does, and the row is where people already look.
            HStack(spacing: 5) {
                symbol(for: armed)
                    .font(.system(size: 10.5, weight: .medium))
                Text(armed?.label ?? "Visual").font(.system(size: 11.5, weight: .medium))
                if armed != nil {
                    // The dismiss affordance is spelled out, so "how do I turn
                    // this off" is answered by looking rather than by guessing.
                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                }
            }
            .foregroundColor(armed == nil ? Theme.textDim : Theme.accentInk)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(Capsule().fill(armed == nil
                                       ? Color.white.opacity(hovering ? 0.14 : 0.07)
                                       : Theme.accent))
            .overlay(Capsule().stroke(armed == nil ? Theme.hairline : Color.clear, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: armed)
        .animation(Theme.hover, value: hovering)
        .help(armed.map { "\($0.label) is armed for the next message — click to turn it off" }
              ?? "Ask for a diagram, something interactive, or a picture — shown under the reply")
        .popover(isPresented: $open, arrowEdge: .top) { menu }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(ComposerTool.allCases) { tool in
                Button {
                    pick(tool)
                    open = false
                } label: {
                    HStack(alignment: .top, spacing: 9) {
                        symbol(for: tool)
                            .font(.system(size: 12))
                            .frame(width: 16)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(tool.label).font(.system(size: 12.5, weight: .medium))
                            Text(tool.explanation)
                                .font(.system(size: 11))
                                .foregroundColor(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .frame(width: 250, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HoverRowStyle())
            }
            Divider().padding(.vertical, 2)
            // THE HONEST FOOTER. The person is about to spend their own tokens,
            // and a turn that draws costs more than a turn that talks.
            Text("Applies to your next message only, and uses the same tokens as any other turn.")
                .font(.system(size: 10.5))
                .foregroundColor(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .frame(width: 250, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    /// SF Symbols added in recent macOS versions are absent on older ones and
    /// render as an empty frame, so every glyph has a floor.
    @ViewBuilder private func symbol(for tool: ComposerTool?) -> some View {
        let name = tool?.symbol ?? "wand.and.stars"
        if NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil {
            Image(systemName: name)
        } else {
            Image(systemName: tool?.fallbackSymbol ?? "sparkles")
        }
    }
}

/// A menu row that lights on hover. AppKit gives this free in a real menu; a
/// popover is a plain view and has to say so itself.
private struct HoverRowStyle: ButtonStyle {
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color.white.opacity(hovering ? 0.07 : 0))
            .onHover { hovering = $0 }
    }
}
