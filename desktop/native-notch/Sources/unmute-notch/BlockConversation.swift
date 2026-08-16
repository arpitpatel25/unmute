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
/// THE COLUMN IS A FRACTION OF THE PANEL, so widening the surface widens the
/// reading area by the same proportion — same type size, more words per line.
///
/// A fixed cap used to bind here, which meant the last step of the width control
/// bought nothing: 894 → 900 between 80% and 90%. Now every step moves by the
/// same ratio the window does.
///
///     70%  panel 1029 → column 782, margins 123
///     80%  panel 1176 → column 894, margins 141
///     90%  panel 1323 → column 1005, margins 159
///
/// This is the whole conversation measure — the user's bubble hangs off its
/// right edge and the reply runs from its left, so both move together and the
/// exchange stays one column rather than two things drifting apart.
private let COLUMN_FRACTION: CGFloat = 0.76

private func proseMeasure(for panelWidth: CGFloat) -> CGFloat {
    // The floor matters only for a panel too narrow to have a sensible column;
    // there is deliberately no ceiling, so the control never stops working.
    max(543, panelWidth * COLUMN_FRACTION)
}

private func codeMeasure(for panelWidth: CGFloat) -> CGFloat {
    // Everything the panel has, less a gutter — terminal output, JSON and diffs
    // are why the window is large, so they are never narrower than the prose.
    max(proseMeasure(for: panelWidth), panelWidth - 96)
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

            if let usage {
                // Aligned to the reading column, not the panel edge — a caption
                // belongs under the thing it describes.
                UsageFooter(usage: usage)
                    .frame(maxWidth: proseMeasure(for: width), alignment: .trailing)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        // FILL FIRST, THEN MEASURE. Without this frame the stack sized itself to
        // its content, the content was sized by `width`, and `width` was read
        // back off the stack — a loop SwiftUI settles once and never revisits.
        // The column froze at whatever the initial value produced and the width
        // control did nothing, at any setting.
        //
        // `maxWidth: .infinity` makes the stack take the panel's width outright,
        // so what the reader sees no longer depends on what the reader set.
        .frame(maxWidth: .infinity)
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

/// HOW FULL THIS CONVERSATION IS. One quiet line, and nothing else.
///
/// What this replaces put two unrelated numbers on one row: the context window,
/// and the plan quota — with a bar tracking the first while the words stated the
/// second, so a bar at 22% sat beside "45% used" and read as a contradiction.
/// The plan quota is gone. It answers a different question, moves on a weekly
/// cycle rather than per turn, and there is nothing to do about it mid-thread,
/// which is the test for earning a permanent place under every reply.
///
/// THE NOUN LEADS. A bare "201k / 258k" could be tokens, messages, credits or
/// minutes; at this size the word is what makes the line scannable. "Context"
/// is also what the agent itself says when it runs out of it.
///
/// It turns amber past 70% — the same row, the same words, just no longer
/// ignorable — because that is when a compaction is coming and knowing early is
/// the only thing you can act on.
private struct UsageFooter: View {
    let usage: BlockUsage

    /// A window we were never told is not a window. Claude does not report one,
    /// so its line shows a bare total rather than a fraction against a number
    /// somebody made up — which is how "401k / 200k · 100% full" appeared on a
    /// session whose window was 1M.
    private var known: Bool { usage.window > 0 }
    private var filling: Bool { known && usage.fraction >= 0.70 }

    var body: some View {
        HStack(spacing: 5) {
            Spacer(minLength: 0)
            Text("Context")
                .foregroundColor(filling ? Theme.cNeeds.opacity(0.75) : Theme.textFaint.opacity(0.7))
            Text(known ? "\(short(usage.used)) / \(short(usage.window))" : short(usage.used))
                .foregroundColor(filling ? Theme.cNeeds : Theme.textFaint)
            if filling {
                Text("· \(Int(usage.fraction * 100))% full")
                    .foregroundColor(Theme.cNeeds)
            }
        }
        .font(.system(size: 10, design: .monospaced))
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    /// An unknown window shows as "—" rather than 0k, which would read as a real
    /// measurement of nothing.
    private func short(_ n: Int) -> String {
        if n <= 0 { return "—" }
        if n < 1000 { return "\(n)" }
        return "\(n / 1000)k"
    }
}
