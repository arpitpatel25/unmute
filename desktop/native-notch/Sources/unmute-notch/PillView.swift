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
                // NO DROP SHADOW. The original says why, in its own words:
                // "Unmute must occupy ONLY the widget itself — a soft 36px
                // shadow pooled behind the whole pill row and read as a
                // bounding box around the panel." Its CSS sets
                // `box-shadow: none` for exactly this reason, and reinstating
                // one brought the box straight back — worst over a light
                // wallpaper, where a rectangular halo sat around the capsules.
                // (SwiftUI cannot reliably shape a shadow around an
                // NSViewRepresentable anyway; it falls back to layer bounds,
                // which is why it read as a BOX and not a capsule.)
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
            // ONE CHIP AT A TIME, with strict precedence: mic narration first,
            // then noise, then quiet — "noise wins: it's the condition the user
            // can't hear themselves." Mic narration outranks both because it is
            // the only one describing something that just CHANGED.
            if chipsVisible { hint }
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
                // AGENT + MODEL AS ONE CONTROL, exactly as the original builds
                // it: the agent determines which models exist, so
                // "Codex → 5.6 Terra High" is one sentence, left to right.
                //
                // The join is what my earlier attempt got wrong, not the idea.
                // Each half kept a symmetric 14pt inset, so the gap around the
                // divider was 28pt against 14pt at the outer edges. The original
                // tightens the INNER sides — 15/12 and 12/14 — which is why it
                // reads evenly. And there are no icons on either half: the dot
                // is the connection indicator, the chevron belongs to the model.
                AgentModelControl(state: s, model: model)
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

    @ViewBuilder private var hint: some View {
        if let m = s.micStatus, !m.isEmpty {
            // The mic line arrives as "Condition — remedy"; split it so the
            // condition reads bold and the remedy stays quiet.
            let parts = m.components(separatedBy: " — ")
            HintChip(accent: Color(red: 0.976, green: 0.451, blue: 0.086),   // #f97316
                     label: parts.first ?? m,
                     detail: parts.count > 1 ? parts.dropFirst().joined(separator: " — ") : "",
                     symbol: "mic")
        } else if let c = s.coaching {
            HintChip(accent: c.level == "quiet"
                     ? Color(red: 0.220, green: 0.741, blue: 0.973)          // #38bdf8
                     : Color(red: 0.984, green: 0.749, blue: 0.141),         // #fbbf24
                     label: c.condition,
                     detail: c.remedy ?? "",
                     symbol: c.level == "quiet" ? "mic" : "waveform")
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

/// The joined agent + model control.
///
/// Agent is a CYCLE (tap → the other platform), because there are only ever two
/// and the original made it a tap. Model is a menu whose CONTENTS depend on the
/// agent: Claude's flat catalog, or Codex's three axes.
private struct AgentModelControl: View {
    let state: PillState
    @ObservedObject var model: PillModel

    /// Claude's brand orange, as the original colours the model label.
    private let modelInk = Color(red: 0.851, green: 0.467, blue: 0.341)

    var body: some View {
        HStack(spacing: 0) {
            if let agent = state.agent {
                Button(action: { model.emit(.cycleAgent) }) {
                    HStack(spacing: 7) {
                        // THE CONNECTION DOT — functional, not decorative. Green
                        // when the backend can take work right now, dim when it
                        // cannot, and the label then says so.
                        Circle()
                            .fill(state.agentConnected
                                  ? Color(red: 0.436, green: 0.749, blue: 0.604)
                                  : Color.white.opacity(0.35))
                            .frame(width: 7, height: 7)
                        Text(agent + (state.agentConnected ? "" : " · connect"))
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundColor(Color.white.opacity(state.agentConnected ? 0.92 : 0.5))
                            .lineLimit(1)
                    }
                    // ASYMMETRIC: 15 outer, 12 inner. This is the fix for the
                    // uneven margins — not splitting the control.
                    .padding(.leading, 15).padding(.trailing, 12)
                    .frame(height: PillMetrics.height)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(state.agentConnected ? "Where this task runs — tap to switch"
                                           : "Not connected — tap to connect")

                Rectangle().fill(Color.white.opacity(0.28))
                    .frame(width: 1, height: PillMetrics.height)
            }

            if let label = state.model {
                ModelMenu(label: label, ink: modelInk, state: state, model: model,
                          leadingInset: state.agent == nil ? 14 : 12)
            }
        }
        .fixedSize()
        .frame(height: PillMetrics.height)
        .pillGlass(Capsule())
    }
}

/// The model control. Its CONTENTS follow the platform — a flat catalog for
/// Claude, Codex's Model/Effort/Speed axes for Codex. The two never share a
/// list, which is the whole reason switching platform has to change this.
private struct ModelMenu: View {
    let label: String
    let ink: Color
    let state: PillState
    @ObservedObject var model: PillModel
    var leadingInset: CGFloat = 12

    var body: some View {
        Menu {
            if let axes = state.modelAxes, !axes.isEmpty {
                ForEach(axes) { axis in
                    Section(axis.axis) {
                        ForEach(axis.values, id: \.self) { v in
                            Button(action: { model.emit(.pickAxis(axis: axis.axis, value: v)) }) {
                                // A tick marks the live value, since these are
                                // three independent axes rather than one choice.
                                Text(axis.current == v ? "✓ \(v)" : v)
                            }
                        }
                    }
                }
            } else {
                ForEach(state.modelOptions ?? []) { o in
                    Button(action: { model.emit(.pickModel(o.id)) }) {
                        if let d = o.detail, !d.isEmpty { Text("\(o.label)   \(d)") }
                        else { Text(o.label) }
                    }
                    .disabled(!o.isAvailable)
                }
            }
        } label: {
            HStack(spacing: 7) {
                Text(label)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(ink)
                    .lineLimit(1)
                // The only glyph either half carries, and it earns its place —
                // it says this opens.
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(ink.opacity(0.7))
            }
            .padding(.leading, leadingInset).padding(.trailing, 14)
            .frame(height: PillMetrics.height)
            .contentShape(Rectangle())
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

/// One line of narration beside the pill. Two-tier copy: the bold condition,
/// then the dim remedy — the original's rule that "chip colours are ambience,
/// WORDS are communication". Each message carries its own accent and glyph.
private struct HintChip: View {
    let accent: Color
    let label: String
    let detail: String
    /// "mic" or "waveform" — the original's two icons.
    let symbol: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: symbol == "waveform" ? "waveform" : "mic")
                .font(.system(size: 11)).foregroundColor(accent)
            Text(label)
                .font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.text)
                .lineLimit(1)
            if !detail.isEmpty {
                Text(detail).font(.system(size: 12)).foregroundColor(Theme.textDim).lineLimit(1)
            }
        }
        .padding(.horizontal, 14).frame(height: 34)
        .pillGlass(Capsule(), tint: accent)
        .transition(.opacity)
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
