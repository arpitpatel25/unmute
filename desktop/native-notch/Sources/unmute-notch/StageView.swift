import SwiftUI

// The focused Stage inside the cockpit — split (stage + sessions minirail) or
// full (terminal edge-to-edge). Header carries every per-task action: rename,
// pin/unpin, kill, resume, shelve, remove, next, full/split, esc. Body: warm-up,
// editable note, pending question (chips or free-text), live terminal when
// alive, dead panel (resume / re-run + artifacts) when not.
//
// HIERARCHY FROM GROUPING, NOT DECORATION. The new design system asks us to
// strip the extra backgrounds and borders that used to give buttons weight, and
// to express hierarchy through layout instead. So the header is four groups —
// curation, lifecycle, destructive, view — with ONE tinted primary (the crank).
// Nothing was removed; the spacing does the work the borders used to.
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
                // Same duplication as the task surface: for Codex, `warmup` is
                // the last agent message, which the transcript already ends
                // with. It was also drawn with plain Text, so its markdown came
                // out as literal asterisks next to a correctly-rendered copy of
                // itself two lines below.
                if t.backend != "codex-desktop", let warm = t.warmup, !warm.isEmpty {
                    warmupStrip(warm)
                }
                noteRow(t).padding(.top, 8)
                if t.status == .needsUser, let q = t.question {
                    QuestionBlock(model: model, taskId: t.id, question: q).padding(.top, 10)
                }
                if t.backend == "codex-desktop" {
                    // Wherever a Claude task shows its terminal, a Codex task
                    // shows its messages — and can be replied to. Neither the
                    // terminal nor DeadPanel belongs here: the first does not
                    // exist for this backend, and the second offered to "resume"
                    // a chat that had never stopped.
                    // The panel scrolls itself; a second ScrollView around it
                    // would disable that.
                    ConversationPanel(turns: t.conversation ?? [], id: t.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.top, 10)
                    CodexComposer(model: model, taskId: t.id, deliveryError: t.deliveryError,
                                  modelLabel: t.modelLabel, sending: t.sending ?? false)
                        .padding(.top, 9)
                } else if t.alive {
                    // MESSAGE, THEN TERMINAL — not one or the other.
                    //
                    // The exchange answers "what did I ask, what came back" at a
                    // glance; the terminal underneath is still the real thing,
                    // shown raw, for everything the headline leaves out. The
                    // strip renders nothing at all when there are no turns yet,
                    // so a fresh task looks exactly as it did before.
                    ExchangeStrip(turns: t.conversation ?? [], status: t.status)
                        .padding(.top, 10)
                    TerminalPanel(model: model, taskId: t.id,
                                  tmuxAvailable: model.cockpit?.tmuxAvailable ?? false)
                        .padding(.top, 10)
                    // Say the next thing without opening the terminal. Voice is
                    // still the primary way in — the placeholder says so — but
                    // when the stage is already open and focused, making the
                    // user reach into a PTY to type one line is the friction
                    // this surface exists to remove.
                    StageComposer(placeholder: "Reply — or hold right ⌥ and speak",
                                  model: model, taskId: t.id,
                                  deliveryError: t.deliveryError,
                                  modelLabel: t.modelLabel, sending: t.sending ?? false)
                        .padding(.top, 9)
                } else {
                    ExchangeStrip(turns: t.conversation ?? [], status: t.status)
                        .padding(.top, 10)
                    DeadPanel(model: model, t: t).padding(.top, 10)
                    Spacer(minLength: 0)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, topInset + 4)
        .padding(.bottom, 14)
    }

    private func warmupStrip(_ warm: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            SectionLabel(text: "Where you left off")
            RichText(text: warm, size: 12.5, color: Theme.textDim)
        }
        .padding(.leading, 11)
        .overlay(Rectangle().fill(Theme.hairline).frame(width: 2), alignment: .leading)
        .padding(.top, 12)
    }

    private func header(_ t: TaskDetail) -> some View {
        HStack(spacing: 6) {
            Dot(status: t.status, size: 9, breathing: t.status == .processing)
            if renaming {
                TextField("Name", text: $renameText, onCommit: {
                    let v = renameText.trimmingCharacters(in: .whitespaces)
                    if !v.isEmpty { model.emit(.rename(id: t.id, name: v)) }
                    renaming = false
                })
                .textFieldStyle(.plain)
                .font(Theme.fTitle).foregroundColor(Theme.text)
                .frame(maxWidth: 260)
            } else {
                Text(t.title)
                    .font(Theme.fTitle).foregroundColor(Theme.text)
                    .lineLimit(1)
                    .onTapGesture { renameText = t.title; renaming = true }
                    .help("Click to rename — names are voice addresses")
            }

            Spacer(minLength: 10)

            // 1 · CURATION
            HStack(spacing: 4) {
                KeyButton(label: t.kind == "session" ? "Unpin" : "Pin",
                          symbol: t.kind == "session" ? "pin.slash" : "pin") {
                    model.emit(.setKind(id: t.id, kind: t.kind == "session" ? "oneoff" : "session"))
                }
                KeyButton(label: (t.shelved ?? false) ? "Unshelve" : "Shelve",
                          symbol: "archivebox") {
                    model.emit(.shelve(id: t.id, shelved: !(t.shelved ?? false)))
                }
            }
            // 2 · LIFECYCLE — BACKEND FIRST, then liveness.
            //
            // This once branched on `alive` first and put "open in Codex" in the
            // dead arm — while the same change made Codex tasks report alive, so
            // the button could never render at all. Two edits that cancelled out.
            HStack(spacing: 4) {
                if t.backend == "codex-desktop" {
                    KeyButton(label: "Open in Codex", symbol: "arrow.up.forward.app") {
                        model.emit(.openInTerminal(id: t.id))
                    }
                } else if t.alive {
                    KeyButton(label: "Kill", danger: true, symbol: "stop.circle") {
                        model.emit(.kill(id: t.id))
                    }
                } else {
                    KeyButton(label: "Resume", symbol: "play") { model.emit(.resume(id: t.id)) }
                }
            }
            .padding(.leading, 6)
            // 3 · DESTRUCTIVE — isolated, so it is never a neighbour-miss.
            KeyButton(label: "Remove", danger: true, symbol: "trash") {
                model.emit(.remove(id: t.id))
            }
            .padding(.leading, 6)
            // 4 · VIEW
            KeyButton(label: model.stageFull ? "Split" : "Full",
                      symbol: model.stageFull ? "rectangle.split.2x1" : "rectangle") {
                model.stageFull.toggle()
            }
            .padding(.leading, 6)
            // THE ONE TINTED PRIMARY.
            ActButton(label: "Next", go: true, symbol: "arrow.right") { model.emit(.next) }
                .padding(.leading, 6)
            CloseButton { model.stageFull = false; model.emit(.closeStage) }
        }
    }

    private func noteRow(_ t: TaskDetail) -> some View {
        Group {
            if editingNote {
                HStack(spacing: 6) {
                    Image(systemName: "pencil").font(.system(size: 10)).foregroundColor(Theme.cReady)
                    TextField("Note", text: $noteText, onCommit: {
                        model.emit(.setNote(id: t.id, note: noteText))
                        editingNote = false
                    })
                    .textFieldStyle(.plain)
                    .font(Theme.fSub).foregroundColor(Theme.cReady)
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "pencil").font(.system(size: 10))
                    Text((t.note?.isEmpty == false) ? t.note!
                         : "Add a note — yours, never sent to the agent")
                        .font(Theme.fSub)
                }
                .foregroundColor((t.note?.isEmpty == false) ? Theme.cReady : Theme.textFaint)
                .contentShape(Rectangle())
                .onTapGesture { noteText = t.note ?? ""; editingNote = true }
            }
        }
    }

    // MARK: sessions minirail (split mode)

    private var miniRail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 3) {
                let all = (model.cockpit?.groups ?? []).flatMap(\.cards)
                SectionLabel(text: "Sessions · \(all.count)")
                    .padding(.horizontal, 8).padding(.bottom, 4)
                ForEach(all, id: \.id) { c in
                    RailRow(action: { model.emit(.focusTask(id: c.id)) }) {
                        Dot(status: c.status, size: 6)
                        Text(c.title).font(Theme.fBody)
                            .foregroundColor(c.id == model.focusedId ? Theme.text : Theme.textDim)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 12)
            .padding(.top, topInset)
        }
        .scrollEdge(topInset + 12)
        .frame(width: 216)
        .background(Theme.railBg)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(width: 1), alignment: .leading)
    }
}

// MARK: - Pending question (chips / free-text / confirm) — shared by Stage + task surface

struct QuestionBlock: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    let question: QuestionP
    @State private var answerText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if question.irreversible == true {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text("Irreversible").font(Theme.fCap).fontWeight(.semibold)
                }
                .foregroundColor(Theme.cError)
            }
            Text(question.text)
                .font(.system(size: 13.5)).foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if let choices = question.choices, !choices.isEmpty {
                FlowChips(choices: choices) { idx in
                    model.emit(.chooseOption(id: taskId, index: idx))
                }
            } else {
                HStack(spacing: 8) {
                    TextField(question.kind == "confirm" ? "Type to confirm…" : "Type your answer…",
                              text: $answerText, onCommit: send)
                        .textFieldStyle(.plain)
                        .font(Theme.fBody).foregroundColor(Theme.text)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                            .fill(Theme.sunken))
                        .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                            .stroke(Theme.hairline, lineWidth: 0.5))
                    ActButton(label: "Send", go: true, action: send)
                }
                HStack(spacing: 5) {
                    Image(systemName: "mic").font(.system(size: 9.5))
                    Text("or hold the Remote key and speak your answer").font(.system(size: 11))
                }
                .foregroundColor(Theme.textFaint)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .fill(Theme.cNeeds.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.cNeeds.opacity(0.26), lineWidth: 0.5))
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
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(choices.enumerated()), id: \.offset) { idx, c in
                ChoiceChip(index: idx, label: c) { onPick(idx) }
            }
        }
    }
}

private struct ChoiceChip: View {
    let index: Int
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                NumText(text: "\(index + 1)", color: Theme.textFaint).frame(width: 10, alignment: .leading)
                Text(label).font(Theme.fBody).foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(hovering ? Theme.raisedHover : Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .stroke(Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

// MARK: - Dead-task panel (result / error / artifacts + resume / re-run)

struct DeadPanel: View {
    @ObservedObject var model: NotchModel
    let t: TaskDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Session ended · \(Theme.statusLabel(t.status))")

            if let r = t.result {
                Text(r.summary).font(.system(size: 13.5)).foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let d = r.detail, !d.isEmpty {
                    ScrollView {
                        MarkdownText(text: d).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                }
                if let arts = r.artifacts, !arts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(arts.enumerated()), id: \.offset) { _, a in
                            Button(action: { model.emit(.openArtifact(type: a.type, value: a.value)) }) {
                                HStack(spacing: 5) {
                                    Image(systemName: a.type == "url"
                                          ? "arrow.up.forward.square" : "doc")
                                        .font(.system(size: 10))
                                    Text(a.value).font(Theme.fSub).lineLimit(1)
                                }
                                .foregroundColor(Theme.cReady)
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(Capsule().fill(Theme.cReady.opacity(0.11)))
                                .overlay(Capsule().stroke(Theme.cReady.opacity(0.28), lineWidth: 0.5))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            } else if let e = t.error {
                Text(e.reason).font(.system(size: 13.5)).foregroundColor(Theme.cError)
                    .fixedSize(horizontal: false, vertical: true)
                if let d = e.detail, !d.isEmpty {
                    Text(d).font(Theme.fSub).foregroundColor(Theme.textDim)
                }
            } else if let gap = t.mcpGap {
                Text(gap.message).font(Theme.fBody).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Text(gap.fixCommand)
                    .font(Theme.fTerm).foregroundColor(Theme.cReady)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
                    .onTapGesture {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(gap.fixCommand, forType: .string)
                        model.toast = "Fix command copied"
                    }
                    .help("Click to copy")
            } else {
                Text("No recorded output.").font(Theme.fBody).foregroundColor(Theme.textFaint)
            }

            HStack(spacing: 8) {
                ActButton(label: "Resume — continue with full context", go: true) {
                    model.emit(.resume(id: t.id))
                }
                ActButton(label: "Re-run fresh") { model.emit(.rerun(id: t.id)) }
            }.padding(.top, 3)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.hairline, lineWidth: 0.5))
    }
}
