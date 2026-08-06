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
        VStack(alignment: .leading, spacing: 0) {
            if let t {
                header(t)

                if t.status == .needsUser, let q = t.question {
                    QuestionBlock(model: model, taskId: t.id, question: q).padding(.top, 12)
                } else if t.backend == "codex-desktop" {
                    // NO HEADLINE for a backend that shows its whole
                    // conversation. `activity` is derived from the last agent
                    // message, which IS the last line of the transcript below —
                    // so this printed the same sentence twice, once unstyled
                    // (literal **asterisks**) and once properly. The headline
                    // earns its place only where the panel shows a terminal,
                    // because raw scrollback is not a summary.
                    EmptyView()
                } else if let summary = summaryLine(t) {
                    Text(summary)
                        .font(.system(size: 14)).foregroundColor(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                }

                // DeadPanel is a PTY concept — "the session ended, resume or
                // re-run it". A Codex thread never ends that way, so offering it
                // there is an invitation to revive something still alive.
                if (t.status == .done || t.status == .failed) && t.backend != "codex-desktop" {
                    ScrollView { DeadPanel(model: model, t: t) }
                        .frame(maxHeight: 280)
                        .padding(.top, 12)
                }

                // EXTERNAL BACKEND (Codex): no PTY exists, so the CONVERSATION is
                // what this panel carries — the same role the terminal plays for a
                // CLI task. Showing an empty terminal frame here is what made the
                // panel read as a giant void.
                if t.backend == "codex-desktop" {
                    // NOT wrapped in a ScrollView — the panel owns one. Nesting
                    // them gave the inner scroller unbounded height, so it had no
                    // overflow to scroll and the outer one scrolled instead;
                    // scrollTo then addressed a view that could not move.
                    ConversationPanel(turns: t.conversation ?? [], id: t.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.top, 10)
                    // Always available: a Codex chat is continuable until you
                    // delete it, so there is no state in which you have nothing
                    // to say to it.
                    CodexComposer(model: model, taskId: t.id, deliveryError: t.deliveryError,
                                  modelLabel: t.modelLabel, sending: t.sending ?? false)
                        .padding(.top, 9)
                } else if t.alive {
                    // The same message-then-terminal shape as the stage. The
                    // strip is bounded and renders nothing when there are no
                    // turns yet, so the terminal keeps the space it always had.
                    ExchangeStrip(turns: t.conversation ?? [], maxAnswerHeight: 150)
                        .padding(.top, 10)
                    if model.taskTerminalOpen {
                    // The terminal owns EVERYTHING left down to the action row
                    // (field feedback: never a fixed band with dead space below).
                    // .id ties the PTY stream to THIS task across Next/Prev.
                        TerminalPanel(model: model, taskId: t.id,
                                      tmuxAvailable: model.cockpit?.tmuxAvailable ?? false)
                            .id(t.id)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding(.top, 10)
                    } else {
                        Spacer(minLength: 0)
                    }
                } else {
                    Spacer(minLength: 0)
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

    private func actions(_ t: TaskDetail) -> some View {
        HStack(spacing: 6) {
            if t.backend == "codex-desktop" {
                // "resume" / "re-run" / "terminal" are PTY concepts and mean
                // nothing for a thread living in another app. The one thing that
                // does make sense is a door into it.
                KeyButton(label: "Open in Codex", symbol: "arrow.up.forward.app") {
                    model.emit(.openInTerminal(id: t.id))
                }
            } else if t.alive {
                KeyButton(label: "Stop", symbol: "stop.circle") { model.emit(.kill(id: t.id)) }
                KeyButton(label: model.taskTerminalOpen ? "Hide terminal" : "Terminal",
                          symbol: "terminal") {
                    model.taskTerminalOpen.toggle()
                    model.emit(model.taskTerminalOpen ? .termOpen(id: t.id) : .termClose(id: t.id))
                }
            } else {
                KeyButton(label: "Re-run", symbol: "arrow.clockwise") { model.emit(.rerun(id: t.id)) }
                KeyButton(label: "Resume", symbol: "play") { model.emit(.resume(id: t.id)) }
            }
            Spacer(minLength: 0)
            // This drops OUR card; it has never touched the agent's session. For
            // a Codex thread — which lives on until you delete it in Codex —
            // "kill" claims something we do not do and would not want to.
            KeyButton(label: t.backend == "codex-desktop" ? "Remove" : "Kill",
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
            KeyButton(label: "Prev", symbol: "arrow.left") { model.emit(.prev) }
            // THE ONE TINTED PRIMARY — the crank.
            ActButton(label: "Next", go: true, symbol: "arrow.right") { model.emit(.next) }
        }
        .padding(.top, 10)
    }
}
