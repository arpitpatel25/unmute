import SwiftUI

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

                // THE ASK MOVED BELOW THE REASONING (see the strip further
                // down). It was the FIRST thing on this surface, so a question
                // like "Want me to spec that first?" met you stripped of the
                // 2,800 characters that made it answerable — one line, a text
                // box, and no argument. The headline chain keeps its other
                // branches; only the question left the top.
                if terminalMode(t) {
                    // ONE EXCEPTION TO "TERMINAL ONLY": AN ASK YOU MUST ANSWER.
                    //
                    // Codex CLI's approvals now arrive over the App Server, which
                    // means the TUI never renders them — hiding the block here
                    // would leave a terminal sitting at a prompt with no visible
                    // question and no way to reply. A demand outranks the layout.
                    if t.status == .needsUser, let q = t.question {
                        QuestionBlock(model: model, taskId: t.id, question: q,
                                      terminalOpen: taskTerminalBinding).padding(.top, 10)
                    }
                    // TERMINAL MODE — THE TERMINAL IS THE PANEL.
                    //
                    // This surface used to stack the exchange strip (capped at
                    // 150pt) ABOVE the terminal, so opening the terminal gave you
                    // both at once and neither properly: messages squeezed into a
                    // band, the terminal taking what was left.
                    //
                    // A message view and a terminal view are two readings of the
                    // SAME session, not two halves of one screen. The stage was
                    // fixed first and this one was missed — which is the whole
                    // reason the redesign looked unimplemented from the outside.
                    TerminalPanel(model: model, taskId: t.id,
                                  tmuxAvailable: model.cockpit?.tmuxAvailable ?? false)
                        .id(t.id)   // ties the PTY stream to THIS task across Next/Prev
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.top, 10)
                } else {
                    // MESSAGE MODE. One transcript for every backend — this was
                    // ConversationPanel for driver backends and ExchangeStrip for
                    // the rest, two components showing the same thing where only
                    // one of them filled the space it was given.
                    ConversationPanel(rows: model.taskConversationRows, id: t.id,
                                      blocks: model.taskBlocks, usage: model.taskUsage,
                                      running: t.status == .processing)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.top, 10)
                    if t.status == .needsUser, let q = t.question {
                        QuestionBlock(model: model, taskId: t.id, question: q,
                                      terminalOpen: taskTerminalBinding).padding(.top, 12)
                    }
                    // ALWAYS OFFERED, unless this is an errand that has genuinely
                    // finished. A session that completed a step is waiting for your
                    // next line, not over — and `alive` (a PTY handle) is the wrong
                    // question to ask about that, which is what this branch used to
                    // ask before falling through to an empty Spacer.
                    if !ended(t) {
                        CodexComposer(model: model, taskId: t.id, deliveryError: t.deliveryError,
                                      modelLabel: t.modelLabel, sending: t.sending ?? false,
                                      draft: t.draft)
                            .padding(.top, 9)
                    }
                }

                actions(t)
                footer(t)
                } else {
                    allClear
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

    /// The honest end state — the moment you're free.
    private var allClear: some View {
        VStack(spacing: 7) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 22, weight: .light))
                .foregroundColor(Theme.cWorking)
            Text("All clear").font(Theme.fHead).foregroundColor(Theme.text)
            Text("Nothing needs you.").font(Theme.fSub).foregroundColor(Theme.textDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            ProviderMark(backend: t.backend, terminal: t.hasTerminal)
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


    /// Is the terminal the whole panel right now? `hasTerminal` comes from the
    /// provider registry via the engine — a backend with no PTY has no terminal
    /// to show and no toggle to offer.
    private func terminalMode(_ t: TaskDetail) -> Bool { t.hasTerminal && model.taskTerminalOpen }

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
            if !t.hasTerminal {
                // "resume" / "re-run" / "terminal" are PTY concepts and mean
                // nothing for a thread living in another app. The one thing that
                // does make sense is a door into it.
                KeyButton(label: "Open in Codex", symbol: "arrow.up.forward.app") {
                    model.emit(.openInTerminal(id: t.id))
                }
            } else {
                // STOP ONLY WHAT IS RUNNING — that one genuinely is a question
                // about the process.
                if t.alive {
                    KeyButton(label: "Stop", symbol: "stop.circle") { model.emit(.kill(id: t.id)) }
                }
                // THE TERMINAL TOGGLE IS A VIEW CONTROL, NOT A PROCESS CONTROL.
                //
                // It used to live inside `else if t.alive`, so the moment a PTY
                // was parked the button VANISHED — and with the panel now
                // offering two views, losing the toggle means being stuck in one
                // of them with no way across. A parked session still has
                // scrollback worth reading, and opening it is how you get back
                // to a session you left.
                if t.hasTerminal {
                    KeyButton(label: model.taskTerminalOpen ? "Hide terminal" : "Terminal",
                              symbol: "terminal") {
                        model.setTaskTerminalVisible(!model.taskTerminalOpen)
                    }
                }
                // Re-run and Resume belong to a task that has STOPPED, which is a
                // question about the task, not about whether a process happens to
                // be held right now.
                if ended(t) {
                    KeyButton(label: "Re-run", symbol: "arrow.clockwise") { model.emit(.rerun(id: t.id)) }
                }
                if !t.alive && t.canResume {
                    KeyButton(label: "Resume", symbol: "play") { model.emit(.resume(id: t.id)) }
                }
            }
            Spacer(minLength: 0)
            // This drops OUR card; it has never touched the agent's session. For
            // a Codex thread — which lives on until you delete it in Codex —
            // "kill" claims something we do not do and would not want to.
            KeyButton(label: t.isOwned ? "Kill" : "Remove",
                      danger: true, symbol: "trash") { model.emit(.remove(id: t.id)) }
        }
        .padding(.top, 11)
    }

    private func footer(_ t: TaskDetail) -> some View {
        HStack(spacing: 10) {
            QuietButton(label: "Open dashboard", symbol: "square.grid.2x2") {
                model.emit(.openDashboard)
            }
            // Episode-mute: out of the attention strip + crank until you interact
            // with it or its state changes again. Still on the cockpit wall.
            QuietButton(label: "Mute", symbol: "bell.slash", color: Theme.textFaint) {
                model.emit(.mute(id: t.id))
            }
            .help("Don't show again — returns when it changes or you open it")
            Spacer(minLength: 0)
            SurfaceSizeControls(model: model)
            KeyButton(label: "Prev", symbol: "arrow.left") { model.emit(.prev) }
            // THE ONE TINTED PRIMARY — the crank.
            ActButton(label: "Next", go: true, symbol: "arrow.right") { model.emit(.next) }
        }
        .padding(.top, 10)
    }
}
