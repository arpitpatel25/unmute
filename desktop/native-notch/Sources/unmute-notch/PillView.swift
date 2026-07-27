import SwiftUI

// THE PILL CLUSTER — one glass system, not six chips.
//
// ANATOMY IS THE ORIGINAL WIDGET'S, VERBATIM. The first build invented a set of
// labels the pill never carried — "Listening", "New task", "Transcribing…",
// "Pasted" — and lost three states entirely. Checked against Widget.tsx on main,
// the pill says:
//
//   recording        dot (or the Remote glyph) + timer + stop.  NO LABEL, NO
//                    WAVEFORM. `analyserNode` is a prop the original never
//                    renders; the .unmute-pill-waveform class is vestigial.
//   processing       dot + "Processing" / "Taking longer…" / "On-device",
//                    three bouncing dots, and one optional trailing affordance
//   output           a green tick and NOTHING else — "silent success ack (text
//                    is already at the cursor)"
//   output-fallback  warning glyph + why + what was pasted
//   too-short        "Didn't catch that"
//   cancelled        "Cancelled" + Undo        ← Undo lives HERE, not on success
//   error            ✗ + the message + how to retry
//
// Text appears only where something needs explaining. The two states you look at
// most are wordless.
//
// MATERIAL: one path, behind-window. SwiftUI's .glassEffect samples content
// WITHIN the window; this panel is transparent and floats over other apps, so
// it had nothing to refract and rendered flat grey. See GlassLip.swift.

/// Applies the cluster's material to one element.
private struct PillGlass<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color? = nil
    @ObservedObject private var appearance = Appearance.shared

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    if appearance.translucent {
                        // The sampler — the desktop behind this window.
                        VisualEffectBackdrop(material: .hudWindow)
                        // Black glass. The wash was 0.58 on top of an already
                        // dark material, which totalled nearly opaque — the
                        // wallpaper was technically there and invisible. At 0.30
                        // the surface still reads black on a white page and you
                        // can genuinely see colour move behind it.
                        Color(red: 0.016, green: 0.020, blue: 0.030).opacity(0.30)
                        if let tint { tint.opacity(0.18) }
                    } else {
                        Color(red: 0.055, green: 0.06, blue: 0.075)
                        if let tint { tint.opacity(0.14) }
                    }
                }
                .clipShape(shape)
                .overlay(shape.stroke(Glass.rim(highlight: tint ?? .white), lineWidth: 1))
                .shadow(color: .black.opacity(0.34), radius: 14, y: 5)
            }
            .animation(Theme.flip, value: appearance.translucent)
    }
}

private extension View {
    func pillGlass<S: Shape>(_ shape: S, tint: Color? = nil) -> some View {
        modifier(PillGlass(shape: shape, tint: tint))
    }
}

struct PillView: View {
    @ObservedObject var model: PillModel

    private var s: PillState { model.state }

    /// Chips ride with the pill only while a capture is live — the same rule the
    /// original used (`pillShowing`): recording or processing, nothing else.
    private var chipsVisible: Bool {
        s.phase == .recording || s.phase == .processing
    }

    var body: some View {
        VStack(spacing: 9) {
            Spacer(minLength: 0)
            if chipsVisible, let c = s.coaching { CoachingChip(coaching: c) }
            cluster
            if chipsVisible, let reason = s.offline {
                OfflineCard(reason: reason,
                            onFix: { model.emit(.openBillingPortal) },
                            onDismiss: { model.emit(.dismissOffline) })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 4)
        .animation(Theme.morph, value: s.phase)
        .animation(Theme.morph, value: s.stagedCount)
    }

    /// Always a single horizontal row, and EVERY element is 44pt tall.
    ///
    /// The chips were 32pt beside a 44pt pill, which is what made the row read
    /// as mismatched parts rather than one instrument. The original sets
    /// `height: 44, borderRadius: 9999` on the pill, the model badge, the agent,
    /// the raw toggle, the staged chip and the mic chip alike — one height, one
    /// radius, no exceptions. Restored.
    private var cluster: some View {
        HStack(spacing: 8) {
            if chipsVisible && s.kind == .remote {
                // MODEL + AGENT ARE ONE CAPSULE, split by a hairline — "which
                // agent" and "which model" are a single decision, because the
                // agent decides which models exist. They were two separate
                // floating chips, which said the opposite.
                if s.model != nil || s.agent != nil {
                    HStack(spacing: 0) {
                        if let m = s.model {
                            MenuChip(label: m, symbol: "sparkles", symbolColor: Theme.cNeeds,
                                     options: s.modelOptions ?? []) { model.emit(.pickModel($0)) }
                        }
                        if s.model != nil && s.agent != nil {
                            Rectangle().fill(Color.white.opacity(0.24))
                                .frame(width: 1, height: PillMetrics.height)
                        }
                        if let a = s.agent {
                            MenuChip(label: a, symbol: "chevron.left.forwardslash.chevron.right",
                                     symbolColor: Theme.textDim,
                                     options: s.agentOptions ?? []) { model.emit(.pickAgent($0)) }
                        }
                    }
                    .frame(height: PillMetrics.height)
                    .pillGlass(Capsule())
                }
                if let raw = s.raw {
                    RawChip(on: raw) { model.emit(.toggleRaw(!raw)) }.pillGlass(Capsule())
                }
            }

            pill.pillGlass(Capsule(), tint: pillTint)

            if chipsVisible {
                if s.stagedCount > 0 {
                    StagedChip(count: s.stagedCount) { model.emit(.clearStaged) }
                        .pillGlass(Capsule())
                }
                if let opts = s.micOptions, opts.count > 1 {
                    MicChip(current: s.mic, options: opts) { model.emit(.pickMic($0)) }
                        .pillGlass(Capsule())
                }
            }
        }
    }

    /// Only the two states that are telling you something wrong carry a wash.
    private var pillTint: Color? {
        switch s.phase {
        case .error:          return Theme.cError
        case .outputFallback: return Theme.cNeeds
        default:              return nil
        }
    }

    // MARK: - The pill, per state

    @ViewBuilder private var pill: some View {
        switch s.phase {
        case .hidden:
            EmptyView()

        case .recording:
            // dot (or the Remote glyph) + timer + stop. Nothing else, ever.
            HStack(spacing: 11) {
                if s.kind == .remote {
                    // A Remote capture reads as Remote AT A GLANCE, from the
                    // glyph — which is why the original swapped the dot rather
                    // than adding a word.
                    RemoteGlyph()
                } else {
                    RecordDot()
                }
                TimerText(elapsed: s.elapsed, max: s.maxSeconds)
                StopButton { model.emit(.stop) }
            }
            .padding(.leading, 15).padding(.trailing, 7)
            .frame(height: PillMetrics.height)

        case .processing:
            HStack(spacing: 10) {
                Circle().fill(Theme.text.opacity(0.85)).frame(width: 8, height: 8)
                    .modifier(Breathing())
                Text(processingLabel)
                    .font(.system(size: 15, weight: .medium)).foregroundColor(Theme.text)
                BouncingDots()
                if s.draftOffer {
                    CapsuleButton(label: "Use quick draft") { model.emit(.acceptDraft) }
                } else if s.engineNotice {
                    Text("offline model").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                } else if s.showDiscardHint {
                    Text("Esc to discard").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                }
            }
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)

        case .output:
            // SILENT SUCCESS. The text is already at the cursor; anything more
            // is the pill talking about itself.
            Image(systemName: "checkmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(Theme.cWorking)
                .frame(width: PillMetrics.height, height: PillMetrics.height)

        case .outputFallback:
            HStack(spacing: 9) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12)).foregroundColor(Theme.cNeeds)
                Text(s.fallbackMessage ?? "Formatting unavailable — pasted raw")
                    .font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                if let p = s.outputPreview, !p.isEmpty {
                    Text(p).font(.system(size: 13)).foregroundColor(Theme.textDim).lineLimit(1)
                }
            }
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)

        case .tooShort:
            Text(s.mutedText ?? "Didn't catch that")
                .font(.system(size: 14)).foregroundColor(Theme.textDim)
                .padding(.horizontal, 18)
                .frame(height: PillMetrics.height)

        case .cancelled:
            // UNDO BELONGS HERE — not on success, where the first build put it.
            HStack(spacing: 10) {
                Text("Cancelled")
                    .font(.system(size: 14)).foregroundColor(Theme.textDim)
                CapsuleButton(label: "Undo") { model.emit(.undo) }
            }
            .padding(.leading, 18).padding(.trailing, 8)
            .frame(height: PillMetrics.height)

        case .error:
            HStack(spacing: 9) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold)).foregroundColor(Theme.cError)
                VStack(alignment: .leading, spacing: 1) {
                    Text(s.message ?? "Something went wrong")
                        .font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                    if !(s.message ?? "").contains("limit reached") {
                        Text("Retry from History to regenerate")
                            .font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }
                }
            }
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)
        }
    }

    private var processingLabel: String {
        if s.draftOffer { return "Taking longer…" }
        if s.engineNotice { return "On-device" }
        return "Processing"
    }
}

// MARK: - Pieces

/// The recording indicator. Red and pulsing for Remote, white for dictation —
/// matching the original's dot classes.
private struct RecordDot: View {
    @State private var small = false
    var body: some View {
        Circle()
            .fill(Color.white.opacity(0.88))
            .frame(width: 8, height: 8)
            .scaleEffect(small ? 0.83 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true)) {
                    small = true
                }
            }
    }
}

/// A Remote capture swaps the dot for a small remote-control glyph, so the pill
/// reads as "remote" without a word of explanation.
private struct RemoteGlyph: View {
    @State private var small = false
    var body: some View {
        Image(systemName: "av.remote")
            .font(.system(size: 12, weight: .regular))
            .foregroundColor(Color.white.opacity(0.92))
            .scaleEffect(small ? 0.86 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true)) {
                    small = true
                }
            }
    }
}

private struct Breathing: ViewModifier {
    @State private var dim = false
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.45 : 1).onAppear {
            withAnimation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true)) { dim = true }
        }
    }
}

/// Three bouncing dots — the original's processing motion.
private struct BouncingDots: View {
    @State private var phase = false
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Theme.textDim)
                    .frame(width: 3.5, height: 3.5)
                    .offset(y: phase ? -2.5 : 2.5)
                    .animation(.easeInOut(duration: 0.42).repeatForever(autoreverses: true)
                        .delay(Double(i) * 0.12), value: phase)
            }
        }
        .onAppear { phase = true }
    }
}

/// Counts up; flips to a countdown in the last 30s, as the original does.
private struct TimerText: View {
    let elapsed: Int
    let max: Int
    private var remaining: Int { max - elapsed }
    private var near: Bool { remaining <= 30 }

    var body: some View {
        Text(near ? "-\(fmt(remaining))" : fmt(elapsed))
            .font(.system(size: 14))
            .monospacedDigit()
            .foregroundColor(near ? Theme.cNeeds : Theme.textDim)
    }
    private func fmt(_ s: Int) -> String {
        String(format: "%d:%02d", Swift.max(s, 0) / 60, Swift.max(s, 0) % 60)
    }
}

private struct StopButton: View {
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color.white.opacity(0.85))
                .frame(width: 9, height: 9)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.14 : 0.08)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
        .help("Stop recording")
    }
}

private struct CapsuleButton: View {
    let label: String
    var prominent: Bool = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: prominent ? .semibold : .regular))
                .foregroundColor(prominent ? Theme.accentInk : Theme.text)
                .padding(.horizontal, 11).padding(.vertical, 4)
                .background(Capsule().fill(prominent
                                           ? Theme.accent.opacity(hovering ? 0.86 : 1)
                                           : Color.white.opacity(hovering ? 0.18 : 0.10)))
                .overlay(Capsule().stroke(prominent ? Color.clear : Color.white.opacity(0.30),
                                          lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

// MARK: - Chips
//
// 32pt capsules carrying NO border or shadow of their own beyond the shared
// material — adding per-chip chrome is what makes a cluster read as six
// stickers instead of one object.

/// ONE height and ONE radius for every element in the cluster. The original
/// sets `height: 44, borderRadius: 9999` on all of them; deviating is what made
/// the row look assembled from spare parts.
enum PillMetrics {
    static let height: CGFloat = 44
}

private struct ChipBody<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(spacing: 6) { content() }
            .padding(.horizontal, 14)
            .frame(height: PillMetrics.height)
    }
}

/// A real macOS menu — single column, icons prominent.
private struct MenuChip: View {
    let label: String
    let symbol: String
    var symbolColor: Color = Theme.textDim
    let options: [PillOption]
    let onPick: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options) { o in
                Button(action: { onPick(o.id) }) {
                    if let d = o.detail, !d.isEmpty { Text("\(o.label)   \(d)") }
                    else { Text(o.label) }
                }
                .disabled(!o.isAvailable)
            }
        } label: {
            ChipBody {
                Image(systemName: symbol).font(.system(size: 11)).foregroundColor(symbolColor)
                Text(label).font(.system(size: 12.5, weight: .medium)).foregroundColor(Theme.text)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold)).foregroundColor(Theme.textFaint)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

private struct RawChip: View {
    let on: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ChipBody {
                Text("RAW")
                    .font(.system(size: 10.5, weight: .semibold)).tracking(0.6)
                    .foregroundColor(on ? Theme.cNeeds : Theme.textFaint)
            }
        }
        .buttonStyle(.plain)
        .help(on ? "Raw — no unmute memory injected" : "Unmute memory is injected")
    }
}

private struct StagedChip: View {
    let count: Int
    let onClear: () -> Void
    @State private var hovering = false

    var body: some View {
        ChipBody {
            Image(systemName: "photo.on.rectangle")
                .font(.system(size: 11)).foregroundColor(Theme.textDim)
            Text("\(count)").font(.system(size: 12.5, weight: .medium)).foregroundColor(Theme.text)
            if hovering {
                Button(action: onClear) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11)).foregroundColor(Theme.textFaint)
                }.buttonStyle(.plain)
            }
        }
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
        .help("\(count) image\(count == 1 ? "" : "s") ride with this utterance")
    }
}

private struct MicChip: View {
    let current: String?
    let options: [PillOption]
    let onPick: (String) -> Void

    private var isPhone: Bool { (current ?? "").contains("iphone") }

    var body: some View {
        Button(action: { onPick(isPhone ? "mac" : "iphone") }) {
            ChipBody {
                Image(systemName: isPhone ? "iphone" : "laptopcomputer")
                    .font(.system(size: 11))
                    .foregroundColor(isPhone ? Theme.cReady : Theme.textDim)
            }
        }
        .buttonStyle(.plain)
        .help(isPhone ? "Capturing from iPhone — tap for the Mac mic"
                      : "Capturing from the Mac — tap for iPhone")
    }
}

/// Live capture coaching. Two-tier copy: the bold condition, then the remedy.
private struct CoachingChip: View {
    let coaching: PillCoaching
    private var tint: Color { coaching.level == "good" ? Theme.cReady : Theme.cNeeds }

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text(coaching.condition)
                .font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.text)
            if let r = coaching.remedy, !r.isEmpty {
                Text(r).font(.system(size: 12)).foregroundColor(Theme.textDim)
            }
        }
        .padding(.horizontal, 14).frame(height: PillMetrics.height)
        .pillGlass(Capsule(), tint: tint)
    }
}

/// Why the on-device engine is being used. Only the recoverable state is tinted
/// and carries a primary button.
private struct OfflineCard: View {
    let reason: PillOfflineReason
    let onFix: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: reason.symbol)
                .font(.system(size: 11.5))
                .foregroundColor(reason.isRecoverable ? Theme.cNeeds : Theme.textDim)
            Text(reason.text)
                .font(.system(size: 12.5))
                .foregroundColor(reason.isRecoverable ? Theme.text : Theme.textDim)
                .lineLimit(1)
            if reason.isRecoverable {
                CapsuleButton(label: "Update card", prominent: true, action: onFix)
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.textFaint)
            }.buttonStyle(.plain)
        }
        .padding(.leading, 13).padding(.trailing, 11)
        .frame(height: PillMetrics.height)
        .pillGlass(Capsule(), tint: reason.isRecoverable ? Theme.cNeeds : nil)
    }
}
