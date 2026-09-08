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
struct PillGlass<S: InsettableShape>: ViewModifier {
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
                            // PITCH BLACK, AND NOTHING ON TOP OF IT.
                            //
                            // The near-black base plus a top-down sheen was
                            // making the surface read as a lit object. Pure
                            // black reads as a hole punched in the screen: the
                            // same on every wallpaper, every Space and every
                            // Mac, with the waveform the only thing in it that
                            // moves. The sheen is gone for the same reason —
                            // it implied a light source the capsule no longer
                            // claims to have.
                            Color.black
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
                // A HAIRLINE, NOT A SPECULAR RIM. The gradient rim belonged to
                // a surface pretending to catch light. Over pure black the edge
                // has one job — say where the capsule ends — and a flat white
                // line does it identically on every backdrop.
                //
                // The TINTED case is untouched: a mode still takes its own
                // colour at full presence, which is the existing idea and the
                // reason nothing new had to be invented to mark a lane.
                //
                // strokeBorder, NOT stroke. A stroke is centred on the path, so
                // half its width falls OUTSIDE the capsule and anti-aliases
                // against the desktop — the edge picks up the wallpaper and
                // reads soft over anything busy. strokeBorder insets by half a
                // line, so the whole width lands on the black and the edge is
                // the same crisp white on every backdrop.
                //
                // GREY, AND 1pt — thin by COLOUR, not by sub-pixel width.
                //
                // 0.5pt looked like the obvious way to get a thinner line and
                // is the one width that cannot be drawn reliably: on a 2x
                // display it is exactly ONE device pixel, so unless it lands
                // dead on a pixel row it splits across two at ~50% coverage
                // each — 18% of an already grey line, which is nothing. It
                // failed on the TOP AND BOTTOM edges first, because those are
                // long horizontal runs that share one alignment for their whole
                // length, while the rounded ends always catch some pixel and
                // kept looking fine. The reported symptom was exactly that: a
                // border missing along the top.
                //
                // 1pt is two device pixels and survives any offset. What made
                // the earlier 1pt rim look heavy was 0.9 white, not its width,
                // so the weight comes off the colour instead: 0.30 over black
                // is about (77,77,77). The rim's whole job is to say where the
                // capsule ends, and it should not compete with the waveform.
                .overlay(
                    shape.strokeBorder(
                        tint.map { AnyShapeStyle($0.opacity(0.95)) }
                            ?? AnyShapeStyle(Color.white.opacity(0.30)),
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
    func pillGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil) -> some View {
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
    @State private var pillHovered = false
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
            .animation(Theme.morph, value: padExpanded)
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
    /// the mic chip and the scratchpad chip alike — one height,
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
            }

            pill
                .environment(\.pillHovered, pillHovered)
                .onHover { pillHovered = $0 }
                .pillGlass(Capsule(), tint: pillTint)

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
            // THE WAVEFORM, AND NOTHING ELSE AT REST.
            //
            // It used to be dot + waveform + stop. All three said the same
            // thing: a red dot means recording, a moving waveform means
            // recording, and a stop button is only there while recording. Three
            // marks for one fact, permanently on screen.
            //
            // The dot is gone. The stop button is gone — the trigger key
            // already stops, and it is the only way anyone stops with their
            // hands off the mouse. What the pointer gains instead is CANCEL,
            // revealed on hover, which is a different act the key cannot
            // express: throw this away rather than finish it.
            //
            // The Remote glyph STAYS. It is not a recording indicator, it is
            // the lane — "these words are going to a session, not your cursor"
            // — and no other element carries that, since an untinted pill takes
            // the plain white rim.
            HStack(spacing: 10) {
                if s.kind == .remote {
                    // A Remote capture reads as Remote AT A GLANCE, from the
                    // glyph — which is why the original swapped the dot rather
                    // than adding a word.
                    RemoteGlyph()
                }
                // WHAT IT IS HEARING, not how long you have been at it.
                //
                // A timer answers a question nobody asks. Mid-sentence the
                // question is "is it picking me up", and a count of seconds
                // ticks up identically whether the mic is live or dead. The
                // waveform is flat when the level is zero, so it answers that
                // one honestly.
                //
                // The countdown is kept for the last stretch before the cap:
                // there, seconds remaining IS the information, and losing it
                // would make the cut-off arrive unannounced.
                if s.maxSeconds - s.elapsed <= 15 {
                    TimerText(elapsed: s.elapsed, max: s.maxSeconds)
                } else {
                    // NO FIXED WIDTH ANY MORE. 78pt sized a scrolling history
                    // — how much of the last second stayed on screen. A row of
                    // seven dots that never moves sideways is exactly as wide
                    // as the row, and padding it out to 78 would only open a
                    // gap on either side of it. The count is fixed, so the
                    // capsule's width is still constant while recording.
                    Waveform(level: s.level, color: Theme.text)
                }
                CancelOnHover { model.emit(.cancel) }
            }
            // SYMMETRIC, because there is no longer anything to counterweight.
            // 15/7 existed to balance a 30pt stop button hanging off the right.
            .padding(.horizontal, 14)
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
                    // ONE LINE, AND THE CAPSULE GROWS TO FIT IT. Without these
                    // the label wraps inside a capsule narrower than the word,
                    // and "Processing" renders as "Processi / ng" — broken
                    // mid-word across two lines. The pill is a strip: text
                    // never wraps in it, the strip widens instead.
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
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

/// CANCEL, AND ONLY WHILE THE POINTER IS ON THE PILL.
///
/// The capsule holds the waveform alone at rest. Hovering reveals this and the
/// capsule widens by exactly the room it needs — the waveform never moves, only
/// the right edge travels.
///
/// WHY WIDTH AND PADDING, NOT `if hovering`. Inserting a view on hover makes
/// SwiftUI re-lay the row and the waveform jumps sideways. Keeping it in the
/// hierarchy at zero width and animating the width means the capsule grows and
/// nothing inside it moves.
///
/// AND WHY THE PADDING IS ON THIS VIEW. `HStack(spacing:)` applies its spacing
/// to every child including a zero-width one, so at rest the row would carry
/// 10pt of dead space on the right and the waveform would sit off-centre in a
/// capsule that looked symmetric. The leading pad belongs to the control and
/// collapses with it.
private struct CancelOnHover: View {
    let action: () -> Void
    @State private var hovering = false
    /// Set by the parent capsule, so the control appears when the pointer is
    /// anywhere on the pill rather than only on the 22pt target itself.
    @Environment(\.pillHovered) private var pillHovered

    private var shown: Bool { pillHovered || hovering }

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(Color.white.opacity(hovering ? 0.95 : 0.55))
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.14 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .frame(width: shown ? 22 : 0)
        .padding(.leading, shown ? 9 : 0)
        .opacity(shown ? 1 : 0)
        .allowsHitTesting(shown)
        .clipped()
        .animation(Theme.hover, value: shown)
        .help("Cancel — discard this recording")
    }
}

/// True while the pointer is anywhere on the capsule. Read by CancelOnHover so
/// the control answers to the whole pill, not to its own 22pt.
private struct PillHoveredKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var pillHovered: Bool {
        get { self[PillHoveredKey.self] }
        set { self[PillHoveredKey.self] = newValue }
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
                // The padded capsule IS the button, not just the glyph inside.
                .contentShape(Capsule())
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
    /// SHORTER AND LONGER. 44 was sized around a row that carried a dot, a
    /// timer and a stop button; with only the waveform inside, that height is
    /// mostly air. 36 is the floor: the 18pt note-pen glyph the scratchpad chip
    /// draws still clears the capsule's curve, and it keeps 8pt above and below
    /// the 20pt waveform.
    static let height: CGFloat = 36
}

private struct ChipBody<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(spacing: 6) { content() }
            // SQUARE, SO THE CAPSULE IS A CIRCLE. These carry one glyph each,
            // and 14pt of horizontal padding around an 11pt icon made them
            // 39 × 36 — a stadium, because a Capsule is only a circle when its
            // frame is square. The padding was inherited from a chip that held
            // text; nothing here does.
            .frame(width: PillMetrics.height, height: PillMetrics.height)
            // THE WHOLE CHIP IS THE BUTTON, not the glyph inside it.
            //
            // Without this, SwiftUI hit-tests the RENDERED content — so a chip
            // that is 30pt of capsule around an 11pt icon only responded on the
            // icon, and the padding that exists to make it easy to hit did the
            // opposite. Stated explicitly so the target matches what is drawn.
            .contentShape(Capsule())
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
                // THE CONNECTION DOT IS GONE, and its job was reassigned rather
                // than dropped. It said "this backend can take work right now"
                // — but the label has always spelled that out too ("· connect"),
                // and beside a logo the dot read as decoration. The mark itself
                // now carries the state: full strength when reachable, faded
                // when not, next to a label that says why.
                // WHAT YOU PICKED, WEARING ITS MARK — the closed chip is the
                // part you read at a glance, and it named the backend in words
                // while every other surface had learned to show it. 13pt, the
                // same figure as the cards and the rows inside this panel.
                if let picked = state.agentOptions?.first(where: { $0.label == (state.agent ?? "") }) {
                    ProviderMark(backend: picked.id, terminal: picked.terminal ?? true)
                        .opacity(state.agentConnected ? 1 : 0.45)
                }
                Text((state.agent ?? "Claude Code") + (state.agentConnected ? "" : " · connect"))
                    .font(.system(size: 12.5, weight: .semibold))
                    // THE AGENT LANE WEARS ITS OWN COLOUR. There is nothing to
                    // choose in it, so the label is all there is — and it needs
                    // to be legible at a glance as a different lane, not a
                    // differently-worded version of the same one.
                    .foregroundColor(isAgentLane
                        ? Theme.cReady
                        : Theme.text.opacity(state.agentConnected ? 1 : 0.55))
                    .lineLimit(1)
                if let m = state.model {
                    // NOT Claude's brand orange — this chip also represents
                    // Codex. Emphasis lives on the active row inside the panel.
                    Text(m)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                }
                // NO AFFORDANCE IN THE AGENT LANE. Suppressing the OPTIONS was
                // not enough: the chip stayed a button, so tapping it opened a
                // panel headed "No models to choose from". An empty control is
                // worse than none — it advertises a choice that does not exist.
                if !isAgentLane {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(Theme.textFaint)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
            }
            // Symmetric, now that there is no seam to compensate for.
            .padding(.horizontal, 15)
            .frame(height: PillMetrics.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The Agent has one provider, set once in Settings. Nothing here is a
        // control, so it does not accept a tap at all.
        .allowsHitTesting(!isAgentLane)
        .pillGlass(Capsule())
        .animation(Theme.hover, value: open)
    }

    /// The Agent lane is recognised by having nothing to offer: the engine
    /// blanks both option lists for it, and only for it.
    private var isAgentLane: Bool {
        (state.agentOptions?.isEmpty ?? true) && (state.modelOptions?.isEmpty ?? true)
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
    private var options: [PillOption] { state.modelOptions ?? [] }
    /// The SELECTED backend's id, resolved through the options the engine sent.
    /// Was a label comparison against the literal "Codex", which is both a
    /// display string and unable to name a third backend.
    private var agentId: String {
        state.agentOptions?.first(where: { $0.label == (state.agent ?? "") })?.id ?? "claude"
    }

    /// HOW THE MODEL CONTROL IS SHAPED, decided by WHAT THE ENGINE SENT rather
    /// than by which backend this is.
    ///
    /// This was `agentId == "codex-desktop"`, and it is the reason Codex CLI
    /// shipped with an empty Model column in 1.4.24-dev.6. That backend's id is
    /// `codex`, so the literal was false, so this drew the flat list — from
    /// `modelOptions`, which the engine had deliberately left empty because it
    /// was sending axes. Six models arrived, decoded, and were never drawn.
    ///
    /// A LITERAL BACKEND NAME CANNOT ANSWER THIS QUESTION. Two Codex backends
    /// want axes and two Claude ones want a list, so the rule is not "is this
    /// Codex" and never was — it is "did the engine send me axes or a list",
    /// which is answerable from the payload alone and stays right for the next
    /// backend without a line of Swift changing. The comment on `agentId` above
    /// says exactly this about its own literal; the fix stopped one line short.
    private enum Chooser { case axes, list, empty }
    private var chooser: Chooser { !axes.isEmpty ? .axes : (options.isEmpty ? .empty : .list) }

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
                if state.taskId == nil {
                    agentColumn(state.agentOptions ?? [])
                }

                switch chooser {
                case .axes:
                    ForEach(axes) { a in
                        column(a.axis, rows: a.values.map { ($0, $0 == a.current) }) { v in
                            model.emit(.pickAxis(axis: a.axis, value: v))
                        }
                    }
                case .list:
                    column("Model", rows: options.map { ($0.label, $0.label == state.model) }) { label in
                        if let o = options.first(where: { $0.label == label }) {
                            model.emit(.pickModel(o.id))
                        }
                    }
                case .empty:
                    // HONEST EMPTY STATE, IN THE ENGINE'S WORDS. Falling through
                    // to another backend's list is what made picking a model
                    // silently write the wrong setting. The sentence is sent
                    // rather than written here because the reason differs by
                    // backend — an app to open, or a command that could not be
                    // reached — and this view has no way to know which.
                    VStack(alignment: .leading, spacing: 2) {
                        header("Model")
                        Text(state.modelEmpty ?? "No models to choose from")
                            .font(.system(size: 12)).foregroundColor(Theme.textFaint)
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(minWidth: 150, maxWidth: 220, alignment: .leading)
                }
            }
        }
        .padding(8)
        .pillGlass(RoundedRectangle(cornerRadius: 14))
        .fixedSize()
    }

    private var summary: String {
        // Axes describe themselves ("5.6 Terra · Extra High"); a flat list is
        // named by the chip. Keyed off the payload for the same reason as
        // `chooser` — a backend name here would drift from the branch above.
        let vals = axes.compactMap(\.current)
        if !vals.isEmpty { return vals.joined(separator: " · ") }
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

    /// The AGENT column: the same rows, each wearing its provider's mark.
    /// Separate from `column` because only backends have marks — a model or an
    /// effort is not a product with a logo.
    private func agentColumn(_ agents: [PillOption]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            header("Agent")
            ForEach(agents) { o in
                SelectorRow(label: o.label, on: o.id == agentId,
                            backend: o.id, terminal: o.terminal ?? true) {
                    model.emit(.pickAgent(o.id))
                }
            }
        }
        .frame(minWidth: 118, alignment: .leading)
    }
}

private struct SelectorRow: View {
    let label: String
    let on: Bool
    /// AGENT ROWS ONLY: the backend this row picks, so it can wear its mark.
    /// Absent for model/effort/speed rows, which are not backends.
    var backend: String? = nil
    var terminal: Bool = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .opacity(on ? 1 : 0)
                    .frame(width: 11)
                // THE SAME MARK, THE SAME SIZE, as the pocket and the cards.
                // A picker that names backends should show them the way every
                // other surface does — 13pt is the shared figure.
                if let b = backend {
                    ProviderMark(backend: b, terminal: terminal)
                }
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
                // NOTE + PEN — a ruled page with a pen laid across it. The pen
                // says "write", the ruled page says "onto the pad"; either half
                // alone says only half of it, which is why `pencil.tip` was
                // wrong here twice over. It is also unreadable: SF's nib is a
                // 10.6 × 13.8pt glyph that is almost all outline, and at the
                // 13pt this row uses it collapses into a narrow caret.
                //
                // Drawn, not `Image(systemName:)`, because NO SF Symbol carries
                // both halves at our floor. `long.text.page.and.pencil` is
                // exactly this glyph but is macOS 15.4; `pencil.and.list.
                // clipboard` is 14.0 and is a clipboard, not a page; everything
                // available on macOS 13 has the page (`note.text`, `doc.text`)
                // or the pen (`square.and.pencil`) but never the two together.
                // Gating on `#available` would put a different glyph on
                // different Macs, which is worse than drawing one.
                NotePenGlyph()
                    .stroke(style: StrokeStyle(lineWidth: NotePenGlyph.strokeWidth,
                                               lineCap: .round, lineJoin: .round))
                    .frame(width: NotePenGlyph.side, height: NotePenGlyph.side)
                    .foregroundColor(armed ? Theme.cReady : Theme.textFaint)
            }
        }
        .buttonStyle(.plain)
        .help(armed ? "Keeping on stop — tap to deliver normally again"
                    : "Keep on stop instead of delivering")
    }
}

/// The scratchpad chip's glyph: a ruled page, open on the right, with a pen
/// laid diagonally across it — nib at the lower left, rounded butt upper right.
///
/// Traced from the approved 24×24 artwork, but the stroke is NOT taken from it.
/// The artwork's 1.6-unit stroke would come out at 1.2pt here, and measuring the
/// bitmaps SF Symbols actually produces puts a regular-weight 13pt glyph at
/// 1.0pt — so the width is pinned to that instead, and the chip sits in a row of
/// system glyphs without reading heavier than them.
private struct NotePenGlyph: Shape {
    /// Side of the artwork's viewBox. All coordinates below are in its units.
    static let unit: CGFloat = 24
    /// Frame side. Yields a 15 × 15pt inked glyph — between `note.text` (13 ×
    /// 12) and `long.text.page.and.pencil` (14 × 16) at the same 13pt, and the
    /// same width as the `laptopcomputer` mic glyph next door (15.5).
    static let side: CGFloat = 18
    static let strokeWidth: CGFloat = 1

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / Self.unit
        // The ink spans x 4…22, a unit right of the viewBox's centre. Shift it
        // back, or the glyph sits off-centre in a capsule that is centred on it.
        let ox = rect.midX - (Self.unit / 2 + 1) * s
        let oy = rect.midY - Self.unit / 2 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: ox + x * s, y: oy + y * s)
        }

        var path = Path()

        // THE PAGE — left edge only, open on the right where the pen crosses.
        // The two corners are true quarter-circles, so `addArc(tangent…)`
        // rather than a quad curve: at this size the difference between a
        // circular fillet and a parabolic one is a visibly slack corner.
        path.move(to: p(14, 3))
        path.addArc(tangent1End: p(4, 3), tangent2End: p(4, 5), radius: 2 * s)
        path.addArc(tangent1End: p(4, 21), tangent2End: p(6, 21), radius: 2 * s)
        path.addLine(to: p(14, 21))

        // TWO RULED LINES. 4 units apart ⇒ 3pt here, less 1pt of stroke, so 2pt
        // of white between them — 4 device pixels on the Retina panel the notch
        // is always on. They stay two lines rather than fusing into a block.
        path.move(to: p(8, 8))
        path.addLine(to: p(13, 8))
        path.move(to: p(8, 12))
        path.addLine(to: p(12, 12))

        // THE PEN. A parallelogram body closed by a triangular nib at (13.5,
        // 19.5), and a semicircular butt across the far end — centre (21, 12),
        // radius half the body's width. The artwork writes that butt as an SVG
        // elliptical arc whose stated 1.8 radius is smaller than its own chord
        // and so gets scaled up to √2 by the SVG rules; stating √2 directly is
        // the same curve without the implicit correction.
        path.move(to: p(20, 11))
        path.addLine(to: p(14, 17))
        path.addLine(to: p(13.5, 19.5))
        path.addLine(to: p(16, 19))
        path.addLine(to: p(22, 13))
        path.addArc(center: p(21, 12), radius: sqrt(2) * s,
                    startAngle: .degrees(45), endAngle: .degrees(225),
                    clockwise: true)
        path.closeSubpath()

        return path
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
                    // A 9pt glyph is a 9pt target without this — the smallest
                    // control in the app and the hardest to hit.
                    .frame(width: 22, height: 22)
                    .contentShape(Circle())
            }.buttonStyle(.plain)
        }
        .padding(.leading, 13).padding(.trailing, 11)
        .frame(height: PillMetrics.height)
        .pillGlass(Capsule(), tint: reason.isRecoverable ? Theme.cNeeds : nil)
    }
}
