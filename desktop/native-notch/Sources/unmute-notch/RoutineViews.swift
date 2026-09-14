import SwiftUI
import ConversationSupport

// ROUTINES IN THE AGENT'S CHAT.
//
// Spec: docs/superpowers/specs/2026-09-14-agent-routines-design.md §2, §5
//
// One chat, no second panel. A routine shows up twice in the transcript — a
// right-aligned chip when it fires and an Agent-style reply when it finishes —
// and everything else about a run lives one tap away in the run sheet. The
// only amber on this surface is the routine's; nothing else borrows it.

/// Local 24h HH:MM for an epoch-millisecond instant.
enum RoutineClock {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
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
/// is a prompt, not an answer — just one you set up earlier.
struct RoutineRunChip: View {
    let block: Block
    let open: () -> Void

    private var status: String { block.status ?? "running" }
    private var name: String { block.name ?? "Routine" }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 40)
            Button(action: open) {
                HStack(spacing: 6) {
                    icon
                    Text(label)
                        .font(.system(size: 12))
                        .foregroundColor(status == "failed" ? Theme.cError : Theme.textDim)
                        .strikethrough(status == "cancelled", color: Theme.textFaint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.horizontal, 11).padding(.vertical, 6)
                .overlay(Capsule().stroke(Theme.routine.opacity(0.45), lineWidth: 0.75))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Open this run")
        }
    }

    @ViewBuilder private var icon: some View {
        switch status {
        case "queued", "running":
            ProgressView().controlSize(.mini)
        default:
            Image(systemName: symbol)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(status == "failed" ? Theme.cError : Theme.routine)
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
        case "queued":    return "◆ \(name) · waiting for a free slot"
        case "done":      return "✓ \(name) · done — result below"
        case "failed":    return "\(name) · failed — see below"
        case "cancelled": return "\(name) · cancelled"
        case "skipped":   return "\(name) · skipped"
        default:
            return (["◆ \(name)", "working on it", block.trigger, RoutineClock.hhmm(block.at)] as [String?])
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }
}

// MARK: - the result

/// What a routine came back with, written like an Agent reply — the same text
/// style as BlockAnswer — with a thin amber edge and the routine's name.
struct RoutineResultView: View {
    let block: Block
    let taskId: String
    let open: () -> Void
    var emit: (Event) -> Void = IPC.emit

    private var status: String { block.status ?? "done" }
    /// The routine id rides on `path` — see routine-blocks.ts, which sets
    /// `path: run.routineId` because Block has no dedicated field for it.
    private var routineId: String? { block.path.flatMap { $0.isEmpty ? nil : $0 } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: open) {
                HStack(spacing: 6) {
                    Text("◆ \(block.name ?? "Routine")")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundColor(Theme.routine)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let range { NumText(text: range) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open this run")

            content

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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 13)
        // An overlay rather than an HStack sibling, so the rule takes the
        // content's measured height instead of a flexible shape's guess.
        .overlay(alignment: .leading) { Rectangle().fill(Theme.routine).frame(width: 2) }
    }

    @ViewBuilder private var content: some View {
        switch status {
        case "failed":
            NoticeRow(text: block.reason ?? nonEmpty(block.text) ?? "The routine failed.", tone: .error)
            runAgain("Run again")
        case "skipped":
            Text(block.reason.map { "Skipped: \($0)" } ?? nonEmpty(block.text) ?? "Skipped")
                .font(.system(size: 12))
                .foregroundColor(Theme.textFaint)
                .lineLimit(1)
            // Spec §2.5: a skipped run's result offers Run now.
            runAgain("Run now")
        default:
            BlockAnswer(text: block.text ?? "")
        }
    }

    @ViewBuilder private func runAgain(_ label: String) -> some View {
        if let routineId {
            KeyButton(label: label, symbol: "arrow.clockwise") { emit(.routineRunNow(id: routineId)) }
        }
    }

    private var range: String? {
        let start = RoutineClock.hhmm(block.startedAt), end = RoutineClock.hhmm(block.at)
        switch (start, end) {
        case let (s?, e?): return "\(s) → \(e)"
        case let (s?, nil): return s
        case let (nil, e?): return e
        default: return nil
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
                .foregroundColor(Theme.routine.opacity(hovering ? 1 : 0.85))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(hovering ? Theme.raisedHover : Theme.raised))
                .overlay(Capsule().stroke(Theme.routine.opacity(0.3), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .fixedSize()
        .help("Your routines")
    }

    private var label: String {
        switch routines.items.count {
        case 0:  return "◆ Routines"
        case 1:  return "◆ 1 routine"
        default: return "◆ \(routines.items.count) routines"
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
    let close: () -> Void
    var emit: (Event) -> Void = IPC.emit

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
                            RoutineItemRow(item: item, emit: emit)
                        }
                    }
                    .padding(.trailing, 4)
                }
                Text("Or just say “every Monday at 10, …” to add one.")
                    .font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct RoutineItemRow: View {
    let item: RoutineItemP
    let emit: (Event) -> Void

    private var enabled: Bool { item.enabled ?? true }
    private var running: Bool { item.running ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(item.name).font(Theme.fBodyMed).foregroundColor(Theme.text).lineLimit(1)
                if let kind = item.kind {
                    Badge(text: kind == "takes-actions" ? "takes actions" : "read-only",
                          color: kind == "takes-actions" ? Theme.routine : Theme.textDim)
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
                Text("running now").font(.system(size: 11.5)).foregroundColor(Theme.routine)
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
                KeyButton(label: "Edit") { emit(.routineEdit(id: item.id)) }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 0.5))
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
        (["◆ \(detail.name)", detail.trigger, RoutineClock.hhmm(detail.firedAt)] as [String?])
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var statusColor: Color {
        switch detail.status {
        case "failed":             return Theme.cError
        case "running", "queued":  return Theme.routine
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
