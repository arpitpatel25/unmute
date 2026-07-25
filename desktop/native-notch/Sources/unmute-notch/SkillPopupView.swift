import SwiftUI

// The curator's review popup — parity with SkillReviewPopup.tsx:
// kind chip · name · ✕, the evidence strip, the kind-aware summary + bullets,
// Show details (drafted SKILL.md) / Show diff, the "Tell me what to change"
// conversation (spawns a real Claude Code session; output streams in), and the
// footer: Accept · Reject(+reason) · cancel — keep pending. Esc/scrim = cancel.
struct SkillPopupView: View {
    @ObservedObject var model: NotchModel
    @State private var showDetails = false
    @State private var rejecting = false
    @State private var rejectReason = ""
    @State private var convoText = ""

    private var p: ProposalDetail? { model.proposal }

    var body: some View {
        ZStack {
            Color.black.opacity(0.55)
                .onTapGesture { cancel() }
            if let p {
                popup(p)
            } else if model.proposalLoadingId != nil {
                ProgressView()
            }
        }
    }

    private func popup(_ p: ProposalDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // header
            HStack(spacing: 9) {
                Text(kindLabel(p.kind))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(kindColor(p.kind))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 5).fill(kindColor(p.kind).opacity(0.14)))
                Text(p.name).font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.text)
                Spacer(minLength: 0)
                Button(action: cancel) { Text("✕").font(.system(size: 15)).foregroundColor(Theme.textFaint) }
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            Divider().background(Theme.hairline)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(p.evidence)
                        .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.textFaint)
                    Text(p.summary)
                        .font(.system(size: 13.5)).foregroundColor(Color(white: 0.87))
                        .fixedSize(horizontal: false, vertical: true)
                    if let bullets = p.bullets, !bullets.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(bullets.enumerated()), id: \.offset) { _, b in
                                Text("· \(b)").font(.system(size: 12.5)).foregroundColor(Theme.textDim)
                            }
                        }
                    }
                    if p.kind != "retire", p.body != nil || p.diff != nil {
                        Button(action: { showDetails.toggle() }) {
                            Text(showDetails ? "▾ Hide details" : "▸ Show details" + (p.diff != nil ? " (diff)" : " (the drafted SKILL.md)"))
                                .font(.system(size: 12.5)).foregroundColor(Color(red: 0.25, green: 0.75, blue: 0.64))
                        }.buttonStyle(.plain)
                        if showDetails {
                            ScrollView {
                                Text(p.diff ?? p.body ?? "")
                                    .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.textDim)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 220)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.4)))
                        }
                    }
                    // Tell me what to change — the review conversation.
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Tell me what to change").font(.system(size: 12)).foregroundColor(Theme.textDim)
                        TextField("e.g. only the work account, and cc me the doc link…", text: $convoText, onCommit: {
                            let v = convoText.trimmingCharacters(in: .whitespaces)
                            guard !v.isEmpty else { return }
                            model.emit(.converseWrite(id: p.id, text: v))
                            convoText = ""
                        })
                        .textFieldStyle(.plain)
                        .font(.system(size: 13)).foregroundColor(Theme.text)
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.4)))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 1))
                        if !model.convLog.isEmpty {
                            ScrollView {
                                Text(model.convLog)
                                    .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.textDim)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 140)
                            .padding(8)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
                        }
                    }
                    .padding(.top, 4)
                }
                .padding(18)
            }

            Divider().background(Theme.hairline)
            // footer
            HStack(spacing: 9) {
                ActButton(label: "Accept", go: true) { model.emit(.suggestionAccept(id: p.id)) }
                if rejecting {
                    TextField("why? (recorded)", text: $rejectReason, onCommit: {
                        model.emit(.suggestionReject(id: p.id, reason: rejectReason))
                        close()
                    })
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5)).foregroundColor(Theme.text)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.4)))
                    ActButton(label: "confirm reject", danger: true) {
                        model.emit(.suggestionReject(id: p.id, reason: rejectReason))
                        close()
                    }
                } else {
                    ActButton(label: "Reject") { rejecting = true }
                }
                Spacer(minLength: 0)
                Button(action: cancel) {
                    Text("cancel — keep pending").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.vertical, 13)
        }
        .frame(width: 560)
        .frame(maxHeight: 620)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(white: 0.075)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.14), lineWidth: 1))
        .shadow(color: .black.opacity(0.6), radius: 34, y: 14)
        .onTapGesture {} // swallow — scrim handles cancel
    }

    private func cancel() {
        if let p { model.emit(.converseStop(id: p.id)) }
        close()
    }
    private func close() {
        model.proposal = nil
        model.proposalLoadingId = nil
        model.convLog = ""
        rejecting = false
        showDetails = false
    }

    private func kindLabel(_ k: String) -> String {
        ["new": "new skill", "narrow": "narrow", "split": "split", "merge": "merge", "retire": "retire"][k] ?? k
    }
    private func kindColor(_ k: String) -> Color {
        switch k {
        case "new": return Theme.cReady
        case "retire": return Theme.cError
        default: return Theme.cNeeds
        }
    }
}
