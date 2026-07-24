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
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if t.status == .needsUser, let q = t.question {
                            QuestionBlock(model: model, taskId: t.id, question: q)
                        } else if let summary = summaryLine(t) {
                            Text(summary)
                                .font(.system(size: 14.5)).foregroundColor(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if t.status == .done || t.status == .failed { DeadPanel(model: model, t: t) }
                        if model.taskTerminalOpen && t.alive {
                            TerminalPanel(model: model, taskId: t.id,
                                          tmuxAvailable: model.cockpit?.tmuxAvailable ?? false)
                                .frame(height: 300)
                        }
                    }
                    .padding(.top, 12)
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
            if t.alive {
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
        HStack(spacing: 10) {
            Button(action: { model.emit(.openDashboard) }) {
                Text("Open dashboard →").font(.system(size: 12.5)).foregroundColor(Theme.textDim)
            }.buttonStyle(.plain)
            Spacer(minLength: 0)
            ActButton(label: "Next →", go: true) { model.emit(.next) }
        }
        .padding(.top, 10)
    }
}
