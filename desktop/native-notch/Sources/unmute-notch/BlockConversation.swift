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
/// Coordinate space for the scroll viewport, so the end-marker can be measured
/// against it rather than against the window.
private let BLOCK_SCROLL = "block-conversation-scroll"

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
    /// Viewport height, so the reporter's measurement can be turned into a
    /// distance-below-the-fold rather than a raw coordinate.
    @State private var viewportHeight: CGFloat = 0
    /// The panel's own width, read once per layout — the column and the code
    /// measure are both derived from it.
    @State private var width: CGFloat = 900

    /// Open on the last message's FIRST line, not on the thread's last pixel.
    ///
    /// Two separate bugs lived here, and only one of them was about anchoring.
    ///
    /// ANCHOR AFTER LAYOUT, NOT DURING IT. `onAppear` fires before SwiftUI has
    /// laid the LazyVStack out, so `scrollTo` from inside it is a no-op and the
    /// thread opened wherever the scroller happened to be — usually the very
    /// top. ConversationPanel hit this first and fixed it by hopping to the
    /// next runloop pass; this surface was written later and did not inherit
    /// the fix. Hence the DispatchQueue.main.async.
    ///
    /// AND THE BOTTOM IS THE WRONG PLACE TO LAND. Scrolling to the bottom
    /// sentinel puts the END of the newest message against the bottom edge, so
    /// a long answer opens on its last line and has to be scrolled BACKWARDS to
    /// read. Anchoring that turn's top instead opens it where you would start
    /// reading. A short last message cannot leave a gap: the scroller clamps at
    /// content end, so it simply sits at the bottom as before.
    private func openAtLatest(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            guard let last = turns.last else { return }
            proxy.scrollTo(last.id, anchor: .top)
        }
    }

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
                                .background(BottomDistanceReporter { end in
                                    // viewportHeight - end = points of content
                                    // still below the fold. Folded through the
                                    // hysteresis so the Jump control cannot move
                                    // the value across its own boundary.
                                    atBottom = isAtBottom(was: atBottom, distance: viewportHeight - end)
                                })
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        // Room for the control to float over, so the last line
                        // of the newest message is never underneath it.
                        .padding(.bottom, jumpControlHeight)
                    }
                    .coordinateSpace(name: BLOCK_SCROLL)
                    .background(GeometryReader { g in
                        Color.clear.onAppear { viewportHeight = g.size.height }
                            .onChange(of: g.size.height) { viewportHeight = $0 }
                    })

                    // ALWAYS PRESENT, never conditional.
                    //
                    // It used to appear only when `atBottom` was false, and in
                    // this surface — the one you get when the terminal is
                    // hidden — that meant it was usually absent: the thread
                    // opens anchored on the last turn, so the flag reads true
                    // and the only way back to the live end was to scroll up
                    // far enough to summon the control that scrolls you down.
                    //
                    // Drawing it unconditionally also RETIRES the loop this
                    // file was rewritten to avoid. The hysteresis in
                    // BottomProximity exists because the control's presence
                    // moved the content it was measuring; a control that is
                    // always there cannot move anything. `atBottom` now feeds
                    // one thing only — whether new turns may scroll a reader —
                    // and the dead zone still earns its place there.
                    JumpToLatest(status: liveStatus) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                        }
                    }
                    .padding(.bottom, 10)
                }
                // A THREAD OPENS AT THE START OF ITS LAST MESSAGE, and
                // follows the live end as it grows.
                .onAppear { openAtLatest(proxy) }
                .onChange(of: turns.count) { _ in
                    guard atBottom else { return }   // do not yank a reader back
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                    }
                }
                .onChange(of: id) { _ in openAtLatest(proxy) }
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

/// Reports HOW FAR the transcript's end is from the viewport's bottom edge.
///
/// It reports a DISTANCE and nothing else. The previous version reported whether
/// it was itself on screen, via onAppear/onDisappear — and since that answer
/// decided whether the Jump control was drawn, and the control's presence moved
/// this view, the two chased each other and SwiftUI recomputed layout forever.
/// See ConversationSupport/BottomProximity.swift for the whole account.
///
/// A measurement cannot be changed by what we choose to draw afterwards; a
/// visibility can. The threshold logic — and the dead zone that makes the
/// control unable to flip its own condition — lives with the pure function.
private struct BottomDistanceReporter: View {
    let onMeasure: (CGFloat) -> Void

    var body: some View {
        GeometryReader { geo in
            Color.clear
                .preference(
                    key: BottomDistanceKey.self,
                    // Distance from this marker (the content's end) up to the
                    // bottom edge of the scroll viewport. Zero when they meet.
                    value: geo.frame(in: .named(BLOCK_SCROLL)).maxY
                )
        }
        .onPreferenceChange(BottomDistanceKey.self, perform: onMeasure)
    }
}

private struct BottomDistanceKey: PreferenceKey {
    static var defaultValue: CGFloat = .nan
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
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
                    // On the light pill the old Theme.textFaint (white at 40%)
                    // was invisible. Ink, held back, so it reads as secondary
                    // without disappearing.
                    Text(status)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(Theme.accentInk.opacity(0.62))
                }
            }
            // SOLID, NOT A GHOST. It was Theme.raised — white at 5.5% — which
            // is the same treatment as every inert chip on the surface, and it
            // floats over a transcript that is itself mostly text on black. It
            // read as part of the content it sits on top of.
            //
            // NO HUE. Red, blue and green are all spoken for: status colour
            // means failed / working / done on every other surface, and a
            // control borrowing one would claim a state it does not have. The
            // accent is white, which is the strongest contrast available here
            // and carries no meaning of its own — the same treatment the
            // composer's send button uses for the same reason.
            //
            // The shadow is what actually separates it from the text beneath;
            // fill alone still reads as flat against a dark ground.
            //
            // TRANSLUCENT, THOUGH. Fully opaque it stopped floating OVER the
            // transcript and started punching a hole IN it — a solid slab
            // sitting on the words rather than a control hovering above them.
            // At ~0.67 effective the text still shows through enough to read
            // as depth, while ink on it stays legible. Far from the white-at-
            // 5.5% ghost it replaced; not a lid either.
            .foregroundColor(Theme.accentInk)
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .background(Capsule().fill(Theme.accent.opacity(0.72)))
            .overlay(Capsule().stroke(Color.black.opacity(0.18), lineWidth: 0.5))
            .shadow(color: Color.black.opacity(0.45), radius: 8, y: 2)
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
