import SwiftUI

// THE PILL CLUSTER — one glass system, not six chips.
//
// The web widget drew the pill and every satellite as separate views, each
// carrying its own fill, border and shadow. The moment the pill becomes glass
// that is glass-on-glass: Apple prohibits it, and it literally cannot render
// correctly because glass cannot sample glass.
//
// Here the whole cluster lives in ONE GlassEffectContainer, so the elements
// share a single adaptive appearance, sample the backdrop in one pass, and
// fluidly join and separate as chips come and go. That is the single biggest
// structural gain of moving this surface to Swift — CSS backdrop-filter blurs
// but never lenses, and two adjacent blurred elements can never merge.

/// Applies the tier-appropriate material to one element of the cluster.
private struct PillGlass<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color? = nil
    @ObservedObject private var appearance = Appearance.shared

    func body(content: Content) -> some View {
        Group {
            if appearance.translucent {
                if #available(macOS 26.0, *) {
                    content.glassEffect(tint.map { Glass26Style.regular.tint($0) } ?? .regular,
                                        in: shape)
                } else {
                    content
                        .background(shape.fill(Color(red: 0.055, green: 0.06, blue: 0.07).opacity(0.90)))
                        .background(
                            VisualEffectBackdrop(material: .hudWindow).clipShape(shape)
                        )
                        .overlay(shape.stroke(Glass.rim(highlight: tint ?? .white), lineWidth: 1))
                        .shadow(color: .black.opacity(0.34), radius: 14, y: 5)
                }
            } else {
                content
                    .background(shape.fill(tint.map { $0.opacity(0.20) }
                                           ?? Color(red: 0.07, green: 0.075, blue: 0.09)))
                    .overlay(shape.stroke(Color.white.opacity(0.22), lineWidth: 1))
                    .shadow(color: .black.opacity(0.30), radius: 10, y: 4)
            }
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
    @Namespace private var ns

    private var s: PillState { model.state }

    var body: some View {
        VStack(spacing: 9) {
            Spacer(minLength: 0)
            if let c = s.coaching { CoachingChip(coaching: c) }
            cluster
            if let reason = s.offline {
                OfflineCard(reason: reason,
                            onFix: { model.emit(.openBillingPortal) },
                            onDismiss: { model.emit(.dismissOffline) })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 4)
        .animation(Theme.morph, value: s.phase)
        .animation(Theme.morph, value: s.stagedCount)
        .animation(Theme.morph, value: s.offline)
    }

    /// The cluster is ALWAYS a single horizontal row. Chips flank the pill; the
    /// pill is the anchor and never moves as they come and go.
    @ViewBuilder private var cluster: some View {
        if #available(macOS 26.0, *), Appearance.shared.translucent {
            GlassEffectContainer(spacing: 12) { row }
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 8) {
            // LEFT of the pill: what the task will RUN ON.
            if s.kind == .remote {
                if let m = s.model {
                    MenuChip(id: "model", label: m, symbol: "sparkles", symbolColor: Theme.cNeeds,
                             options: s.modelOptions ?? [], model: model) { model.emit(.pickModel($0)) }
                        .pillGlass(Capsule())
                        .glassID("model", ns)
                }
                if let a = s.agent {
                    MenuChip(id: "agent", label: a, symbol: "chevron.left.forwardslash.chevron.right",
                             symbolColor: Theme.textDim,
                             options: s.agentOptions ?? [], model: model) { model.emit(.pickAgent($0)) }
                        .pillGlass(Capsule())
                        .glassID("agent", ns)
                }
                if let raw = s.raw {
                    RawChip(on: raw) { model.emit(.toggleRaw(!raw)) }
                        .pillGlass(Capsule())
                        .glassID("raw", ns)
                }
            }

            capturePill
                .pillGlass(Capsule(), tint: pillTint)
                .glassID("pill", ns)

            // RIGHT of the pill: what RIDES ALONG with the utterance.
            if s.stagedCount > 0 {
                StagedChip(count: s.stagedCount) { model.emit(.clearStaged) }
                    .pillGlass(Capsule())
                    .glassID("staged", ns)
            }
            if let opts = s.micOptions, opts.count > 1 {
                MicChip(current: s.mic, options: opts, model: model) { model.emit(.pickMic($0)) }
                    .pillGlass(Capsule())
                    .glassID("mic", ns)
            }
        }
    }

    /// Only an ERROR tints the pill — the one state that is telling you
    /// something you must act on.
    private var pillTint: Color? {
        s.phase == .error ? Theme.cError : nil
    }

    // MARK: the pill itself

    private var capturePill: some View {
        HStack(spacing: 11) {
            statusDot
            Text(headline)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(Theme.text)
                .lineLimit(1)

            if s.phase == .listening {
                Waveform(level: s.level)
                    .frame(width: 42, height: 16)
                    .foregroundColor(Theme.textDim)
                TimerText(elapsed: s.elapsed, max: s.maxSeconds)
                IconButton(symbol: "stop.fill") { model.emit(.stop) }
                    .help("Finish and transcribe")
            }
            if s.phase == .landed, s.canUndo {
                CapsuleButton(label: "Undo") { model.emit(.undo) }
            }
            if s.phase == .draft {
                CapsuleButton(label: "Insert", prominent: true) { model.emit(.acceptDraft) }
            }
            if s.phase == .error {
                CapsuleButton(label: "Retry") { model.emit(.stop) }
            }
        }
        .padding(.leading, 15)
        .padding(.trailing, s.phase == .listening ? 7 : 15)
        .frame(height: 44)
    }

    private var headline: String {
        if let l = s.label, !l.isEmpty { return l }
        switch s.phase {
        case .listening:     return s.kind == .remote ? "New task" : "Listening"
        case .transcribing:  return "Transcribing…"
        case .landed:        return s.kind == .remote ? "Sent" : "Pasted"
        case .draft:         return "Draft ready"
        case .error:         return s.message ?? "Couldn't reach the cloud"
        case .hidden:        return ""
        }
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 8, height: 8)
            .modifier(BreathingDot(active: s.phase == .listening || s.phase == .transcribing))
    }

    private var dotColor: Color {
        switch s.phase {
        case .listening:    return Theme.cError      // recording — the universal red
        case .transcribing: return Theme.accent
        case .landed:       return Theme.cWorking
        case .draft:        return Theme.cNeeds
        case .error:        return Theme.cError
        case .hidden:       return .clear
        }
    }
}

// MARK: - Glass identity

private extension View {
    /// Ties an element to the container so it MORPHS rather than pops when it
    /// joins or leaves the cluster. No-op below macOS 26.
    @ViewBuilder func glassID(_ id: String, _ ns: Namespace.ID) -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffectID(id, in: ns)
        } else {
            self
        }
    }
}

// MARK: - Pieces

private struct BreathingDot: ViewModifier {
    let active: Bool
    @State private var dim = false
    func body(content: Content) -> some View {
        content
            .opacity(dim ? 0.45 : 1)
            .onAppear {
                guard active else { return }
                withAnimation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}

/// Live level meter. Bars are driven by ONE amplitude value pushed from the
/// renderer — the capture path itself is untouched.
private struct Waveform: View {
    let level: Double
    private let bars = 7

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(0..<bars, id: \.self) { i in
                Capsule()
                    .frame(width: 2.5, height: height(i))
            }
        }
        .animation(.easeOut(duration: 0.09), value: level)
    }

    /// A fixed envelope shaped by the live level, so the meter reads as one
    /// waveform rather than seven independent bars.
    private func height(_ i: Int) -> CGFloat {
        let mid = Double(bars - 1) / 2
        let falloff = 1 - abs(Double(i) - mid) / (mid + 1.1)
        let v = max(0.12, min(1, level)) * falloff
        return CGFloat(3 + v * 13)
    }
}

private struct TimerText: View {
    let elapsed: Int
    let max: Int
    var body: some View {
        Text(String(format: "%d:%02d", elapsed / 60, elapsed % 60))
            .font(.system(size: 13))
            .monospacedDigit()
            .foregroundColor(elapsed >= max - 30 ? Theme.cNeeds : Theme.textDim)
    }
}

private struct IconButton: View {
    let symbol: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Theme.text)
                .frame(width: 30, height: 30)
                .background(Circle().fill(hovering ? Theme.raisedHover : Theme.raised))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
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
                .font(.system(size: 12.5, weight: prominent ? .semibold : .regular))
                .foregroundColor(prominent ? .white : Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(Capsule().fill(prominent
                                           ? Theme.accent.opacity(hovering ? 0.86 : 1)
                                           : (hovering ? Theme.raisedHover : Theme.raised)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}

// MARK: - Chips

/// A 32pt capsule chip carrying NO border or shadow of its own — the shared
/// container provides both. Adding them here is what makes a cluster read as
/// six stickers instead of one object.
private struct ChipBody<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(spacing: 6) { content() }
            .padding(.horizontal, 12)
            .frame(height: 32)
    }
}

/// A chip that opens a real macOS menu — single column, icons prominent, which
/// is how menus read in the new design system.
private struct MenuChip: View {
    let id: String
    let label: String
    let symbol: String
    var symbolColor: Color = Theme.textDim
    let options: [PillOption]
    @ObservedObject var model: PillModel
    let onPick: (String) -> Void

    var body: some View {
        Menu {
            ForEach(options) { o in
                Button(action: { onPick(o.id) }) {
                    if let d = o.detail, !d.isEmpty {
                        Text("\(o.label)   \(d)")
                    } else {
                        Text(o.label)
                    }
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
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(0.6)
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
    @ObservedObject var model: PillModel
    let onPick: (String) -> Void

    private var isPhone: Bool { (current ?? "").contains("iphone") }

    var body: some View {
        Menu {
            ForEach(options) { o in
                Button(o.label) { onPick(o.id) }.disabled(!o.isAvailable)
            }
        } label: {
            ChipBody {
                Image(systemName: isPhone ? "iphone" : "laptopcomputer")
                    .font(.system(size: 11))
                    .foregroundColor(isPhone ? Theme.cReady : Theme.textDim)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Capture source")
    }
}

/// Live capture coaching. Two-tier copy: the bold condition, then the remedy.
private struct CoachingChip: View {
    let coaching: PillCoaching
    @ObservedObject private var appearance = Appearance.shared

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
        .padding(.horizontal, 12).frame(height: 30)
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
        .frame(height: 36)
        .pillGlass(Capsule(), tint: reason.isRecoverable ? Theme.cNeeds : nil)
    }
}
