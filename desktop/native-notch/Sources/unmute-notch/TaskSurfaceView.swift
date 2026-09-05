import SwiftUI
import ComposerSupport

// The single-task surface — status + duration, the pending question (chips or
// free-text), done result + detail + artifacts, failed reason / mcpGap fix,
// stop / re-run / resume / kill, an on-demand live terminal — plus the crank
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
                                      running: t.status == .processing, history: t.history)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    switch composerState(alive: t.alive, canCompose: t.canCompose, status: t.status.rawValue, kind: t.kind) {
                    case .composable:
                        StageComposer(model: model, taskId: t.id, deliveryError: t.deliveryError,
                                      modelLabel: t.modelLabel, sending: t.sending ?? false,
                                      draft: t.draft, config: t.chatConfig, followup: t.followup, composerMode: t.composerMode, question: t.question)
                            .padding(.top, 9)
                    case .notRunning:
                        SessionNotRunning(model: model, taskId: t.id, reason: t.deliveryError ?? (t.canResume ? nil : "This connected session cannot resume in chat. Start an Unmute-managed conversation."), canResume: t.canResume)
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
            if t.id == "unmute-agent", t.backend == nil {
                Image(systemName: "sparkles").foregroundColor(Theme.textDim)
            } else {
                ProviderMark(backend: t.backend, terminal: t.hasTerminal)
            }
            if let origin = t.agentOriginPresentation {
                Badge(text: origin.label, color: Theme.cReady)
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
            Text(t.title).font(Theme.fTitle).foregroundColor(Theme.text).lineLimit(1)
            StatusLabel(status: t.status)
            if let e = t.elapsed { NumText(text: e) }
            Spacer(minLength: 8)
            if model.attention > 0 {
                Text("1 of \(model.attention)").font(Theme.fSub).foregroundColor(Theme.textDim)
            }
            // LAST in the row, so it lands in the corner. It once sat between two
            // Spacers with the counter to its right, which floated it into the
            // middle of the header — nowhere near where a close control belongs.
            if model.canGoBack { BackButton { model.onBack() } }
            CloseButton { model.emit(.collapsed) }
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

    private func actions(_ t: TaskDetail) -> some View {
        HStack(spacing: 6) {
            if !t.isOwned && !t.foreignAppName.isEmpty {
                KeyButton(label: "Open in \(t.foreignAppName)", symbol: "arrow.up.forward.app") { model.emit(.openInTerminal(id: t.id)) }
            } else if t.isOwned && t.alive && (t.status == .processing || t.status == .needsUser) {
                KeyButton(label: "Stop", symbol: "stop.circle") { model.emit(.kill(id: t.id)) }
            } else if !t.alive && t.canResume {
                KeyButton(label: "Resume", symbol: "play") { model.emit(.resume(id: t.id)) }
            }
            KeyButton(label: model.backgroundAudioMuted ? "Resume background audio" : "Pause background audio",
                      symbol: model.backgroundAudioMuted ? "play.circle" : "pause.circle") {
                model.backgroundAudioMuted.toggle()
                model.emit(.backgroundAudio(muted: model.backgroundAudioMuted))
            }
            Spacer(minLength: 0)
            // NOT FOR THE AGENT. It is an element of the pocket, not work you
            // dispatched: there is no process to kill and no card to drop. The
            // conversation ends by being purged on its own clock, which is a
            // different thing and is not a button.
            if t.agentOriginPresentation == nil {
                // This drops OUR card; it has never touched the agent's session. For
                // a Codex thread — which lives on until you delete it in Codex —
                // "kill" claims something we do not do and would not want to.
                KeyButton(label: "Remove",
                          danger: true, symbol: "trash") { model.emit(.remove(id: t.id)) }
            }
        }
        .padding(.top, 11)
    }

    private func footer(_ t: TaskDetail) -> some View {
        HStack(spacing: 10) {
            QuietButton(label: "Open dashboard", symbol: "square.grid.2x2") {
                model.emit(.openDashboard)
            }
            // MUTE AND THE CRANK ARE THE TASK QUEUE'S, and the Agent is not in
            // it. Muting something that is always present would have to mean
            // something new, and cranking from the chat would walk you into
            // tasks by a control that looks like it moves within this one.
            if t.agentOriginPresentation == nil {
                // Episode-mute: out of the attention strip + crank until you interact
                // with it or its state changes again. Still on the cockpit wall.
                QuietButton(label: "Mute", symbol: "bell.slash", color: Theme.textFaint) {
                    model.emit(.mute(id: t.id))
                }
                .help("Don't show again — returns when it changes or you open it")
            }
            Spacer(minLength: 0)
            SurfaceSizeControls(model: model)
            if t.agentOriginPresentation == nil {
                KeyButton(label: "Prev", symbol: "arrow.left") { model.emit(.prev) }
                // THE ONE TINTED PRIMARY — the crank.
                ActButton(label: "Next", go: true, symbol: "arrow.right") { model.emit(.next) }
            }
        }
        .padding(.top, 10)
    }
}
