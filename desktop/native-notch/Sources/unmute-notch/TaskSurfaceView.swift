import SwiftUI
import ComposerSupport

// The single-task surface — status + duration, the pending question (chips or
// free-text), done result + detail + artifacts, failed reason / mcpGap fix,
// stop / re-run / kill and the native conversation controls — plus the crank
// (Next + "1 of N") and Open dashboard.
//
// This is the ATTENTION panel: exactly one task, sized to itself, and it never
// balloons into the dashboard. The boundary — one task vs. all — is what keeps
// this state distinct from the cockpit.
struct TaskSurfaceView: View {
    @ObservedObject var model: NotchModel
    let topInset: CGFloat

    private var t: TaskDetail? { model.task }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                if let t {
                header(t)
                // WHAT TO SAY, SAID ONCE.
                //
                // The Agent's card looked like every task card, so nothing told
                // a new person that this one is addressed rather than watched.
                // Three concrete things beat a description of a capability, and
                // it goes as soon as the conversation has anything in it —
                // after the first exchange it would only be taking up the room
                // the answers need.
                if t.id == "unmute-agent", model.taskConversationRows.isEmpty, model.taskBlocks.isEmpty {
                    Text("Ask me to pick up an old session, start a new one, or find something you said.")
                        .font(Theme.fSub)
                        .foregroundColor(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                }
                if t.id == "unmute-agent", t.agentCanRetry == true {
                    Button("Retry retained message") { model.emit(.agentRetry) }
                        .buttonStyle(.plain).foregroundColor(Theme.textDim)
                }
                ChatStatusView(model: model, task: t)

                // THE ASK MOVED BELOW THE REASONING (see the strip further
                // down). It was the FIRST thing on this surface, so a question
                // like "Want me to spec that first?" met you stripped of the
                // 2,800 characters that made it answerable — one line, a text
                // box, and no argument. The headline chain keeps its other
                // branches; only the question left the top.
                Group {
                    // MESSAGE MODE. One transcript for every backend — this was
                    // ConversationPanel for driver backends and ExchangeStrip for
                    // the rest, two components showing the same thing where only
                    // one of them filled the space it was given.
                    ConversationPanel(rows: model.taskConversationRows, id: t.id,
                                      blocks: model.taskBlocks, usage: model.taskUsage,
                                      running: t.status == .processing, history: t.history, canEditLatestMessage: t.canEditLatestMessage ?? false, olderMessages: t.olderMessages ?? 0,
                                      loadOlder: { model.emit(.loadOlderMessages(id: t.id)) })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        // THE AGENT'S ROUTINE SHEETS sit over the chat, never
                        // beside it — one chat, no second panel (routines spec
                        // §2). The run sheet is on top: it can be opened from
                        // inside the routines sheet's chat underneath.
                        .overlay { routineSheets(t) }
                        .padding(.top, 10)
                    if t.status == .needsUser, let q = t.question {
                        QuestionBlock(model: model, taskId: t.id, question: q,
                                      terminalOpen: taskTerminalBinding).padding(.top, 12)
                    }
                    // OFFERED WHEN IT CAN ACTUALLY BE SENT — see ComposerAvailability.
                    // Asking "has this task finished?" got it wrong both ways: it hid
                    // the box through the 8-15 minute parked-warm window when sending
                    // worked, and it showed the box over a dead executor where every
                    // send was silently retained.
                    switch composerState(alive: t.alive, canCompose: t.canCompose, canResume: t.canResume,
                                         status: t.status.rawValue, kind: t.kind) {
                    case .composable:
                        // ONE COMPOSER PER CARD, ENFORCED BY IDENTITY.
                        //
                        // `taskId` is a let and updates with the card; `text` is
                        // @State and does not, because @State belongs to the view
                        // rather than to the data. Without an id SwiftUI reuses
                        // this composer across a card switch, onAppear never fires
                        // again to re-seed from the new draft, and the next
                        // keystroke emits the OLD text under the NEW taskId. On
                        // 2026-09-08 a message meant for one task was submitted
                        // there and simultaneously appeared in another card's
                        // composer, which is that, exactly.
                        StageComposer(model: model, taskId: t.id, deliveryError: t.deliveryError,
                                      modelLabel: t.modelLabel, sending: t.sending ?? false,
                                      draft: t.draft, config: t.chatConfig, followup: t.followup, composerMode: t.composerMode, question: t.question,
                                      commands: t.commands ?? [],
                                      // The Agent has no process of ours to kill; its turn
                                      // ends by interrupting the provider through its own
                                      // lifecycle. Every other card keeps `kill`.
                                      onStop: taskShowsStop(t, blocks: model.taskBlocks)
                                          ? { model.emit(t.id == "unmute-agent" ? .agentStop : .kill(id: t.id)) } : nil)
                            .id(t.id)
                            .padding(.top, 9)
                    case .notRunning:
                        SessionNotRunning(reason: reconnectReason(t))
                            .padding(.top, 9)
                    case .finished:
                        EmptyView()
                    }
                }

                actions(t)
                footer(t)
                } else {
                    EmptyView()
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, topInset + 4)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            if model.captureAimed {
                AimedChip(level: model.captureLevel)
                    .padding(.bottom, 16)
                    .allowsHitTesting(false)
            }
        }
    }

    private func reconnectReason(_ task: TaskDetail) -> String? {
        task.deliveryError
            ?? task.resumeError
            ?? (task.canResume ? nil : "This connected session cannot resume in chat. Start an Unmute-managed conversation.")
    }

    /// The Agent's role, "(Sessions manager)", reads as a quieter qualifier
    /// after its name rather than as part of the name.
    private func title(_ t: TaskDetail) -> Text {
        guard t.id == "unmute-agent", let open = t.title.range(of: " (") else {
            return Text(t.title).font(Theme.fTitle).foregroundColor(Theme.text)
        }
        return Text(t.title[..<open.lowerBound]).font(Theme.fTitle).foregroundColor(Theme.text)
            + Text(t.title[open.lowerBound...]).font(Theme.fTitle).foregroundColor(Theme.textDim)
    }

    private func summaryLine(_ t: TaskDetail) -> String? {
        t.activity ?? t.result?.summary ?? t.error?.reason
    }

    private func header(_ t: TaskDetail) -> some View {
        HStack(spacing: 9) {
            Dot(status: t.status, size: 9, breathing: t.status == .processing)
            // WHAT RAN IT, beside what it is. Opening a task used to be the only
            // way to learn its backend, and then the expansion did not say
            // either — it was inferred from whether a terminal happened to be
            // offered.
            // THE MARK, AND ONLY FOR THE AGENT'S OWN CHAT. The bar, the pocket
            // rows and the wall all show the real `un`; this surface — the one
            // you land on when you open a card — showed a generic `sparkles`
            // for the Agent itself. Same product, unrecognisable in the one
            // place you actually read it.
            //
            // It stops there. A card the Agent OPENED is not the Agent: it is a
            // Claude or Codex session, its mark says which, and stamping `un` on
            // it too made every thread look like the Agent's own conversation.
            // The provider is chosen in the composer (AgentProviderSwitch), not
            // here: a logo in the header never read as something to press.
            if t.id == "unmute-agent" {
                UnMark(height: 13)
            } else {
                ProviderMark(backend: t.backend, terminal: t.hasTerminal)
            }
            // WHERE YOUR VOICE IS GOING, while it is going there.
            //
            // Only for a REMOTE capture — `capturePhase == "listening"` is set
            // by the right-Option key alone (broadcastCapturePhase fires from
            // the remote-start handler and nowhere else), so ordinary dictation
            // never lights this. That is the point: text typed by dictation
            // goes wherever your cursor is, and a mic on this card would claim
            // it was coming here.
            //
            // Its ABSENCE is the useful half. Speak with no chip showing and
            // the words are going to the router to become a new task.
            // RENAMING WHERE YOU READ THE NAME. Names are voice addresses, and
            // fixing a bad one used to need the dashboard. The Agent's own card
            // is not renameable — its name is the product's.
            if t.id != "unmute-agent", model.renamingTaskId == t.id {
                TaskTitleEditor(model: model, taskId: t.id, current: t.title)
                    .id(t.id)
            } else if t.id != "unmute-agent" {
                title(t).lineLimit(1)
                    .onTapGesture { model.renamingTaskId = t.id }
                    .help("Click to rename — names are voice addresses")
                Button { model.renamingTaskId = t.id } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 11, weight: .regular))
                        .foregroundColor(Theme.textFaint)
                }
                .buttonStyle(.plain)
                .help("Rename")
            } else {
                title(t).lineLimit(1)
            }
            StatusLabel(status: t.status)
            if let e = t.elapsed { NumText(text: e) }
            Spacer(minLength: 8)
            if t.id == "unmute-agent", let routines = t.routines {
                RoutinesHeaderButton(routines: routines, show: { model.routinesSheetOpen = true })
            }
            if model.attention > 0 {
                Text("1 of \(model.attention)").font(Theme.fSub).foregroundColor(Theme.textDim)
            }
            // LAST in the row, so it lands in the corner. It once sat between two
            // Spacers with the counter to its right, which floated it into the
            // middle of the header — nowhere near where a close control belongs.
            if model.canGoBack { BackButton { model.onBack() } }
            if model.helpGuide != nil {
                HelpButton { model.helpGuidePresented = true }
            }
            // THE CARD'S OWN ACTIONS, on the card.
            //
            // This header had none: closing it collapsed the surface and left
            // no way to put a card down or throw it away without going to the
            // dashboard — and cards the Agent opened are met HERE, so for those
            // there was no way at all.
            //
            // A menu rather than a button row because this header is narrow and
            // already carries a title, status, elapsed and a counter; the
            // dashboard's four visible KeyButtons do not fit beside them.
            if t.id != "unmute-agent" {
                Menu {
                    // THE POCKET'S ONE ACTION. Remove from pocket takes the
                    // card out of the pocket and nothing else: the task keeps
                    // running and stays in the orchestrator. It comes back by
                    // itself when it needs you, or when you or the Agent open
                    // it. Deleting lives in the orchestrator, not here.
                    Button("Remove from pocket") {
                        model.emit(.removeFromPocket(id: t.id))
                    }
                } label: {
                    Image(systemName: "ellipsis").foregroundColor(Theme.textFaint)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Remove this card from the pocket — it keeps running in the orchestrator")
            }
            CloseButton { model.emit(.collapsed) }
        }
    }



    @ViewBuilder
    private func routineSheets(_ t: TaskDetail) -> some View {
        if t.id == "unmute-agent", let routines = t.routines {
            ZStack {
                if model.routinesSheetOpen {
                    RoutinesSheet(routines: routines, error: t.deliveryError, close: { model.routinesSheetOpen = false }, emit: model.emit)
                }
                if let run = routines.run {
                    RoutineRunSheet(detail: run, close: { model.emit(.routineCloseRun) }, emit: model.emit)
                }
            }
        }
    }

    private var taskTerminalBinding: Binding<Bool> {
        Binding(get: { model.taskTerminalOpen },
                set: { model.setTaskTerminalVisible($0) })
    }

    /// Has this task actually finished for good? STATE, not `alive`. Same rule
    /// as StageView.ended — a session finishing a step is what a session does
    /// between your messages; only an errand is over.
    private func ended(_ t: TaskDetail) -> Bool {
        (t.status == .done || t.status == .failed) && t.kind != "session"
    }

    @ViewBuilder
    private func actions(_ t: TaskDetail) -> some View {
        if !t.isOwned && !t.foreignAppName.isEmpty {
            HStack(spacing: 6) {
                KeyButton(label: "Open in \(t.foreignAppName)", symbol: "arrow.up.forward.app") { model.emit(.openInTerminal(id: t.id)) }
            }
            .padding(.top, 11)
        }
        // Stop lives in the composer now, at the send position.
    }

    @ViewBuilder
    private func footer(_ t: TaskDetail) -> some View {
        // A small notch always takes the icon-only keys: they are tooltip-
        // labelled and the arrows are on the keyboard anyway. Larger surfaces
        // still spell them out whenever they fit.
        if model.compactSurface {
            footerControls(compact: true).padding(.top, 12)
        } else {
            ViewThatFits(in: .horizontal) {
                footerControls(compact: false)
                footerControls(compact: true)
            }
            .padding(.top, 12)
        }
    }

    private func footerControls(compact: Bool) -> some View {
        HStack(spacing: 8) {
            KeyButton(label: "Dashboard", symbol: "square.grid.2x2", compact: compact) {
                model.emit(.openDashboard)
            }
            .help("Open dashboard")
            KeyButton(label: model.backgroundAudioMuted ? "Resume audio" : "Pause audio",
                        symbol: model.backgroundAudioMuted ? "speaker.wave.2" : "speaker.slash", compact: compact) {
                model.backgroundAudioMuted.toggle()
                model.emit(.backgroundAudio(muted: model.backgroundAudioMuted))
            }
            .help(model.backgroundAudioMuted ? "Resume background audio" : "Pause background audio")
            Spacer(minLength: 0)
            SurfaceSizeControls(model: model)
            // ON EVERY CARD, because the arrow keys are on every card.
            //
            // These were hidden wherever `origin == "unmute-agent"`, which is
            // both the Agent's own chat AND every task the Agent opened — a
            // provenance test standing in for an identity one. The reason given
            // was that "cranking from the chat would walk you into tasks by a
            // control that looks like it moves within this one", and the engine
            // has since decided the opposite: the Agent is a card on the same
            // ring, the crank stops on it and hands the surface on when you
            // crank off it.
            //
            // So the buttons were the only thing still saying otherwise, while
            // ← and → did the same job on the same cards all along. A control
            // the keyboard has and the surface hides is not a smaller surface;
            // it is one that behaves differently depending on how you reach it.
            HStack(spacing: 4) {
                KeyButton(label: "Previous", symbol: "chevron.left", compact: compact) { model.emit(.prev) }
                KeyButton(label: "Next", symbol: "chevron.right", compact: compact, trailingSymbol: true) { model.emit(.next) }
            }
            // The overflow menu lives in the header, top right, and nowhere
            // else. A second one beside Next offered a subset of the same
            // actions from the opposite corner, so the card had two places
            // to look for one thing.
        }
    }
}

/// The title, editable. Return commits through the same `.rename` the
/// dashboard uses; Escape cancels (AppController's key monitor routes it here
/// before it can step the surface down); an empty or unchanged name is no
/// change. The text is seeded once on appear — the card is keyed by id, so a
/// card switch builds a fresh editor rather than carrying one name onto another.
private struct TaskTitleEditor: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    let current: String
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Name", text: $text)
            .textFieldStyle(.plain)
            .font(Theme.fTitle).foregroundColor(Theme.text)
            .focused($focused)
            .frame(maxWidth: 260)
            .onSubmit(commit)
            .onExitCommand { model.renamingTaskId = nil }
            .onAppear {
                text = current
                DispatchQueue.main.async { focused = true }
            }
            .onDisappear { if model.renamingTaskId == taskId { model.renamingTaskId = nil } }
    }

    private func commit() {
        // 48 = MAX_TASK_NAME on the main side, which clamps as well.
        let v = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(48))
        if !v.isEmpty, v != current { model.emit(.rename(id: taskId, name: v)) }
        if model.renamingTaskId == taskId { model.renamingTaskId = nil }
    }
}
