import SwiftUI
import ConversationSupport

/// The chat view: turns, and one control.
///
/// Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md §6
///
/// THE ONLY PINNED ELEMENT IS "JUMP TO LATEST", and it appears solely once you
/// have scrolled off the live end. An earlier design pinned a progress strip
/// under the panel header; it described one turn while floating above all of
/// them, and once scrolled it reported something off-screen. Per-turn counts
/// live in each turn's work group instead — see BlockPresentation.
///
/// While a turn is running the pill carries its status, so a reader who has
/// scrolled up still knows work is happening without having to come back.
private let BLOCK_BOTTOM = "block-conversation-bottom"

/// TWO MEASURES, NOT ONE.
///
/// The surface is a fraction of the SCREEN — 0.8 by default — so on a 1470pt
/// display this panel is around 1,176pt wide.
///
/// PROSE IS CAPPED, because past roughly 75 characters the eye loses the line
/// return. It grows a little with the panel and then stops: a fixed cap made
/// the width control feel dead and left a lake of grey margin at 90%.
///
/// CODE IS NOT CAPPED. Commands, stdout, JSON and diffs use the room the panel
/// has, symmetrically, so the column stays centred. Wanting space for eighty
/// columns of terminal output is *why* the window is large — capping it there
/// would waste the width twice over.
/// MEASURED, NOT GUESSED. Codex sets its reading column at 543pt of 14pt text —
/// about 78 characters. Ours was 680–760, which at 13.5pt is 100–112 characters:
/// already WIDER than Codex, so the "too much margin" was never a narrow column.
/// It is that Codex fills the space beside its column with the Outputs panel
/// while ours leaves it empty.
///
/// HALF THE GUTTER, by request. At 620 the margins ran to ~350pt a side on a
/// wide panel and read as a void; this cuts them roughly in half.
///
/// It is knowingly past the typographic ideal — Codex sets 543 and the
/// comfortable ceiling is around 800 — so the cap at 900 is the guard: beyond
/// it the line return genuinely starts getting lost, which was the original
/// complaint. One number, easy to move.
private func proseMeasure(for panelWidth: CGFloat) -> CGFloat {
    min(900, max(543, panelWidth * 0.76))
}

private func codeMeasure(for panelWidth: CGFloat) -> CGFloat {
    // Everything the panel has, less the gutters the column already keeps.
    max(proseMeasure(for: panelWidth), min(panelWidth - 96, 1180))
}

/// How wide a code box may grow. Passed down rather than measured per box, so
/// every payload in a turn lines up instead of each finding its own edge.
private struct CodeMeasureKey: EnvironmentKey {
    static let defaultValue: CGFloat = 680
}

extension EnvironmentValues {
    var codeMeasure: CGFloat {
        get { self[CodeMeasureKey.self] }
        set { self[CodeMeasureKey.self] = newValue }
    }
}

struct BlockConversation: View {
    let turns: [BlockTurn]
    var id: String = ""
    var usage: BlockUsage?

    @State private var atBottom = true
    /// The panel's own width, read once per layout — the column and the code
    /// measure are both derived from it.
    @State private var width: CGFloat = 900

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ZStack(alignment: .bottom) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 22) {
                            ForEach(turns) { turn in
                                BlockTurnView(turn: turn)
                                    // THE COLUMN. Centred, so the conversation
                                    // sits in the middle of a wide panel rather
                                    // than pinned to its left edge.
                                    .frame(maxWidth: proseMeasure(for: width), alignment: .leading)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(BLOCK_BOTTOM)
                                .background(BottomWatcher(atBottom: $atBottom))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 2)
                    }

                    if !atBottom {
                        JumpToLatest(status: liveStatus) {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                            }
                        }
                        .padding(.bottom, 10)
                        .transition(.opacity)
                    }
                }
                // A THREAD OPENS AT THE LIVE END, and follows as it grows.
                .onAppear { proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom) }
                .onChange(of: turns.count) { _ in
                    guard atBottom else { return }   // do not yank a reader back
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                    }
                }
                .onChange(of: id) { _ in proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom) }
            }

            if let usage { UsageFooter(usage: usage) }
        }
        .background(GeometryReader { geo in
            Color.clear.onAppear { width = geo.size.width }
                .onChange(of: geo.size.width) { w in width = w }
        })
        .environment(\.codeMeasure, codeMeasure(for: width))
    }

    /// What the pill says while something is running. Nil when everything has
    /// settled, so the pill is then just a way back.
    private var liveStatus: String? {
        guard let last = turns.last, last.meta.isRunning else { return nil }
        return last.meta.summary
    }
}

/// Reports whether the transcript's end is on screen, so the jump control can
/// appear only when it is genuinely useful.
private struct BottomWatcher: View {
    @Binding var atBottom: Bool

    var body: some View {
        GeometryReader { geo in
            Color.clear
                .onChange(of: geo.frame(in: .named("scroll")).minY) { _ in }
                .onAppear { atBottom = true }
                .onDisappear { atBottom = false }
        }
    }
}

private struct JumpToLatest: View {
    let status: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 9, weight: .semibold))
                Text("Jump to latest")
                    .font(.system(size: 11.5))
                if let status {
                    Text(status)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(Theme.textFaint)
                }
            }
            .foregroundColor(Theme.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Theme.raised))
            .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("Scroll to the newest message")
    }
}

/// Context usage, where every app that has one puts it.
private struct UsageFooter: View {
    let usage: BlockUsage

    var body: some View {
        HStack(spacing: 9) {
            Text("\(short(usage.used)) / \(short(usage.window))")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Theme.textFaint)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.hairline)
                    Capsule()
                        .fill(usage.fraction > 0.85 ? Theme.cNeeds : Theme.textDim)
                        .frame(width: max(0, geo.size.width * usage.fraction))
                }
            }
            .frame(height: 3)
            if let pct = usage.rateLimitPercent {
                Text("\(pct)% used")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Theme.textFaint)
            }
        }
        .padding(.top, 9)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(height: 0.5), alignment: .top)
    }

    /// An unknown window shows as "—" rather than 0k, which would read as a
    /// real measurement of nothing.
    private func short(_ n: Int) -> String {
        if n <= 0 { return "—" }
        if n < 1000 { return "\(n)" }
        return "\(n / 1000)k"
    }
}
