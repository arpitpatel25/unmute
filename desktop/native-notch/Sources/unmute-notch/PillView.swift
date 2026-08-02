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
// MATERIAL: real Liquid Glass on macOS 26+ (verified by probe), with the
// specular rim as an overlay stroke. The hand-built material is the pre-26
// fallback only. See GlassLip.swift.

/// Applies the cluster's material to one element.
///
/// EVERY GLASS ELEMENT IN THE INPUT SURFACE COMES THROUGH HERE. A second
/// hand-rolled backdrop next to this one is exactly how a "one glass system"
/// becomes two.
///
/// The scratchpad is the one deliberate exception and does not use it: the pad
/// is PAPER, an off-white card that stays light in both system appearances,
/// because it holds the user's own words rather than being another face of the
/// instrument. See PadPaper — it borrows nothing from here and none of Theme's
/// colours (only its animation curves), so the two vocabularies cannot quietly
/// bleed into each other.
struct PillGlass<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color? = nil
    @ObservedObject private var appearance = Appearance.shared

    func body(content: Content) -> some View {
        content
            .background {
                Group {
                    if appearance.translucent {
                        if #available(macOS 26.0, *) {
                            // REAL Liquid Glass + the specular rim overlaid —
                            // the treatment chosen from a four-way comparison
                            // rendered on the target machine. Bare glass read as
                            // flat; the rim is what gives the capsule its edge.
                            // A stroke is NOT a second material, so this is not
                            // glass-on-glass.
                            Color.clear.glassEffect(
                                tint.map { Glass26Style.regular.tint($0.opacity(0.5)) } ?? .regular,
                                in: shape)
                        } else {
                            ZStack {
                                VisualEffectBackdrop(material: .hudWindow)
                                Color(red: 0.016, green: 0.020, blue: 0.030).opacity(0.30)
                                if let tint { tint.opacity(0.18) }
                            }
                            .clipShape(shape)
                        }
                    } else {
                        ZStack {
                            // FIXED GLASS — a lens that never samples anything.
                            //
                            // What reads as "glass" is the EDGE and the sheen,
                            // not the see-through: a specular rim, and light
                            // falling off from the top as it would across a
                            // curved surface. Both are static, so this cannot go
                            // stale, cannot blink, and is immune to the macOS
                            // 26.2 backdrop-caching regression (FB: NSGlassEffect
                            // caches its backdrop on borderless all-Spaces
                            // panels) and to whatever the compositor does next.
                            //
                            // It is also DETERMINISTIC: the surface looks the
                            // same on every wallpaper, every Space, every Mac —
                            // which suits a product surface that should read as
                            // one instrument rather than as a different colour
                            // depending on what happens to be behind it.
                            Color(red: 0.055, green: 0.06, blue: 0.075)
                            LinearGradient(
                                colors: [Color.white.opacity(0.085),
                                         Color.white.opacity(0.022),
                                         Color.white.opacity(0.0)],
                                startPoint: .top, endPoint: .bottom)
                            if let tint { tint.opacity(0.16) }
                        }
                        .clipShape(shape)
                    }
                }
                // REBUILT whenever the backdrop is invalidated — see
                // Appearance.backdropToken. A Space change does not make macOS
                // re-sample what is behind the glass; remaking the view does.
                .id(appearance.backdropToken)
                // A TINTED MODE GETS A REAL BORDER, not a wash.
                //
                // The tint alone rides the material at 0.16 on the Fixed
                // surface (0.5 on glass) — tuned for translucency, and over a
                // near-black base it is invisible. Rendered side by side, a
                // formatter capture and a dictation capture were identical
                // pixels. A mode marker that cannot be seen is not a marker.
                //
                // So the stroke carries it: the mode's own colour at full
                // presence, slightly thicker than the specular rim it replaces.
                // Untinted pills keep the rim exactly as before.
                .overlay(
                    shape.stroke(
                        tint.map { AnyShapeStyle($0.opacity(0.95)) }
                            ?? AnyShapeStyle(Glass.rim(highlight: .white)),
                        lineWidth: tint == nil ? 1 : 2))
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

extension View {
    func pillGlass<S: Shape>(_ shape: S, tint: Color? = nil) -> some View {
        modifier(PillGlass(shape: shape, tint: tint))
    }
}

struct PillView: View {
    @ObservedObject var model: PillModel
    /// The scratchpad — both the chip that arms it and the pad itself, which is
    /// drawn beside the cluster by `pad`. The pad outlives any single
    /// capture, so this window is now shown whenever EITHER surface wants to be
    /// on screen (AppController.reconcileSurfaces) rather than only during a
    /// capture.
    @ObservedObject var scratch: ScratchpadModel
    /// Whether the selector panel is open. Local to the view — main never needs
    /// to know, and a round-trip would make it feel slow.
    @State private var selectorOpen = false

    private var s: PillState { model.state }

    /// Whether the pad is expanded or put away. LIVES HERE, not in the pad,
    /// because the cluster's overlay must offset by whichever width it implies —
    /// two copies of that answer would let the pad's left edge drift off the
    /// chip it is supposed to be attached to.
    @State private var padExpanded = true

    /// Chips ride with the pill only while a capture is live — the same rule the
    /// original used (`pillShowing`): recording or processing, nothing else.
    /// PAUSED counts: it IS the capture, waiting. The chips going away at the
    /// moment the pill starts saying "Paused" would read as the session ending,
    /// which is the exact lie this state exists to stop telling.
    private var chipsVisible: Bool {
        s.phase == .recording || s.phase == .processing || s.phase == .paused
    }

    /// The pad is on screen. It is drawn INSIDE this window, as a sibling of
    /// the whole column (see `content` and `pad`), so the cluster has to know:
    /// the scratchpad chip is the pad's neighbour and stays out for it.
    private var padShowing: Bool { scratch.visible }

    /// The ONE condition, so the panel and its dismiss scrim cannot drift apart.
    /// A scrim armed without a panel on screen would be an invisible sheet
    /// eating clicks with nothing to dismiss.
    private var selectorShowing: Bool {
        chipsVisible && selectorOpen && s.kind == .remote
    }

    var body: some View {
        ZStack {
            // LIGHT-DISMISS SCRIM, present ONLY while the panel is open.
            //
            // The panel is a hand-drawn view, not an NSMenu, so it inherits none
            // of AppKit's outside-click dismissal — and it cannot borrow it: the
            // window is deliberately non-key (canBecomeKey == false) so dictation
            // never moves the user's caret, which means no resignKey to hang it
            // on and no local event monitor either.
            //
            // So the canvas itself catches the click. It must exist only while
            // the panel is open: the pill window is a 400pt-tall canvas whose
            // empty area is click-through BY DESIGN (see PillWindow), and a
            // permanent scrim would silently eat every click at the bottom of
            // the screen. Gated on `selectorOpen`, the first outside click
            // closes the panel and is swallowed — exactly how a macOS menu
            // behaves, rather than also landing in the app behind.
            if selectorShowing {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { selectorOpen = false }
                    .accessibilityHidden(true)
            }
            content
        }
    }

    private var content: some View {
        VStack(spacing: 9) {
            Spacer(minLength: 0)
            // THE PAD IS BESIDE THE COLUMN, NOT ABOVE THE PILL.
            //
            // It used to be its own panel whose bottom edge landed on the top of
            // the cluster plus this VStack's own 9pt spacing — i.e. exactly the
            // slot `hint` and `SelectorPanel` occupy — so the two surfaces had
            // to be made mutually exclusive to stop the pad covering the mic
            // narration and the model selector.
            //
            // As a SIBLING OF THE WHOLE COLUMN that overlap cannot be
            // constructed. The column's width is the widest of hint, selector
            // and cluster, and the pad starts one row-gap after it, so nothing
            // that stacks above the pill can ever reach into the pad's column
            // whatever it says. Anchoring the pad to the scratchpad chip alone
            // would NOT have this property: an overlay takes no part in layout,
            // and a long mic-narration line ("Switching to iPhone — from the
            // next dictation", ~294pt) is wider than a plain-dictation cluster
            // (~212pt), so it would have run underneath the pad's lower-left
            // corner. Adjacency to the chip is preserved in the ordinary case
            // — the cluster IS the widest row — and given up only in the case
            // where keeping it would mean an overlap.
            //
            // `.bottom` puts the pad's bottom edge on the column's bottom edge,
            // and it grows upward from there. The pad takes no part in the
            // COLUMN's vertical layout at all, which is what keeps a 340×340
            // note from shoving the hint three hundred points up the screen.
            //
            // AND THE PILL DOES NOT MOVE. A row of [column, pad] centres on the
            // MIDDLE OF BOTH, so the pill slid 174pt left the instant a pad
            // appeared and 96pt more when it collapsed — motion on the one
            // element the user's eye is trained on, to announce something
            // happening beside it. The counterweight fixes that in the layout
            // rather than with a transform: an empty view of exactly the pad's
            // width on the FAR side, so the row is symmetric about the column
            // and centring the row centres the column. The pill's position is
            // then identical whether the pad is absent, expanded or collapsed —
            // and it stays identical if the row ever outgrows the canvas, since
            // the overflow is symmetric too and the left half of it is the
            // counterweight, which is nothing.
            HStack(alignment: .bottom, spacing: PadPaper.gap) {
                counterweight
                VStack(spacing: 9) {
                    // ONE CHIP AT A TIME, with strict precedence: mic narration
                    // first, then noise, then quiet — "noise wins: it's the
                    // condition the user can't hear themselves." Mic narration
                    // outranks both because it is the only one describing
                    // something that just CHANGED.
                    if chipsVisible { hint }
                    if selectorShowing {
                        SelectorPanel(state: s, model: model, open: $selectorOpen)
                    }
                    cluster
                    if chipsVisible, let reason = s.offline {
                        OfflineCard(reason: reason,
                                    onFix: { model.emit(.openBillingPortal) },
                                    onDismiss: { model.emit(.dismissOffline) })
                    }
                }
                pad
            }
            // NOTHING IN THIS ROW MAY BE COMPRESSED TO MAKE IT FIT. Without
            // this, a row wider than the canvas is resolved by squeezing
            // whatever can squeeze — the agent and model labels — which both
            // looks broken and MOVES THE PILL, since its position is the
            // cluster's layout. Overflowing and clipping the pad's outer edge
            // instead keeps the pill exactly where it was. See padWidth for
            // when that can happen.
            .fixedSize(horizontal: true, vertical: false)
            .animation(Theme.collapse, value: padExpanded)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 4)
        .animation(Theme.morph, value: s.phase)
        .onChange(of: s.phase) { p in if p != .recording && p != .processing { selectorOpen = false } }
    }

    /// The awareness card is the only thing that can sit BELOW the cluster, and
    /// it would drag the column's bottom edge — and with it the pad's — a whole
    /// row down. The pad is lifted by exactly that row so its bottom edge stays
    /// on the PILL's, which is the one thing the geometry promises.
    private var offlineShowing: Bool { chipsVisible && s.offline != nil }

    /// ONE EXPRESSION FOR THE PAD'S FOOTPRINT, read by both the pad and its
    /// counterweight. Two copies of this number would let the row go asymmetric
    /// — and an asymmetric row is a pill that has moved.
    private var padWidth: CGFloat {
        padExpanded ? PadPaper.width : PadPaper.collapsedWidth
    }

    /// The pad's width, on the other side of the column, drawing nothing.
    ///
    /// It is deliberately not a Spacer: a Spacer is flexible and would absorb
    /// slack instead of reserving a fixed mirror of the pad. `allowsHitTesting`
    /// is off so it cannot swallow a click meant for the app underneath — the
    /// pill window's empty canvas is click-through BY DESIGN (see PillWindow),
    /// and this is a large piece of that canvas.
    @ViewBuilder private var counterweight: some View {
        if padShowing, scratch.state.pad != nil {
            Color.clear
                .frame(width: padWidth, height: 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var pad: some View {
        if padShowing, let padState = scratch.state.pad {
            ScratchpadView(
                pad: padState,
                destinations: scratch.state.destinations,
                armed: scratch.state.armed,
                delivering: scratch.state.delivering,
                expandedPad: $padExpanded,
                onRemove: { scratch.emit(.scratchpadRemove(id: $0)) },
                onDeliver: { scratch.emit(.scratchpadDeliver(dest: $0)) },
                onDiscard: { scratch.emit(.scratchpadDiscard) }
            )
            // Pinned to the SAME expression the counterweight uses, rather than
            // trusting ScratchpadView's own frame to agree with it. The two
            // sides of the balance now cannot drift, including mid-animation.
            .frame(width: padWidth, alignment: .leading)
            .padding(.bottom, offlineShowing ? PillMetrics.height + 9 : 0)
        }
    }

    /// Always a single horizontal row, and EVERY element is 44pt tall.
    ///
    /// The chips were 32pt beside a 44pt pill, which is what made the row read
    /// as mismatched parts rather than one instrument. The original sets
    /// `height: 44, borderRadius: 9999` on the pill, the model badge, the agent,
    /// the raw toggle, the mic chip and the scratchpad chip alike — one height,
    /// one radius, no exceptions. Restored.
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
                AgentModelControl(state: s, model: model, open: $selectorOpen)
                // Absent ⇒ not applicable on this backend (Codex), so no chip.
                if let raw = s.raw {
                    RawChip(on: raw) { model.emit(.toggleRaw(!raw)) }.pillGlass(Capsule())
                }
            }

            pill.pillGlass(Capsule(), tint: pillTint)

            if chipsVisible {
                if let opts = s.micOptions, opts.count > 1 {
                    MicChip(current: s.mic, options: opts) { model.emit(.pickMic($0)) }
                        .pillGlass(Capsule())
                }
            }
            // THE SCRATCHPAD CONTROL. It ARMS AND DISARMS ONLY — it never
            // sends. Toggle-off-to-send would be a silent commit dressed as
            // a mode switch: a toggle reads as reversible, so a user tapping
            // it to mean "never mind" would create a task instead. Send and
            // discard live on the pad, where they read as the deliberate
            // acts they are.
            //
            // OUTSIDE `chipsVisible`, unlike every other chip: it is also the
            // pad's ANCHOR. The pad hangs off this chip's trailing edge, so a
            // pad on screen with no capture running would otherwise be pinned
            // to an empty cluster — and the arm toggle for the work in front of
            // the user would be unreachable.
            if scratch.state.enabled && (chipsVisible || padShowing) {
                ScratchpadChip(armed: scratch.state.armed) {
                    scratch.emit(.scratchpadArm(!scratch.state.armed))
                }
                .pillGlass(Capsule())
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
        // THE FORMATTER, and only the formatter. Remote is not tinted: it
        // already reads as itself from its glyph and its agent chip, whereas
        // Caps Lock produced a pill indistinguishable from plain dictation.
        //
        // Only while the capture is LIVE — a terminal state's own colour
        // (error red, fallback orange) must never be overridden by which mode
        // produced it.
        case .recording, .processing:
            return s.kind == .instruction ? Theme.cInstruction : nil
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

        case .paused:
            // NOT AN ENDING, AND THE PILL MUST NOT PRETEND OTHERWISE.
            //
            // An armed stop holds the work instead of delivering it, and
            // pressing the dictation key again resumes THE SAME dictation. The
            // pill used to disappear 1.5s later, which reads as "session over"
            // for something that is a pause — so it stays, swaps the running
            // clock for the word, and turns its dot amber. The pad beside it is
            // the rest of the sentence.
            HStack(spacing: 11) {
                Circle().fill(Theme.cNeeds).frame(width: 8, height: 8)
                Text("Paused")
                    .font(.system(size: 14)).foregroundColor(Theme.textDim)
            }
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)
            .help("Held on the scratchpad — press the dictation key to carry on")

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

/// ONE CAPSULE, ONE HIT TARGET, ONE PANEL.
///
/// The divider is gone because the ambiguity is gone. It existed to say "two
/// controls in one object", and it was the only square edge in a row of
/// capsules. Agent moves INTO the panel as its leftmost column, which costs
/// nothing — the panel is already columns — and makes "the platform decides the
/// model list" something you watch happen instead of a surprise.
private struct AgentModelControl: View {
    let state: PillState
    @ObservedObject var model: PillModel
    @Binding var open: Bool

    var body: some View {
        Button(action: { open.toggle() }) {
            HStack(spacing: 9) {
                // THE CONNECTION DOT — functional, not decorative. Green when
                // the backend can take work right now, dim when it cannot, and
                // the label then says so.
                Circle()
                    .fill(state.agentConnected
                          ? Color(red: 0.436, green: 0.749, blue: 0.604)
                          : Color.white.opacity(0.35))
                    .frame(width: 7, height: 7)
                Text((state.agent ?? "Claude Code") + (state.agentConnected ? "" : " · connect"))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(Theme.text.opacity(state.agentConnected ? 1 : 0.55))
                    .lineLimit(1)
                if let m = state.model {
                    // NOT Claude's brand orange — this chip also represents
                    // Codex. Emphasis lives on the active row inside the panel.
                    Text(m)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(Theme.textFaint)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            // Symmetric, now that there is no seam to compensate for.
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pillGlass(Capsule())
        .animation(Theme.hover, value: open)
    }
}

/// The panel: Agent · Model · Effort · Speed for Codex, Agent · Model for
/// Claude. Columns rather than a stacked list because Codex's three axes are
/// ~13 rows — taller than the space above a pill that already sits near the
/// bottom edge. In columns everything is visible at once.
private struct SelectorPanel: View {
    let state: PillState
    @ObservedObject var model: PillModel
    @Binding var open: Bool

    private var axes: [PillAxis] { state.modelAxes ?? [] }
    /// The SELECTED backend's id, resolved through the options the engine sent.
    /// Was a label comparison against the literal "Codex", which is both a
    /// display string and unable to name a third backend.
    private var agentId: String {
        state.agentOptions?.first(where: { $0.label == (state.agent ?? "") })?.id ?? "claude"
    }
    private var isCodex: Bool { agentId == "codex-desktop" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The chip label, decomposed — legible before you open anything.
            Text(summary.uppercased())
                .font(.system(size: 10, weight: .bold)).tracking(0.7)
                .foregroundColor(Theme.textFaint)
                .padding(.horizontal, 10).padding(.top, 3)

            HStack(alignment: .top, spacing: 14) {
                // FROM THE ENGINE, not two literals. Written as a fixed pair
                // this column could never show a third backend however ready it
                // was — the engine had been offering three for a whole build
                // and this drew two. Same shape as the Model column below.
                let agents = state.agentOptions ?? []
                column("Agent", rows: agents.map { ($0.label, $0.id == agentId) }) { label in
                    if let o = agents.first(where: { $0.label == label }) {
                        model.emit(.pickAgent(o.id))
                    }
                }

                if isCodex && axes.isEmpty {
                    // HONEST EMPTY STATE. Falling through to the other
                    // platform's list is what made picking a model silently
                    // write the wrong setting.
                    VStack(alignment: .leading, spacing: 2) {
                        header("Model")
                        Text("Connect Codex to choose a model")
                            .font(.system(size: 12)).foregroundColor(Theme.textFaint)
                            .padding(.horizontal, 10).padding(.vertical, 7)
                    }
                    .frame(minWidth: 150, alignment: .leading)
                } else if isCodex {
                    ForEach(axes) { a in
                        column(a.axis, rows: a.values.map { ($0, $0 == a.current) }) { v in
                            model.emit(.pickAxis(axis: a.axis, value: v))
                        }
                    }
                } else {
                    let opts = state.modelOptions ?? []
                    column("Model", rows: opts.map { ($0.label, $0.label == state.model) }) { label in
                        if let o = opts.first(where: { $0.label == label }) {
                            model.emit(.pickModel(o.id))
                        }
                    }
                }
            }
        }
        .padding(8)
        .pillGlass(RoundedRectangle(cornerRadius: 14))
        .fixedSize()
    }

    private var summary: String {
        if isCodex {
            let vals = axes.compactMap(\.current)
            return vals.isEmpty ? "Not connected" : vals.joined(separator: " · ")
        }
        return state.model ?? "Model"
    }

    private func header(_ t: String) -> some View {
        Text(t.uppercased())
            .font(.system(size: 10, weight: .bold)).tracking(0.6)
            .foregroundColor(Theme.textFaint)
            .padding(.horizontal, 10).padding(.top, 5).padding(.bottom, 2)
    }

    private func column(_ title: String,
                        rows: [(String, Bool)],
                        pick: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            header(title)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                SelectorRow(label: r.0, on: r.1) { pick(r.0) }
            }
        }
        .frame(minWidth: 118, alignment: .leading)
    }
}

private struct SelectorRow: View {
    let label: String
    let on: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .opacity(on ? 1 : 0)
                    .frame(width: 11)
                Text(label).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundColor(on ? Theme.text : Theme.textDim)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(on ? Color.white.opacity(0.13)
                         : (hovering ? Color.white.opacity(0.07) : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
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

/// Arm the scratchpad, or disarm it. THAT IS ALL IT DOES.
///
/// Armed, stopping the recording HOLDS the composed work on the pad instead of
/// delivering it, so the next recording adds to the same pad. Disarming stops
/// that; it does not send, and it does not throw anything away. Both of those
/// are buttons on the pad itself.
private struct ScratchpadChip: View {
    let armed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ChipBody {
                // A PEN NIB, NOT A PAGE. The old glyph drew a sheet of paper
                // with a badge on it, which is the pad — this control is not
                // the pad, it is the decision to write onto one. `pencil.tip`
                // is the system's own nib, so it carries the same weight and
                // optical size as the mic and remote glyphs beside it, which a
                // hand-drawn path could only approximate.
                Image(systemName: "pencil.tip")
                    .font(.system(size: 13))
                    .foregroundColor(armed ? Theme.cReady : Theme.textFaint)
            }
        }
        .buttonStyle(.plain)
        .help(armed ? "Keeping on stop — tap to deliver normally again"
                    : "Keep on stop instead of delivering")
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
