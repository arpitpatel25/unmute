import SwiftUI

// The focused Stage inside the cockpit — split (stage + sessions minirail) or
// full (terminal edge-to-edge). Header carries every per-task action from the
// React wall: rename, pin/unpin, kill, resume, shelve, remove, next, full/split,
// esc. Body: warm-up, editable note, pending question (chips or free-text),
// live terminal when alive, dead panel (resume / re-run + artifacts) when not.
struct StageView: View {
    @ObservedObject var model: NotchModel
    let topInset: CGFloat

    @State private var renaming = false
    @State private var renameText = ""
    @State private var editingNote = false
    @State private var noteText = ""

    private var t: TaskDetail? { model.stageTask }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            stage
            if !model.stageFull { miniRail }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: the stage column

    private var stage: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let t {
                header(t)
                if let warm = t.warmup, !warm.isEmpty {
                    Text("where you left off — \(warm)")
                        .font(.system(size: 12.5)).foregroundColor(Theme.textDim)
                        .padding(.leading, 10)
                        .overlay(Rectangle().fill(Color.white.opacity(0.18)).frame(width: 2), alignment: .leading)
                        .padding(.top, 12)
                }
                noteRow(t).padding(.top, 6)
                if t.status == .needsUser, let q = t.question {
                    QuestionBlock(model: model, taskId: t.id, question: q).padding(.top, 8)
                }
                if t.backend == "codex-desktop" {
                    // Wherever a Claude task shows its terminal, a Codex task
                    // shows its messages — and can be replied to. Neither the
                    // terminal nor DeadPanel belongs here: the first does not
                    // exist for this backend, and the second offered to
                    // "resume" a chat that had never stopped.
                    ScrollView {
                        ConversationPanel(turns: t.conversation ?? [])
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.top, 10)
                    CodexComposer(model: model, taskId: t.id, deliveryError: t.deliveryError).padding(.top, 9)
                } else if t.alive {
                    TerminalPanel(model: model, taskId: t.id, tmuxAvailable: model.cockpit?.tmuxAvailable ?? false)
                        .padding(.top, 10)
                } else {
                    DeadPanel(model: model, t: t).padding(.top, 10)
                    Spacer(minLength: 0)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, topInset)
        .padding(.bottom, 16)
    }

    private func header(_ t: TaskDetail) -> some View {
        HStack(spacing: 6) {
            Dot(status: t.status)
            if renaming {
                TextField("name", text: $renameText, onCommit: {
                    let v = renameText.trimmingCharacters(in: .whitespaces)
                    if !v.isEmpty { model.emit(.rename(id: t.id, name: v)) }
                    renaming = false
                })
                .textFieldStyle(.plain)
                .font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.text)
                .frame(maxWidth: 260)
            } else {
                Text(t.title)
                    .font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.text)
                    .lineLimit(1)
                    .onTapGesture { renameText = t.title; renaming = true }
                    .help("click to rename — names are voice addresses")
            }
            Spacer(minLength: 8)
            KeyButton(label: t.kind == "session" ? "unpin" : "pin") {
                model.emit(.setKind(id: t.id, kind: t.kind == "session" ? "oneoff" : "session"))
            }
            // BACKEND FIRST, then liveness.
            //
            // This branched on `alive` first and put "open in Codex" in the
            // dead-session arm — while the same change made Codex tasks report
            // alive, so the button could never render on this surface at all.
            // Two edits that cancelled out; the Stage showed `kill` instead.
            if t.backend == "codex-desktop" {
                KeyButton(label: "open in Codex") { model.emit(.openInTerminal(id: t.id)) }
            } else if t.alive {
                KeyButton(label: "kill", danger: true) { model.emit(.kill(id: t.id)) }
            } else {
                KeyButton(label: "resume") { model.emit(.resume(id: t.id)) }
            }
            KeyButton(label: (t.shelved ?? false) ? "unshelve" : "shelve") {
                model.emit(.shelve(id: t.id, shelved: !(t.shelved ?? false)))
            }
            KeyButton(label: "remove", danger: true) { model.emit(.remove(id: t.id)) }
            KeyButton(label: "next") { model.emit(.next) }
            KeyButton(label: model.stageFull ? "split" : "full") { model.stageFull.toggle() }
            KeyButton(label: "esc") { model.stageFull = false; model.emit(.closeStage) }
        }
    }

    private func noteRow(_ t: TaskDetail) -> some View {
        Group {
            if editingNote {
                TextField("note", text: $noteText, onCommit: {
                    model.emit(.setNote(id: t.id, note: noteText))
                    editingNote = false
                })
                .textFieldStyle(.plain)
                .font(.system(size: 12)).foregroundColor(Theme.cReady)
            } else {
                Text("✎ \((t.note?.isEmpty == false) ? t.note! : "add a note (yours — never sent to the agent)")")
                    .font(.system(size: 12))
                    .foregroundColor((t.note?.isEmpty == false) ? Theme.cReady : Theme.textFaint)
                    .onTapGesture { noteText = t.note ?? ""; editingNote = true }
            }
        }
    }

    // MARK: sessions minirail (split mode)

    private var miniRail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                let all = (model.cockpit?.groups ?? []).flatMap(\.cards)
                Text("SESSIONS · \(all.count)")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .tracking(1.2).foregroundColor(Theme.textFaint)
                ForEach(all, id: \.id) { c in
                    Button(action: { model.emit(.focusTask(id: c.id)) }) {
                        HStack(spacing: 8) {
                            Dot(status: c.status, size: 6)
                            Text(c.title).font(.system(size: 13))
                                .foregroundColor(c.id == model.focusedId ? Theme.text : Theme.textDim)
                                .lineLimit(1)
                        }
                    }.buttonStyle(.plain)
                }
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 16)
            .padding(.top, topInset)
        }
        .frame(width: 250)
        .background(Theme.railBg)
        .overlay(Rectangle().fill(Theme.hairline).frame(width: 1), alignment: .leading)
    }
}

// MARK: - Pending question (chips / free-text / confirm) — shared by Stage + task surface

struct QuestionBlock: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    let question: QuestionP
    @State private var answerText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if question.irreversible == true {
                Text("⚠ irreversible").font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.cError)
            }
            Text(question.text)
                .font(.system(size: 13.5)).foregroundColor(Theme.cNeeds)
                .fixedSize(horizontal: false, vertical: true)
            if let choices = question.choices, !choices.isEmpty {
                FlowChips(choices: choices) { idx in
                    model.emit(.chooseOption(id: taskId, index: idx))
                }
            } else {
                HStack(spacing: 8) {
                    TextField(question.kind == "confirm" ? "type to confirm…" : "type your answer…", text: $answerText, onCommit: send)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13)).foregroundColor(Theme.text)
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 1))
                    ActButton(label: "send", go: true, action: send)
                }
                Text("🎙 or hold the Remote key and speak your answer")
                    .font(.system(size: 11)).foregroundColor(Theme.textFaint)
            }
        }
    }
    private func send() {
        let v = answerText.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        model.emit(.answerText(id: taskId, text: v))
        answerText = ""
    }
}

/// Numbered choice chips (1..N — also answerable by number keys).
struct FlowChips: View {
    let choices: [String]
    let onPick: (Int) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(choices.enumerated()), id: \.offset) { idx, c in
                Button(action: { onPick(idx) }) {
                    Text("\(idx + 1). \(c)")
                        .font(.system(size: 13)).foregroundColor(Color(red: 0.94, green: 0.83, blue: 0.60))
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(0.12)))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.accentDim, lineWidth: 1))
                }.buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Dead-task panel (result / error / artifacts + resume / re-run)

struct DeadPanel: View {
    @ObservedObject var model: NotchModel
    let t: TaskDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("session ended · \(Theme.statusLabel(t.status))")
                .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.textFaint)
            if let r = t.result {
                Text(r.summary).font(.system(size: 13.5)).foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let d = r.detail, !d.isEmpty {
                    ScrollView { MarkdownText(text: d).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 180)
                }
                if let arts = r.artifacts, !arts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(arts.enumerated()), id: \.offset) { _, a in
                            Button(action: { model.emit(.openArtifact(type: a.type, value: a.value)) }) {
                                Text("↗ \(a.value)")
                                    .font(.system(size: 12)).foregroundColor(Theme.cReady).lineLimit(1)
                                    .padding(.horizontal, 9).padding(.vertical, 5)
                                    .background(RoundedRectangle(cornerRadius: 7).fill(Theme.cReady.opacity(0.1)))
                                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.cReady.opacity(0.3), lineWidth: 1))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            } else if let e = t.error {
                Text(e.reason).font(.system(size: 13.5)).foregroundColor(Theme.cError)
                if let d = e.detail, !d.isEmpty {
                    Text(d).font(.system(size: 12)).foregroundColor(Theme.textDim)
                }
            } else if let gap = t.mcpGap {
                Text(gap.message).font(.system(size: 13)).foregroundColor(Theme.textDim)
                Text(gap.fixCommand)
                    .font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.cReady)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.4)))
                    .onTapGesture {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(gap.fixCommand, forType: .string)
                        model.toast = "fix command copied"
                    }
                    .help("click to copy")
            } else {
                Text("No recorded output.").font(.system(size: 13)).foregroundColor(Theme.textFaint)
            }
            HStack(spacing: 8) {
                ActButton(label: "resume — continue with full context", go: true) { model.emit(.resume(id: t.id)) }
                ActButton(label: "re-run fresh") { model.emit(.rerun(id: t.id)) }
            }.padding(.top, 4)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.cardBg))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
    }
}
