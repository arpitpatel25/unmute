import SwiftUI

// The single-task surface (~55% of the screen) — full parity with the old
// right-overlay's expanded task row: status + duration, the pending question
// (chips or free-text), done result + detail + artifacts, failed reason /
// mcpGap fix, stop / re-run / resume / kill, an on-demand live terminal —
// plus the crank (Next + "1 of N") and Open dashboard.
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
                        .font(.system(size: 14.5)).foregroundColor(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                }
                // DeadPanel is a PTY concept — "the session ended, resume or
                // re-run it". A Codex thread never ends that way, so offering
                // it there is an invitation to revive something still alive.
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
                    ScrollView {
                        ConversationPanel(turns: t.conversation ?? [])
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.top, 10)
                    // Always available: a Codex chat is continuable until you
                    // delete it, so there is no state in which you have nothing
                    // to say to it.
                    CodexComposer(model: model, taskId: t.id, deliveryError: t.deliveryError).padding(.top, 9)
                } else if model.taskTerminalOpen && t.alive {
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
                actions(t)
                footer(t)
            } else {
                Text("All clear — nothing needs you.")
                    .font(.system(size: 14)).foregroundColor(Theme.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 26)
        .padding(.top, topInset)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func summaryLine(_ t: TaskDetail) -> String? {
        t.activity ?? t.result?.summary ?? t.error?.reason
    }

    private func header(_ t: TaskDetail) -> some View {
        HStack(spacing: 9) {
            Dot(status: t.status, size: 9)
            Text(t.title).font(.system(size: 19, weight: .semibold)).foregroundColor(Theme.text).lineLimit(1)
            Text(Theme.statusLabel(t.status))
                .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.status(t.status))
            if let e = t.elapsed { Text(e).font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.textFaint) }
            Spacer(minLength: 0)
            if model.attention > 0 {
                Text("1 of \(model.attention)")
                    .font(.system(size: 13)).foregroundColor(Theme.textDim)
            }
        }
    }

    private func actions(_ t: TaskDetail) -> some View {
        HStack(spacing: 7) {
            if t.backend == "codex-desktop" {
                // "resume" / "re-run" / "terminal" are PTY concepts and mean
                // nothing for a thread living in another app. The one thing that
                // does make sense is a door into it — the Codex equivalent of
                // "show me the terminal".
                ActButton(label: "open in Codex") { model.emit(.openInTerminal(id: t.id)) }
            } else if t.alive {
                ActButton(label: "stop") { model.emit(.kill(id: t.id)) }
                ActButton(label: model.taskTerminalOpen ? "hide terminal" : "terminal") {
                    model.taskTerminalOpen.toggle()
                    model.emit(model.taskTerminalOpen ? .termOpen(id: t.id) : .termClose(id: t.id))
                }
            } else {
                ActButton(label: "re-run") { model.emit(.rerun(id: t.id)) }
                ActButton(label: "resume") { model.emit(.resume(id: t.id)) }
            }
            Spacer(minLength: 0)
            ActButton(label: "kill", danger: true) { model.emit(.remove(id: t.id)) }
        }
        .padding(.top, 10)
    }

    private func footer(_ t: TaskDetail) -> some View {
        HStack(spacing: 14) {
            Button(action: { model.emit(.openDashboard) }) {
                Text("Open dashboard →").font(.system(size: 12.5)).foregroundColor(Theme.textDim)
            }.buttonStyle(.plain)
            // Episode-mute: out of the attention strip + crank until you interact
            // with it or its state changes again. Still on the cockpit wall.
            Button(action: { model.emit(.mute(id: t.id)) }) {
                Text("mute").font(.system(size: 12.5)).foregroundColor(Theme.textFaint)
            }.buttonStyle(.plain).help("don't show again — returns when it changes or you open it")
            Spacer(minLength: 0)
            ActButton(label: "← Prev") { model.emit(.prev) }
            ActButton(label: "Next →", go: true) { model.emit(.next) }
        }
        .padding(.top, 10)
    }
}
