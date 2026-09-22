import SwiftUI
import StageSupport

// The focused Stage inside the cockpit — split (stage + sessions minirail) or
// full (terminal edge-to-edge). Header carries every per-task action: rename,
// pin/unpin, kill, delete, next, full/split, esc. Body: warm-up,
// editable note, pending question (chips or free-text), live terminal when
// alive, dead panel (re-run + artifacts) when not.
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
    @State private var confirmingDelete = false
    @State private var editingNote = false
    @State private var noteText = ""

    private var t: TaskDetail? { model.stageTask }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            HStack(alignment: .top, spacing: 0) {
                stage
                if !model.stageFull { miniRail }
            }
            if model.captureAimed {
                AimedChip(level: model.captureLevel)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.bottom, 16)
                    .allowsHitTesting(false)
            }
            SurfaceSizeControls(model: model)
                .padding(.trailing, Theme.gutter)
                .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: the stage column

    private var stage: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let t {
                header(t)
                ChatStatusView(model: model, task: t)
                messagesMode(t)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, topInset + 4)
        .padding(.bottom, 14)
    }



    /// Has this task actually finished for good?
    ///
    /// STATE, NOT `alive`. This branch used to ask whether the PTY handle was
    /// still held, which is a Claude-shaped question: for Claude a dead process
    /// did mean the session was over. It is wrong for every backend where a
    /// session outlives its process — Codex reports `task_complete` after every
    /// TURN, so a thread that was merely waiting for the next instruction was
    /// declared ended, its terminal reaped, and the panel offered to "resume" a
    /// conversation that had never stopped.
    ///
    /// A SESSION IS NEVER ENDED BY FINISHING A STEP. Finishing is what a session
    /// does between your messages; you reply and it carries on. Only an ERRAND
    /// — one question, one answer — is actually over when it reaches a terminal
    /// state.
    private func ended(_ t: TaskDetail) -> Bool {
        (t.status == .done || t.status == .failed) && t.kind != "session"
    }

    private var stageTerminalBinding: Binding<Bool> {
        Binding(get: { model.stageTerminalOpen },
                set: { model.setStageTerminalVisible($0) })
    }

    /// The message view: what was said, and the way to say the next thing.
    @ViewBuilder private func messagesMode(_ t: TaskDetail) -> some View {
        if t.hasTerminal, let warm = t.warmup, !warm.isEmpty,
           !(t.conversation ?? []).contains(where: { $0.role == "assistant" && !$0.text.isEmpty }) {
            warmupStrip(warm)
        }
        noteRow(t).padding(.top, 8)
        // ONE TRANSCRIPT FOR EVERY BACKEND. This was ConversationPanel for Codex
        // desktop and ExchangeStrip for everything else — two components showing
        // the same thing, and only one of them scrolled or filled the space it
        // was given, which is the other half of the empty-band problem.
        ConversationPanel(rows: model.stageConversationRows, id: t.id,
                          blocks: model.stageBlocks, usage: model.stageUsage,
                          running: t.status == .processing, history: t.history, canEditLatestMessage: t.canEditLatestMessage ?? false, olderMessages: t.olderMessages ?? 0,
                                      loadOlder: { model.emit(.loadOlderMessages(id: t.id)) })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, 10)
        if t.status == .needsUser, let q = t.question {
            QuestionBlock(model: model, taskId: t.id, question: q,
                          terminalOpen: stageTerminalBinding).padding(.top, 10)
        }
        if t.resuming == true {
            relaunchingRow
        } else if let reason = t.resumeError, !reason.isEmpty {
            SessionNotRunning(reason: reason)
                .padding(.top, 9)
        } else if !(t.canCompose ?? t.alive) {
            SessionNotRunning(reason: t.canResume ? nil : "This connected session cannot resume in chat. Start an Unmute-managed conversation.")
                .padding(.top, 9)
        } else {
            StageComposer(placeholder: "Reply — or hold right ⌥ and speak",
                          model: model, taskId: t.id,
                          deliveryError: t.deliveryError,
                          modelLabel: t.modelLabel, sending: t.sending ?? false,
                          draft: t.draft, config: t.chatConfig, followup: t.followup, composerMode: t.composerMode, question: t.question,
                          commands: t.commands ?? [])
                // See TaskSurfaceView: @State text outlives a card switch without this.
                .id(t.id)
                .padding(.top, 9)
        }
    }

    private var relaunchingRow: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Relaunching session…")
                .font(Theme.fSub).foregroundColor(Theme.textDim)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
        .padding(.top, 9)
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
            }
            // 2 · LIFECYCLE — BACKEND FIRST, then liveness.
            //
            // This once branched on `alive` first and put "open in Codex" in the
            // dead arm — while the same change made Codex tasks report alive, so
            // the button could never render at all. Two edits that cancelled out.
            HStack(spacing: 4) {
                // ONLY FOR A TASK THAT GENUINELY LIVES IN ANOTHER APP.
                //
                // An Agent hand-off is always a CLI session — Claude or Codex,
                // whichever the user set — so there is no other app to open it
                // in. The button was rendering on those cards anyway, labelled
                // "Open in Codex" over a Claude task, because `isOwned` alone
                // does not distinguish "not ours" from "not a desktop app".
                if !t.isOwned && !t.foreignAppName.isEmpty {
                    KeyButton(label: "Open in \(t.foreignAppName)", symbol: "arrow.up.forward.app") {
                        model.emit(.openInTerminal(id: t.id))
                    }
                } else if t.resuming == true {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("Relaunching…").font(Theme.fCap).foregroundColor(Theme.textDim)
                    }
                    .padding(.horizontal, 8)
                } else if taskShowsStop(t, blocks: model.stageBlocks) {
                    KeyButton(label: "Stop", danger: true, symbol: "stop.circle") {
                        model.emit(.kill(id: t.id))
                    }
                }
            }
            .padding(.leading, 6)
            // 3 · DESTRUCTIVE — isolated, so it is never a neighbour-miss.
            //
            // DELETE LIVES HERE, AND ONLY HERE. The pocket can only remove a
            // card from itself; the orchestrator holds every task, so it is
            // the one place a task can be deleted — and it asks first.
            KeyButton(label: "Delete from Unmute…", danger: true, symbol: "trash") {
                confirmingDelete = true
            }
            .padding(.leading, 6)
            .alert("Delete from Unmute?", isPresented: $confirmingDelete) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { model.emit(.remove(id: t.id)) }
            } message: {
                Text("This stops the task and removes it from Unmute everywhere — the pocket and the orchestrator. The provider's own conversation history stays on disk.")
            }
            // 4 · VIEW
            KeyButton(label: model.stageFull ? "Split" : "Full",
                      symbol: model.stageFull ? "rectangle.split.2x1" : "rectangle") {
                model.stageFull = stageFullState(current: model.stageFull, action: .toggle)
            }
            .padding(.leading, 6)
            // THE ONE TINTED PRIMARY.
            KeyButton(label: "Next", symbol: "chevron.right", trailingSymbol: true) { model.emit(.next) }
                .padding(.leading, 6)
            CloseButton {
                model.stageFull = stageFullState(current: model.stageFull, action: .close)
                model.emit(.closeStage)
            }
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
    /// The surface's own terminal toggle — the stage and the task surface each
    /// own one, and a terminal-only ask has to be able to open whichever it is
    /// sitting in. Without it the card can name the terminal but not reach it.
    @Binding var terminalOpen: Bool

    private var terminalOnly: Bool { question.kind == "terminal_only" }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if question.irreversible == true {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text("Irreversible").font(Theme.fCap).fontWeight(.semibold)
                }
                .foregroundColor(Theme.cError)
            }
            // A TERMINAL-ONLY ASK IS THE WHOLE ASK, so it can be long — every
            // question with every option, or a full plan in markdown. It scrolls
            // inside the card rather than pushing the terminal off the surface,
            // because the point of showing it is to decide here and act below.
            if terminalOnly {
                ScrollView {
                    RichText(text: question.text, size: 13, color: Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                terminalHandoff
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        Text(question.text)
                            .font(.system(size: 13.5)).foregroundColor(Theme.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        if let details = question.details {
                            OutputBox(tag: "proposed action and scope", text: details)
                        }
                        if question.details == nil, let choices = question.choices, !choices.isEmpty {
                            FlowChips(choices: choices) { idx in
                                if model.beginQuestion(taskId, question) {
                                    model.emit(.chooseOption(id: taskId, index: idx, reference: question.reference))
                                }
                            }
                            .disabled(model.questionBusy(taskId, question))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: question.details == nil ? 210 : 105)
                if question.details != nil, let choices = question.choices, !choices.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], alignment: .leading, spacing: 6) {
                        ForEach(Array(choices.enumerated()), id: \.offset) { index, label in
                            ChoiceChip(index: index, label: label) {
                                if model.beginQuestion(taskId, question) { model.emit(.chooseOption(id: taskId, index: index, reference: question.reference)) }
                            }
                        }
                    }.disabled(model.questionBusy(taskId, question))
                }
                if model.questionBusy(taskId, question) {
                    Text(model.questionSubmissions[taskId]?.state == "accepted" || question.acknowledgment == "accepted" ? "Answer accepted" : "Sending answer…")
                        .font(.caption).foregroundColor(Theme.textFaint)
                }
                if question.choices?.isEmpty ?? true {
                    HStack(spacing: 5) {
                        Image(systemName: "mic").font(.system(size: 9.5))
                        Text("Reply below, or hold the Remote key to add your answer").font(.system(size: 11))
                    }
                    .foregroundColor(Theme.textFaint)
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.hairline, lineWidth: 0.5))
    }

    /// SAY WHY, AND OFFER THE WAY. A refusal with no route is just a dead end,
    /// which is how this surface felt before: a card that said "answer in the
    /// terminal" beside a terminal that was closed.
    private var terminalHandoff: some View {
        HStack(spacing: 7) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 9.5))
            Text("This connected session cannot answer this request in chat. Start an Unmute-managed conversation to use supported controls.")
                .font(.system(size: 11))
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundColor(Theme.textFaint)
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

// MARK: - Dead-task panel (result / error / artifacts + re-run)

struct DeadPanel: View {
    @ObservedObject var model: NotchModel
    let t: TaskDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // "Session ended" WAS A LIE FOR HALF THE CARDS THAT SHOWED IT.
            // This panel is now reached only from `ended()` — a one-off that has
            // actually finished — so the sentence is true when it appears. It
            // used to be reached whenever the PTY handle was gone, which for a
            // session meant "finished a step", and the panel announced the end
            // of a conversation that was waiting for the next line.
            SectionLabel(text: t.kind == "session"
                ? "Waiting for you · \(Theme.statusLabel(t.status))"
                : "Finished · \(Theme.statusLabel(t.status))")

            // THE MESSAGE IS NOT OURS TO PRINT ANY MORE.
            //
            // This panel predates the chat strip, when it was the ONLY place a
            // finished result could appear — so it printed `summary` and then
            // `detail`, which is the same reply twice (the summary IS the
            // detail's first line). With the strip above now showing the reply,
            // a finished card showed it three times counting "where you left
            // off". The strip owns the message; this panel keeps only what is
            // genuinely its own — where the result POINTS, and what you can do
            // next.
            if let r = t.result {
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
                                .background(Capsule().fill(Theme.raised))
                                .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
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
                // ONLY WHEN THERE IS GENUINELY NOTHING. This said "No recorded
                // output" whenever `result.summary` was empty — including every
                // Codex CLI task, whose replies the observer failed to capture
                // because it matched an event name the CLI stopped emitting. The
                // transcript above was full and the panel underneath called it
                // empty. If there are turns, they ARE the output.
                if (t.conversation ?? []).isEmpty {
                    Text("No recorded output.").font(Theme.fBody).foregroundColor(Theme.textFaint)
                }
            }

            ActButton(label: "Re-run fresh") { model.emit(.rerun(id: t.id)) }
                .padding(.top, 3)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.hairline, lineWidth: 0.5))
    }
}
