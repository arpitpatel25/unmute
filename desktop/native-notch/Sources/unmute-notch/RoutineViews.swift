import SwiftUI
import ConversationSupport

// ROUTINES IN THE AGENT'S CHAT.
//
// Spec: docs/superpowers/specs/2026-09-14-agent-routines-design.md §2, §5
//
// One chat, no second panel. A routine shows up twice in the transcript — a
// right-aligned chip when it fires and an Agent-style reply when it finishes —
// and everything else about a run lives one tap away in the run sheet. The
// colours on this surface are each routine's own, fixed when it was created.

/// Local 24h HH:MM for an epoch-millisecond instant.
enum RoutineClock {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()
    static func hhmm(_ ms: Double?) -> String? {
        guard let ms, ms > 0 else { return nil }
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
    static func hhmm(_ ms: Int?) -> String? { hhmm(ms.map(Double.init)) }
}

// MARK: - the run chip

/// The moment a routine fired. Right-aligned like your own message because it
/// is a prompt, not an answer — just one you set up earlier. The icon carries
/// the status, so the text never repeats it with a symbol.
struct RoutineRunChip: View {
    let block: Block
    let open: () -> Void

    private var status: String { block.status ?? "running" }
    private var name: String { block.name ?? "Routine" }
    private var tint: Color { Theme.routine(block.color) }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 40)
            Button(action: open) {
                HStack(spacing: 6) {
                    icon
                    Text(label)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textDim)
                        .strikethrough(status == "cancelled", color: Theme.textFaint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.horizontal, 11).padding(.vertical, 6)
                .overlay(Capsule().stroke(tint.opacity(0.45), lineWidth: 0.75))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Open this run")
        }
    }

    @ViewBuilder private var icon: some View {
        switch status {
        case "queued", "running":
            ProgressView().controlSize(.mini).tint(tint)
        default:
            Image(systemName: symbol)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(tint)
        }
    }

    private var symbol: String {
        switch status {
        case "done":      return "checkmark"
        case "cancelled": return "xmark"
        case "failed":    return "exclamationmark.triangle"
        case "skipped":   return "forward.end"
        default:          return "circle"
        }
    }

    private var label: String {
        switch status {
        case "queued":    return "\(name) · waiting for a free slot"
        case "done":      return "\(name) · done"
        case "failed":    return "\(name) · failed"
        case "cancelled": return "\(name) · cancelled"
        case "skipped":   return "\(name) · skipped"
        default:          return "\(name) · working on it"
        }
    }
}

// MARK: - the result

/// What a routine came back with, laid out exactly like a question and its
/// answer: the routine on the right as the "question" bubble, marked with its
/// colour, and the response underneath in the Agent's own text style with a
/// thin rule in the same colour. Either half opens the run sheet.
struct RoutineResultView: View {
    let block: Block
    let taskId: String
    let open: () -> Void
    var emit: (Event) -> Void = IPC.emit
    /// See Theme.userBubble: the lift is tone-aware.
    @ObservedObject private var appearance = Appearance.shared

    private var status: String { block.status ?? "done" }
    private var tint: Color { Theme.routine(block.color) }
    /// The routine id rides on `path` — see routine-blocks.ts, which sets
    /// `path: run.routineId` because Block has no dedicated field for it.
    private var routineId: String? { block.path.flatMap { $0.isEmpty ? nil : $0 } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 0) {
                Spacer(minLength: 40)
                Button(action: open) { bubble }
                    .buttonStyle(.plain)
                    .help("Open this run")
            }

            VStack(alignment: .leading, spacing: 8) {
                content
                    .contentShape(Rectangle())
                    .onTapGesture(perform: open)

                if let proposals = block.proposals, !proposals.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(proposals, id: \.id) { p in
                            RoutineProposalRow(proposal: p) { decision in
                                guard let runId = block.what, !runId.isEmpty else { return }
                                emit(.routineProposal(runId: runId, proposalId: p.id, decision: decision))
                            }
                        }
                    }
                }
                actions
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 13)
            // An overlay rather than an HStack sibling, so the rule takes the
            // content's measured height instead of a flexible shape's guess.
            .overlay(alignment: .leading) { Rectangle().fill(tint).frame(width: 2) }
        }
    }

    private var bubble: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(tint).frame(width: 7, height: 7)
                .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 2) {
                Text(block.name ?? "Routine")
                    .font(.system(size: 14))
                    .foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let caption {
                    Text(caption)
                        .font(.system(size: 11.5))
                        .foregroundColor(Theme.textFaint)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 20).fill(Theme.userBubble))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.userBubbleEdge, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 20))
    }

    /// What fired it and when, e.g. "Scheduled · 22:16".
    private var caption: String? {
        let t = block.trigger ?? ""
        let what: String? = t.hasSuffix("schedule") ? "Scheduled"
            : t == "notes ready" ? "Meeting notes ready"
            : t == "approved" ? "Approved"
            : t.isEmpty ? nil : t
        let parts = [what, RoutineClock.hhmm(block.startedAt) ?? RoutineClock.hhmm(block.at)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var content: some View {
        switch status {
        case "failed":
            // `reason` is a code (timeout, missed, …); `text` is the sentence
            // written for people, so only `text` is ever shown.
            NoticeRow(text: nonEmpty(block.text) ?? "The routine failed.", tone: .error)
        case "skipped":
            Text(nonEmpty(block.text) ?? "Skipped")
                .font(.system(size: 13))
                .foregroundColor(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        default:
            BlockAnswer(text: block.text ?? "")
        }
    }

    @ViewBuilder private var actions: some View {
        switch status {
        case "failed": runAgain("Run again")
        // Spec §2.5: a missed clock fire offers Run now. Other skips (e.g.
        // nothing in the window) would only skip again.
        case "skipped" where block.reason == "missed": runAgain("Run now")
        default: EmptyView()
        }
    }

    @ViewBuilder private func runAgain(_ label: String) -> some View {
        if let routineId {
            KeyButton(label: label, symbol: "arrow.clockwise") { emit(.routineRunNow(id: routineId)) }
        }
    }

    private func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }
}

/// Something a takes-actions routine wants done but never does itself.
private struct RoutineProposalRow: View {
    let proposal: BlockProposal
    let decide: (String) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(proposal.title)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if !proposal.detail.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.14)) { expanded.toggle() } } label: {
                    Text(proposal.detail)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(expanded ? "Show less" : "Show more")
            }
            HStack(spacing: 6) {
                if proposal.state == "open" {
                    KeyButton(label: "Do it") { decide("approve") }
                    QuietButton(label: "Skip") { decide("dismiss") }
                } else {
                    Text(stateLabel)
                        .font(.system(size: 11))
                        .foregroundColor(proposal.state == "failed" ? Theme.cError : Theme.textFaint)
                }
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.hairline, lineWidth: 0.5))
    }

    private var stateLabel: String {
        switch proposal.state {
        case "running":   return "Doing…"
        case "done":      return "Done"
        case "failed":    return "Couldn't do it"
        case "dismissed": return "Skipped"
        default:          return proposal.state
        }
    }
}

// MARK: - header button

/// Quiet, always there: your routines are one tap away even when none is running.
struct RoutinesHeaderButton: View {
    let routines: RoutinesPayload
    let show: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: show) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(hovering ? Theme.text : Theme.textDim)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(hovering ? Theme.raisedHover : Theme.raised))
                .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .fixedSize()
        .help("Your routines")
    }

    private var label: String {
        switch routines.items.count {
        case 0:  return "Routines"
        case 1:  return "1 routine"
        default: return "\(routines.items.count) routines"
        }
    }
}

// MARK: - sheets

/// The card both sheets sit on: the Agent's own ground, so it reads as part of
/// the panel rather than a window on top of it.
private struct RoutineSheetCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content() }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.agentSurface))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.hairline, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
    }
}

struct RoutinesSheet: View {
    let routines: RoutinesPayload
    /// The Agent's delivery error — where a rejected edit (bad schedule, empty
    /// prompt) comes back, shown inside the open editor.
    var error: String? = nil
    let close: () -> Void
    var emit: (Event) -> Void = IPC.emit
    @State private var editingId: String?

    var body: some View {
        RoutineSheetCard {
            HStack {
                Text("Your routines").font(Theme.fHead).foregroundColor(Theme.text)
                Spacer(minLength: 8)
                KeyButton(label: "Done", action: close)
            }
            if !routines.available {
                Text(routines.reason ?? "Routines are unavailable right now.")
                    .font(Theme.fSub).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if routines.items.isEmpty {
                Text("No routines yet. Say “every weekday at 9, tell me what I worked on yesterday.”")
                    .font(Theme.fSub).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(routines.items, id: \.id) { item in
                            if editingId == item.id {
                                RoutineEditForm(item: item, error: error,
                                                close: { editingId = nil }, emit: emit)
                            } else {
                                RoutineItemRow(item: item, edit: { editingId = item.id }, emit: emit)
                            }
                        }
                    }
                    .padding(.trailing, 4)
                }
                if editingId == nil {
                    Text("Or just say “every Monday at 10, …” to add one.")
                        .font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

private struct RoutineItemRow: View {
    let item: RoutineItemP
    let edit: () -> Void
    let emit: (Event) -> Void

    private var enabled: Bool { item.enabled ?? true }
    private var running: Bool { item.running ?? false }
    private var tint: Color { Theme.routine(item.color) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text(item.name).font(Theme.fBodyMed).foregroundColor(Theme.text).lineLimit(1)
                if let kind = item.kind {
                    Badge(text: kind == "takes-actions" ? "takes actions" : "read-only",
                          color: kind == "takes-actions" ? tint : Theme.textDim)
                }
                if !enabled { Badge(text: "paused", color: Theme.textFaint) }
                Spacer(minLength: 0)
            }
            let schedule = [item.scheduleLabel, item.nextRunLabel.map { "next: \($0)" }]
                .compactMap { $0 }.joined(separator: " · ")
            if !schedule.isEmpty {
                Text(schedule).font(.system(size: 11.5)).foregroundColor(Theme.textDim).lineLimit(2)
            }
            if running {
                Text("running now").font(.system(size: 11.5)).foregroundColor(tint)
            } else if let last = item.lastRunLabel {
                Text(last).font(.system(size: 11.5)).foregroundColor(Theme.textFaint).lineLimit(1)
            }
            if let error = item.error {
                Text(error).font(.system(size: 11.5)).foregroundColor(Theme.cError)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                KeyButton(label: "Run now") { emit(.routineRunNow(id: item.id)) }
                    .disabled(running || item.error != nil)
                    .opacity(running || item.error != nil ? 0.45 : 1)
                KeyButton(label: enabled ? "Pause" : "Resume") {
                    emit(.routineSetEnabled(id: item.id, enabled: !enabled))
                }
                KeyButton(label: "Edit", action: edit)
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 0.5))
    }
}

/// A routine's row opened into a form: every field separate, composed back
/// into the canonical grammar text the engine validates (RoutineFormSupport).
private struct RoutineEditForm: View {
    let item: RoutineItemP
    let error: String?
    let close: () -> Void
    let emit: (Event) -> Void

    @State private var name: String
    @State private var schedule: RoutineScheduleDraft
    @State private var window: RoutineWindowDraft
    @State private var kind: String
    @State private var prompt: String
    /// Set once Save is sent; the form closes when the saved values come back.
    @State private var saving = false
    private let rawSchedule: String

    init(item: RoutineItemP, error: String?, close: @escaping () -> Void, emit: @escaping (Event) -> Void) {
        self.item = item; self.error = error; self.close = close; self.emit = emit
        rawSchedule = item.schedule ?? ""
        _name = State(initialValue: item.name)
        _schedule = State(initialValue: RoutineScheduleDraft.parse(item.schedule ?? ""))
        _window = State(initialValue: RoutineWindowDraft.parse(item.window ?? ""))
        _kind = State(initialValue: item.kind == "takes-actions" ? "takes-actions" : "read-only")
        _prompt = State(initialValue: item.prompt ?? "")
    }

    private var tint: Color { Theme.routine(item.color) }

    private var fields: [String: String] {
        ["name": name.trimmingCharacters(in: .whitespacesAndNewlines),
         "schedule": schedule.text,
         "window": window.text,
         "kind": kind,
         "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines)]
    }

    private var current: [String: String] {
        ["name": item.name, "schedule": item.schedule ?? "", "window": item.window ?? "",
         "kind": item.kind ?? "read-only", "prompt": item.prompt ?? ""]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text("Edit routine").font(Theme.fBodyMed).foregroundColor(Theme.text)
                Spacer(minLength: 0)
            }

            section("Name") {
                TextField("Name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12.5))
            }

            section("How often") {
                Picker("How often", selection: $schedule.frequency) {
                    ForEach(RoutineFrequency.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
                if !schedule.recognised, !rawSchedule.isEmpty {
                    Text("Couldn’t read “\(rawSchedule)”, so this shows Daily 09:00.")
                        .font(.system(size: 11)).foregroundColor(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if schedule.frequency == .specificDays { dayChips }
                if schedule.frequency.usesClock {
                    HStack(spacing: 6) {
                        Text("at").font(.system(size: 12)).foregroundColor(Theme.textDim)
                        DatePicker("Time", selection: timeBinding, displayedComponents: .hourAndMinute)
                            .labelsHidden()
                            .datePickerStyle(.field)
                            .environment(\.locale, Locale(identifier: "en_GB"))
                            .fixedSize()
                    }
                }
                if schedule.frequency == .everyHours {
                    Stepper(value: $schedule.everyHours, in: RoutineScheduleDraft.hourRange) {
                        stepperLabel("Every \(schedule.everyHours) \(schedule.everyHours == 1 ? "hour" : "hours")")
                    }
                }
                if schedule.frequency == .everyMinutes {
                    Stepper(value: $schedule.everyMinutes, in: RoutineScheduleDraft.minuteRange,
                            step: RoutineScheduleDraft.minuteStep) {
                        stepperLabel("Every \(schedule.everyMinutes) minutes")
                    }
                }
            }

            section("Time period to look at") {
                Picker("Time period", selection: $window.choice) {
                    ForEach(RoutineWindowChoice.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
                if window.choice == .lastHours {
                    Stepper(value: $window.hours, in: RoutineWindowDraft.hourRange) {
                        stepperLabel("Last \(window.hours) \(window.hours == 1 ? "hour" : "hours")")
                    }
                }
                if window.choice == .lastDays {
                    Stepper(value: $window.days, in: RoutineWindowDraft.dayRange) {
                        stepperLabel("Last \(window.days) \(window.days == 1 ? "day" : "days")")
                    }
                }
            }

            section("Kind") {
                Picker("Kind", selection: $kind) {
                    Text("Read-only").tag("read-only")
                    Text("Takes actions").tag("takes-actions")
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
            }

            section("Prompt") {
                TextEditor(text: $prompt)
                    .font(.system(size: 12.5))
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .frame(minHeight: 110, maxHeight: 200)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.hairline, lineWidth: 0.5))
            }

            if saving, let error, !error.isEmpty {
                Text(error).font(.system(size: 11.5)).foregroundColor(Theme.cError)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 6) {
                KeyButton(label: saving ? "Saving…" : "Save", action: save)
                QuietButton(label: "Cancel", action: close)
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(tint.opacity(0.45), lineWidth: 0.75))
        // The saved values coming back is the success signal.
        .onChange(of: current) { _ in if saving { close() } }
    }

    private func save() {
        if fields == current { close(); return }
        saving = true
        emit(.routineUpdate(id: item.id, fields: fields))
    }

    private var dayChips: some View {
        HStack(spacing: 4) {
            ForEach(0..<7, id: \.self) { index in
                let on = schedule.days.contains(index)
                Button {
                    if on { schedule.days.remove(index) } else { schedule.days.insert(index) }
                } label: {
                    Text(RoutineScheduleDraft.dayLabels[index])
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(on ? Theme.text : Theme.textDim)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(on ? tint.opacity(0.22) : Theme.raised))
                        .overlay(Capsule().stroke(on ? tint.opacity(0.6) : Theme.hairline, lineWidth: 0.5))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: { Calendar.current.date(bySettingHour: schedule.hour, minute: schedule.minute, second: 0, of: Date()) ?? Date() },
            set: { date in
                let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                schedule.hour = c.hour ?? 9
                schedule.minute = c.minute ?? 0
            })
    }

    private func stepperLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundColor(Theme.text).monospacedDigit()
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundColor(Theme.textFaint)
            content()
        }
    }
}

/// One run's own session, behind the Agent. Reachable, never prominent.
struct RoutineRunSheet: View {
    let detail: RoutineRunDetailP
    let close: () -> Void
    var emit: (Event) -> Void = IPC.emit

    var body: some View {
        RoutineSheetCard {
            HStack(spacing: 8) {
                Text(title).font(Theme.fHead).foregroundColor(Theme.text).lineLimit(1)
                Badge(text: detail.status, color: statusColor)
                Spacer(minLength: 8)
                KeyButton(label: "Close", action: close)
            }
            Text("This run’s own session — behind the Agent, kept here for when you need to check or stop it.")
                .font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        if let w = detail.windowLabel { mono("window \(w)") }
                        if let t = detail.totals { mono("read \(t)") }
                        if let p = detail.provider { mono("provider \(p)") }
                        ForEach(Array((detail.activity ?? []).enumerated()), id: \.offset) { _, line in
                            mono("\(RoutineClock.hhmm(line.at) ?? "--:--") \(line.text)")
                        }
                    }
                    if let error = detail.error, !error.isEmpty {
                        NoticeRow(text: error, tone: .error)
                    } else if let result = detail.result, !result.isEmpty {
                        BlockAnswer(text: result)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 4)
            }
            HStack(spacing: 6) {
                if detail.canCancel == true {
                    KeyButton(label: "Cancel run", danger: true) { emit(.routineCancel(runId: detail.runId)) }
                }
                if detail.hasTranscript == true {
                    KeyButton(label: "Open transcript") { emit(.routineOpenTranscript(runId: detail.runId)) }
                }
            }
        }
    }

    private var title: String {
        ([detail.name, detail.trigger, RoutineClock.hhmm(detail.firedAt)] as [String?])
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var statusColor: Color {
        switch detail.status {
        case "failed":             return Theme.cError
        case "running", "queued":  return Theme.routine(detail.color)
        default:                   return Theme.textDim
        }
    }

    private func mono(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Theme.textDim)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}
