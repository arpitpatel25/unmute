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
                Badge(text: kindLabel(p.kind), color: kindColor(p.kind))
                Text(p.name).font(Theme.fTitle).foregroundColor(Theme.text)
                Spacer(minLength: 0)
                CloseButton(action: cancel)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            Divider().background(Theme.hairlineSoft)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(p.evidence)
                        .font(Theme.fSub).foregroundColor(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                    // A DECISION surface, not a glance surface — wider measure
                    // and a larger body than anything else in the notch, because
                    // this is read and weighed rather than scanned.
                    Text(p.summary)
                        .font(.system(size: 13.5)).foregroundColor(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let bullets = p.bullets, !bullets.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(bullets.enumerated()), id: \.offset) { _, b in
                                HStack(alignment: .top, spacing: 7) {
                                    Text("•").font(Theme.fSub).foregroundColor(Theme.textFaint)
                                    Text(b).font(Theme.fSub).foregroundColor(Theme.textDim)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    if p.kind != "retire", p.body != nil || p.diff != nil {
                        Button(action: { showDetails.toggle() }) {
                            HStack(spacing: 5) {
                                Image(systemName: showDetails ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 9, weight: .semibold))
                                Text(showDetails
                                     ? "Hide details"
                                     : (p.diff != nil ? "Show diff" : "Show the drafted SKILL.md"))
                                    .font(Theme.fSub)
                            }
                            .foregroundColor(Theme.cReady)
                        }.buttonStyle(.plain)
                        if showDetails {
                            ScrollView {
                                Text(p.diff ?? p.body ?? "")
                                    .font(Theme.fTerm).foregroundColor(Theme.textDim)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 220)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
                        }
                    }
                    // Tell me what to change — the review conversation.
                    VStack(alignment: .leading, spacing: 7) {
                        SectionLabel(text: "Tell me what to change")
                        TextField("e.g. only the work account, and cc me the doc link…", text: $convoText, onCommit: {
                            let v = convoText.trimmingCharacters(in: .whitespaces)
                            guard !v.isEmpty else { return }
                            model.emit(.converseWrite(id: p.id, text: v))
                            convoText = ""
                        })
                        .textFieldStyle(.plain)
                        .font(Theme.fBody).foregroundColor(Theme.text)
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
                        .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                            .stroke(Theme.hairline, lineWidth: 0.5))
                        if !model.convLog.isEmpty {
                            ScrollView {
                                Text(model.convLog)
                                    .font(Theme.fTerm).foregroundColor(Theme.textDim)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 140)
                            .padding(9)
                            .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
                        }
                    }
                    .padding(.top, 4)
                }
                .padding(18)
            }

            Divider().background(Theme.hairlineSoft)
            // footer — ONE tinted primary; everything else recedes.
            HStack(spacing: 9) {
                ActButton(label: "Accept — write the skill", go: true) {
                    model.emit(.suggestionAccept(id: p.id))
                }
                if rejecting {
                    TextField("Why? (recorded)", text: $rejectReason, onCommit: {
                        model.emit(.suggestionReject(id: p.id, reason: rejectReason))
                        close()
                    })
                    .textFieldStyle(.plain)
                    .font(Theme.fSub).foregroundColor(Theme.text)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.sunken))
                    .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius)
                        .stroke(Theme.hairline, lineWidth: 0.5))
                    ActButton(label: "Confirm reject", danger: true) {
                        model.emit(.suggestionReject(id: p.id, reason: rejectReason))
                        close()
                    }
                } else {
                    ActButton(label: "Reject") { rejecting = true }
                }
                Spacer(minLength: 0)
                QuietButton(label: "Cancel — keep pending", color: Theme.textFaint, action: cancel)
            }
            .padding(.horizontal, 18).padding(.vertical, 13)
        }
        .frame(width: 560)
        .frame(maxHeight: 620)
        .background(RoundedRectangle(cornerRadius: 14)
            .fill(Color(red: 0.10, green: 0.11, blue: 0.13)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.hairline, lineWidth: 0.5))
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
