import AppKit
import SwiftUI
import ConversationSupport

/// The chat view: turns, and one control.
///
/// Spec: docs/superpowers/specs/2026-08-16-chat-view-blocks.md §6
///
/// The pinned "Jump to latest" control keeps the live end reachable without
/// forcing a reader to follow it. An earlier design pinned a progress strip
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

private struct TurnTopKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

/// Prose and wide payloads share a centered, screen-contained column system.
/// The pure ConversationSupport measures cap prose at 760 points while letting
/// code use the available width inside the gutters. These are Unmute layout
/// choices, not claimed DOM measurements of another desktop application.

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
    var olderMessages: Int = 0
    var loadOlder: () -> Void = {}
    var canEditLatestMessage: Bool = false
    /// Whether the TASK is still working. Taken from the task manager rather
    /// than inferred from the blocks, for the reason BlockPresentation.build
    /// documents: a transcript carries no turn markers, so the blocks alone
    /// cannot tell "finished" from "still thinking".
    var running: Bool = false
    @State private var loadingOlder = false
    @State private var olderAnchor: BlockTurn?

    /// Whether a streaming tick may move the reader to the live end. Held in a
    /// reference box, NOT as @State: nothing is drawn from it, so no scroll
    /// report or wheel event can invalidate the body — the measure/set loops
    /// BottomProximity.swift describes need state that reads AND changes
    /// layout, and this changes none. See LiveEndFollow.
    @State private var follow = LiveEndFollowBox()
    /// Viewport height, so the reporter's measurement can be turned into a
    /// distance-below-the-fold rather than a raw coordinate.
    @State private var viewportHeight: CGFloat = 0
    /// The panel's own width, read once per layout — the column and the code
    /// measure are both derived from it.
    @State private var width: CGFloat = 900
    @State private var restoreGate = ScrollRestoreGate()
    /// The transcript stays hidden for its one layout pass so selecting a task
    /// never exposes the mechanical jump from SwiftUI's default top position.
    @State private var positionedTask: String?

    /// Open on the latest USER message's first line, not on the thread's last
    /// pixel and not wherever this task happened to be read previously.
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
    private func restorePosition(_ proxy: ScrollViewProxy) {
        let task = id
        positionedTask = nil
        _ = restoreGate.begin(task: task, savedAnchor: nil)
        follow.state.reset()
        DispatchQueue.main.async {
            if let target = initialConversationAnchor(turns: turns) { proxy.scrollTo(target, anchor: .top) }
            DispatchQueue.main.async {
                if let target = initialConversationAnchor(turns: turns) { proxy.scrollTo(target, anchor: .top) }
                restoreGate.finish(task: task)
                positionedTask = task
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ZStack(alignment: .bottom) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            // Three meanings, not two — see LoadEarlierControl.
                            // A negative remainder is UNKNOWN-but-more, which
                            // still offers, just without a count it cannot know.
                            if let earlierLabel = LoadEarlierControl.label(olderMessages: olderMessages) {
                                // Centred: it belongs to the transcript as a
                                // whole rather than to the first message, and
                                // left-aligned it read as a stray line of text
                                // tucked under the title.
                                KeyButton(label: earlierLabel, symbol: "clock.arrow.circlepath") {
                                    olderAnchor = turns.first
                                    loadingOlder = true
                                    loadOlder()
                                }
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                            ForEach(turns) { turn in
                                BlockTurnView(turn: turn, taskId: id, canEdit: canEditLatestMessage && turn.id == turns.last(where: { $0.prompt != nil })?.id)
                                    .background(GeometryReader { geo in
                                        Color.clear.preference(key: TurnTopKey.self,
                                            value: [turn.id: geo.frame(in: .named(BLOCK_SCROLL))])
                                    })
                                    // THE COLUMN. Centred, so the conversation
                                    // sits in the middle of a wide panel rather
                                    // than pinned to its left edge.
                                    .frame(maxWidth: proseMeasure(panelWidth: width), alignment: .leading)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                            // THE TAIL. Sits under the newest message, in the
                            // same column as the turns, so the acknowledgement
                            // belongs to what you just sent rather than to the
                            // surface around it.
                            if awaitingReply {
                                TypingIndicator()
                                    .frame(maxWidth: proseMeasure(panelWidth: width), alignment: .leading)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .transition(.opacity)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(BLOCK_BOTTOM)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        // The column's frame in viewport space: its maxY is the
                        // end marker's (the marker is the last row, and the
                        // Jump padding is applied outside), its minY moves only
                        // when the reader scrolls. bottomDistance owns the sign.
                        .background(BottomDistanceReporter { frame in
                            follow.state.measure(contentTop: frame.minY, contentEnd: frame.maxY,
                                                 viewportHeight: viewportHeight,
                                                 restoring: !restoreGate.mayFollow(task: id))
                        })
                        // The reader's hands on the scroller. Zero-size in
                        // effect (a background) and transparent to the mouse.
                        .background(UserScrollObserver(follow: follow))
                        // Cross-fade the tail rather than letting it pop: it
                        // appears and disappears on someone else's schedule
                        // (the first block back), and an unannounced jump in
                        // transcript height reads as a glitch.
                        .animation(.easeInOut(duration: 0.18), value: awaitingReply)
                        // Room for the control to float over, so the last line
                        // of the newest message is never underneath it.
                        .padding(.bottom, jumpControlHeight)
                    }
                    .coordinateSpace(name: BLOCK_SCROLL)
                    .background(GeometryReader { g in
                        Color.clear.onAppear { viewportHeight = g.size.height }
                            .onChange(of: g.size.height) { viewportHeight = $0 }
                    })
                    .onPreferenceChange(TurnTopKey.self) { positions in
                        guard restoreGate.mayRecord(task: id) else { return }
                        let frames = positions.map { TurnViewportFrame(id: $0.key, minY: $0.value.minY, maxY: $0.value.maxY) }
                        guard let visible = visibleTurnAnchor(frames: frames, viewportHeight: viewportHeight) else { return }
                        ConversationScrollMemory.shared.remember(task: id, anchor: visible)
                    }

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
                    // always there cannot move anything. The at-bottom flag (LiveEndFollow) feeds
                    // one thing only — whether new turns may scroll a reader —
                    // and the dead zone still earns its place there.
                    JumpToLatest(status: liveStatus) {
                        follow.state.jumpToLatest()
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                        }
                    }
                    .padding(.bottom, 10)
                }
                .opacity(positionedTask == id ? 1 : 0)
                // A THREAD OPENS AT ITS NEWEST USER TURN, and follows the live
                // end as that turn grows.
                .onAppear { restorePosition(proxy) }
                .onChange(of: turns.count) { _ in
                    if loadingOlder {
                        loadingOlder = false
                        if let old = olderAnchor, let anchor = turns.first(where: { old.prompt != nil ? $0.prompt == old.prompt : old.reply != nil && $0.reply == old.reply })?.id { DispatchQueue.main.async { proxy.scrollTo(anchor, anchor: .top) } }
                        return
                    }
                    if positionedTask != id { restorePosition(proxy); return }
                    // Do not yank a reader back, nor fight one mid-scroll.
                    guard restoreGate.mayFollow(task: id), follow.state.mayFollow(at: now()) else { return }
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                    }
                }
                .onChange(of: streamExtent) { _ in
                    guard restoreGate.mayFollow(task: id), follow.state.mayFollow(at: now()) else { return }
                    proxy.scrollTo(BLOCK_BOTTOM, anchor: .bottom)
                }
                .onChange(of: id) { _ in restorePosition(proxy) }
            }

            if let usage {
                // Aligned to the reading column, not the panel edge — a caption
                // belongs under the thing it describes.
                UsageFooter(usage: usage)
                    .frame(maxWidth: proseMeasure(panelWidth: width), alignment: .trailing)
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
        .environment(\.codeMeasure, codeMeasure(panelWidth: width))
    }

    /// Sent, and nothing has come back yet.
    ///
    /// THE TEARDOWN KEYS ON WORK OR REPLY, NEVER ON THE PROMPT. Your own
    /// message is not drawn optimistically — NotchModel.prepareTaskConversation
    /// rebuilds the transcript from the task payload, so the prompt bubble
    /// ARRIVES FROM THE BACKEND. Hiding the dots when the blocks change would
    /// therefore hide them at the exact moment your message appeared, which is
    /// the silence this was added to remove, one step later.
    ///
    /// An empty transcript is not this case: ConversationPanel already shows
    /// "Starting…" when there is nothing to lay out at all.
    private var awaitingReply: Bool {
        guard running, let last = turns.last else { return false }
        return last.work.isEmpty && last.reply == nil
    }

    /// What the pill says while something is running. Nil when everything has
    /// settled, so the pill is then just a way back.
    private var liveStatus: String? {
        guard let last = turns.last, last.meta.isRunning else { return nil }
        return last.meta.summary
    }

    private func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    private var streamExtent: Int {
        guard let last = turns.last else { return 0 }
        let replyCount = last.reply?.text?.utf16.count ?? 0
        var workCount = 0
        for block in last.work {
            workCount += block.text?.utf16.count ?? 0
            workCount += block.output?.utf16.count ?? 0
        }
        return replyCount + workCount
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
    let onMeasure: (CGRect) -> Void

    var body: some View {
        GeometryReader { geo in
            Color.clear
                .preference(
                    key: BottomDistanceKey.self,
                    // The transcript column's frame in the scroll viewport's
                    // space. maxY - viewportHeight is what is left below the
                    // fold; see bottomDistance for the sign.
                    value: geo.frame(in: .named(BLOCK_SCROLL))
                )
        }
        .onPreferenceChange(BottomDistanceKey.self, perform: onMeasure)
    }
}

private struct BottomDistanceKey: PreferenceKey {
    static var defaultValue: CGRect = CGRect(x: CGFloat.nan, y: .nan, width: .nan, height: .nan)
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

/// The follow decision's home. A class so writes from scroll reports and wheel
/// events never invalidate the view (see BlockConversation.follow).
final class LiveEndFollowBox {
    var state = LiveEndFollow()
}

/// THE READER'S HANDS ON THE SCROLLER.
///
/// Two sources, because neither covers everything:
///   * NSScrollView's live-scroll notifications cover trackpad gestures (through
///     their momentum tail) and dragging the scroller knob — but a classic
///     mouse wheel posts none.
///   * A local scroll-wheel monitor covers every wheel/trackpad event, momentum
///     included, and is what lets an UPWARD movement leave the bottom at once
///     instead of after 120pt of hysteresis.
///
/// Same containment approach as PocketSwipeArea: transparent to the mouse
/// (`hitTest` nil), reads the app's event stream, accepts only events inside
/// its VISIBLE rect — it sits behind the whole transcript column, so the
/// visible rect is the part of the column the viewport shows. Never consumes
/// an event.
private struct UserScrollObserver: NSViewRepresentable {
    let follow: LiveEndFollowBox

    func makeNSView(context: Context) -> UserScrollObserverView {
        let view = UserScrollObserverView()
        view.follow = follow
        return view
    }

    func updateNSView(_ view: UserScrollObserverView, context: Context) {
        view.follow = follow
    }

    static func dismantleNSView(_ view: UserScrollObserverView, coordinator: ()) {
        view.stopWatching()
    }
}

final class UserScrollObserverView: NSView {
    var follow: LiveEndFollowBox?
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window == nil ? stopWatching() : startWatching()
    }

    private func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func startWatching() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.handle(event)
            return event
        }
        let center = NotificationCenter.default
        // object: nil and filter by ancestry — SwiftUI's scroll view is private,
        // and matching on "an NSScrollView that contains me" needs no guess at
        // its class or at how deep in it this view is hosted.
        observers = [
            center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.isInside(note) else { return }
                self.follow?.state.liveScrollBegan(at: self.now())
            },
            center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.isInside(note) else { return }
                self.follow?.state.liveScrollEnded(at: self.now())
            },
        ]
    }

    func stopWatching() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    private func isInside(_ note: Notification) -> Bool {
        guard let scroll = note.object as? NSScrollView else { return false }
        return isDescendant(of: scroll)
    }

    private func handle(_ event: NSEvent) {
        guard let window, event.window === window else { return }
        // Inside the viewport, not merely inside the (much taller) column.
        let inside: Bool
        if let scroll = enclosingScrollView {
            inside = scroll.bounds.contains(scroll.convert(event.locationInWindow, from: nil))
        } else {
            inside = visibleRect.contains(convert(event.locationInWindow, from: nil))
        }
        guard inside else { return }
        follow?.state.userScrolled(deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY, at: now())
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
        .font(Theme.fCap)
        .monospacedDigit()
        .help("Conversation context used by the model")
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
