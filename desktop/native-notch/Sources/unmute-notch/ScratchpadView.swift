import SwiftUI

/// THE PAD IS PAPER, NOT APP CHROME.
///
/// Everything else in the cluster is glass: a lens over the user's desktop that
/// belongs to the instrument. The pad is the one surface that holds the USER'S
/// OWN WORDS, and a note is what people already know how to read. So it is
/// off-white card stock with ink on it — and it stays that way in BOTH system
/// appearances, because paper does not have a dark mode. Every colour below is
/// a literal, deliberately, so nothing here can be re-tinted by the environment.
///
/// It is also the reason this file takes none of `Theme`'s COLOURS and never
/// touches `pillGlass`: those are the instrument's vocabulary and mixing them is
/// how a note turns back into a panel. It does still use Theme's animation
/// CURVES (`morph`, `hover`) — the pad should move like the rest of the
/// surface even though it does not look like it.
enum PadPaper {
    /// Off-white card. #FEFCF7
    static let paper      = Color(red: 254.0 / 255, green: 252.0 / 255, blue: 247.0 / 255)
    /// #221F1B
    static let ink        = Color(red: 34.0 / 255, green: 31.0 / 255, blue: 27.0 / 255)
    /// #8B8377
    static let inkSoft    = Color(red: 139.0 / 255, green: 131.0 / 255, blue: 119.0 / 255)
    /// #E8E2D6
    static let divider    = Color(red: 232.0 / 255, green: 226.0 / 255, blue: 214.0 / 255)
    /// #DAD3C4
    static let edge       = Color(red: 218.0 / 255, green: 211.0 / 255, blue: 196.0 / 255)
    /// #F4F0E6
    static let rowHover   = Color(red: 244.0 / 255, green: 240.0 / 255, blue: 230.0 / 255)
    /// #FFFFFF
    static let buttonFace = Color.white
    /// #0E7C7B
    static let primary    = Color(red: 14.0 / 255, green: 124.0 / 255, blue: 123.0 / 255)
    static let primaryInk = Color.white

    /// #9A3412 — the ONE addition to the approved palette, for Discard.
    ///
    /// It is an OXIDE, not an alert. The system's red (#FF3B30 and its
    /// relatives) is a screen colour: cool, saturated, and instantly read as
    /// chrome belonging to the OS rather than marking on the page. This is iron
    /// oxide — the red of a rubber stamp or a correcting pen — and it is warm,
    /// which is what lets it sit on a warm off-white beside tan rules instead of
    /// floating above them.
    ///
    /// It also cannot fight the primary. #0E7C7B is a cyan-leaning teal and this
    /// is very nearly its opposite on the wheel, so the two never compete for
    /// the same register; and the teal carries a FILLED capsule while this is
    /// ink on white, which is the heavier of the two by a wide margin. Discard
    /// is unmissable without becoming the thing your eye lands on first.
    ///
    /// Contrast, computed (WCAG relative luminance): 7.3:1 on the white button
    /// face and 7.1:1 on the paper — comfortably past AA at this size, and
    /// deliberately below the body ink's ~16:1 so it reads as emphasis rather
    /// than as the loudest text on the surface.
    static let destructive = Color(red: 154.0 / 255, green: 52.0 / 255, blue: 18.0 / 255)

    /// THE PAD'S WIDTH IS FIXED. A content-sized pad would move its own left
    /// edge — and, since it is a sibling in a centred row, the pill with it —
    /// every time a row's text changed.
    static let width: CGFloat = 340
    /// Collapsed it is a cluster button and nothing more, so it carries the
    /// cluster's height and radius rather than a shape of its own.
    static let collapsedWidth: CGFloat = 148
    static let radius: CGFloat = 14
    static var collapsedRadius: CGFloat { PillMetrics.height / 2 }   // 22
    /// The cluster's own inter-element spacing. The pad is one more element in
    /// that row, so it uses the row's gap and not a gap of its own.
    static let gap: CGFloat = 8
}

/// The pad. Appears only when there is content.
///
/// STRUCTURED ROWS, NOT PROSE. The job at review time is confirmation — are the
/// right things attached, where is this going — not proofreading words you said
/// thirty seconds ago. A continuous transcript would also be unable to preview
/// the output honestly, since rendering depends on a destination the user has
/// not picked yet: inline at a cursor, fenced in a task.
///
/// SEND AND DISCARD LIVE HERE, not on the pill's icon. The icon arms and
/// disarms only. A toggle reads as reversible, so toggle-off-to-send would turn
/// a user's "never mind" into a dispatched task — a silent commit dressed as a
/// mode switch. These two buttons are the deliberate acts, and they look like it.
///
/// COLLAPSE IS NOT AN EXIT. Collapsed, the pad is a 44pt capsule saying
/// "Scratchpad" — the same height and radius as every other button in the
/// cluster, because that is what it has become for the moment. The work is
/// untouched; only the reading of it is put away. The only things that end a
/// pad are the three in the footer.
struct ScratchpadView: View {
    let pad: ScratchpadPad
    let destinations: ScratchpadDestinations
    let armed: Bool
    /// A delivery is in flight. See the footer.
    let delivering: Bool
    /// Owned by PillView, not by this view: it changes how wide the pad is, and
    /// the pad is a sibling in a centred row, so collapsing moves the pill too.
    /// The row and the pad have to agree about it.
    @Binding var expandedPad: Bool
    let onRemove: (String) -> Void
    let onDeliver: (String) -> Void
    let onDiscard: () -> Void

    @State private var expanded: Set<String> = []

    private var ordered: [ScratchpadDestination] { destinations.ordered(origin: pad.origin) }

    var body: some View {
        Group {
            if expandedPad { sheet } else { tab }
        }
        .animation(Theme.morph, value: expandedPad)
    }

    // MARK: - Expanded

    private var sheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            rule

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(pad.entries) { entry in
                        EntryRow(
                            entry: entry,
                            isExpanded: expanded.contains(entry.id),
                            onToggle: {
                                if expanded.contains(entry.id) { expanded.remove(entry.id) }
                                else { expanded.insert(entry.id) }
                            },
                            onRemove: { onRemove(entry.id) }
                        )
                    }
                }
                .padding(8)
            }
            // KEPT INSIDE THE PILL WINDOW'S CANVAS, which is why this ceiling
            // came down from 320. The pad grows upward from the cluster's
            // baseline inside the pill's 400pt panel, and content outside a
            // hosting view's bounds is clipped, not merely off-screen. The
            // budget: 4 (the row's bottom padding) + 34 (header) + 1 + THIS + 1
            // + 43 (footer) + 53 (the lift when an awareness card is under the
            // pill) = 376 of 400.
            .frame(maxHeight: 240)

            rule
            footer
        }
        .frame(width: PadPaper.width)
        .background(paper(RoundedRectangle(cornerRadius: PadPaper.radius)))
    }

    // MARK: - Collapsed

    /// A cluster button, not a shrunken window. One height, one radius — the
    /// same rule PillMetrics states for every other element in the row.
    private var tab: some View {
        Button(action: { expandedPad = true }) {
            HStack(spacing: 8) {
                nib
                Text("Scratchpad")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(PadPaper.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(PadPaper.inkSoft)
            }
            .padding(.horizontal, 14)
            .frame(width: PadPaper.collapsedWidth, height: PillMetrics.height)
            .background(paper(RoundedRectangle(cornerRadius: PadPaper.collapsedRadius)))
            .contentShape(RoundedRectangle(cornerRadius: PadPaper.collapsedRadius))
        }
        .buttonStyle(.plain)
        .help("Open the scratchpad")
    }

    // MARK: - Parts

    /// A PEN NIB, no page behind it. The pad is the page; drawing a second one
    /// on the control that opens it says the same thing twice.
    private var nib: some View {
        Image(systemName: "pencil.tip")
            .font(.system(size: 12))
            .foregroundColor(armed ? PadPaper.primary : PadPaper.inkSoft)
    }

    /// Says what the surface IS, because a floating list of fragments with no
    /// title is not self-explanatory the first time it appears. The arm state is
    /// here too: it is the difference between "this keeps growing" and "this is
    /// what you have".
    ///
    /// IT IS ALSO THE COLLAPSE CONTROL — one control, in both directions. A
    /// separate close button would read as an exit, and there is no exit here.
    private var header: some View {
        Button(action: { expandedPad = false }) {
            HStack(spacing: 7) {
                nib
                Text("Scratchpad")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(PadPaper.ink)
                Text(armed ? "keeping" : "held")
                    .font(.system(size: 11))
                    .foregroundColor(PadPaper.inkSoft)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(PadPaper.inkSoft)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Put the scratchpad away — nothing is sent and nothing is lost")
    }

    private var rule: some View {
        Rectangle().fill(PadPaper.divider).frame(height: 1)
    }

    private var footer: some View {
        HStack(spacing: 7) {
            // The primary is whichever destination the capture opened with; the
            // rest are alternatives. "Add to <task>" is present only when a task
            // is really focused.
            ForEach(ordered) { d in
                PadButton(label: d.label, prominent: d.isPrimary, enabled: !delivering) {
                    onDeliver(d.id)
                }
            }
            Spacer(minLength: 4)
            // DISCARD IS NOT A CANCEL, and must never look like one.
            //
            // Once a delivery is in flight the pad has already been TAKEN for
            // it — the text exists only inside the attempt, and if the
            // destination refuses, the delivery seam puts the pad back. Discard
            // deliberately cannot reach into that: a pad taken for delivery is
            // work the user tried to SEND. Offering a live Discard here would
            // read as "stop the send", which it would not do, so it goes quiet
            // for the moment the question is unanswerable.
            //
            // RED — see PadPaper.destructive. It is the only thing on this
            // surface that destroys work, and it should look like it. It goes
            // colourless the moment it is disabled, because "Sending…" is a
            // status, not a threat.
            PadButton(label: delivering ? "Sending…" : "Discard",
                      destructive: !delivering,
                      enabled: !delivering,
                      action: onDiscard)
                .help(delivering
                      ? "Sending — this cannot be cancelled; if it fails the pad comes back"
                      : "Throw the pad away")
        }
        .padding(8)
    }

    /// Card stock and its edge. NO DROP SHADOW — see PillView's note: a soft
    /// shadow pools behind the whole cluster and reads as a bounding box around
    /// the surface. The edge does the separating.
    private func paper<S: Shape>(_ shape: S) -> some View {
        shape.fill(PadPaper.paper).overlay(shape.stroke(PadPaper.edge, lineWidth: 0.75))
    }
}

/// One row: a collapsed segment or an insert. Tapping a segment expands it.
private struct EntryRow: View {
    let entry: ScratchpadEntry
    let isExpanded: Bool
    let onToggle: () -> Void
    let onRemove: () -> Void

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: entry.isSegment
                      ? (isExpanded ? "chevron.down" : "chevron.right")
                      : entry.glyph)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(PadPaper.inkSoft)
                    .frame(width: 12)
                Text(entry.preview)
                    .font(.system(size: 12.5))
                    .foregroundColor(PadPaper.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if let d = entry.durationLabel {
                    Text(d)
                        .font(.system(size: 11)).monospacedDigit()
                        .foregroundColor(PadPaper.inkSoft)
                }
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(PadPaper.inkSoft)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Remove this from the pad")
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7)
                .fill(hovering ? PadPaper.rowHover : .clear))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture { if entry.isSegment { onToggle() } }

            if isExpanded {
                Text(entry.full)
                    .font(.system(size: 12.5))
                    .foregroundColor(PadPaper.inkSoft)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 24).padding(.trailing, 8)
                    .padding(.bottom, 4)
            }
        }
        .animation(Theme.hover, value: isExpanded)
    }
}

/// The footer's button. Paper stationery, not the cluster's glass: a white face
/// with a card-stock edge, and one teal primary for the destination the capture
/// was already heading to.
private struct PadButton: View {
    let label: String
    var prominent: Bool = false
    /// Discard. Red ink and a red edge on the same white face — the weight of
    /// the control is unchanged, only its colour, so it cannot be mistaken for
    /// a second primary.
    var destructive: Bool = false
    var enabled: Bool = true
    let action: () -> Void
    @State private var hovering = false

    private var ink: Color {
        if !enabled { return PadPaper.inkSoft }
        if prominent { return PadPaper.primaryInk }
        return destructive ? PadPaper.destructive : PadPaper.ink
    }

    private var face: Color {
        if prominent && enabled { return PadPaper.primary.opacity(hovering ? 0.88 : 1) }
        guard hovering && enabled else { return PadPaper.buttonFace }
        // A wash of the button's OWN colour rather than the generic row hover —
        // the same tone at 8%, so hovering Discard confirms what it is instead
        // of introducing a fourth colour.
        return destructive ? PadPaper.destructive.opacity(0.08) : PadPaper.rowHover
    }

    private var border: Color {
        if prominent && enabled { return .clear }
        return destructive && enabled ? PadPaper.destructive.opacity(0.45) : PadPaper.edge
    }

    var body: some View {
        Button(action: { if enabled { action() } }) {
            Text(label)
                .font(Theme.controlFont)
                .foregroundColor(ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 12).frame(minHeight: Theme.controlHeight)
                .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(PadPaper.buttonFace)
                    .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(face)))
                .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius).stroke(border, lineWidth: 0.75))
                .contentShape(RoundedRectangle(cornerRadius: Theme.controlRadius))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .onHover { hovering = $0 && enabled }
        .animation(Theme.hover, value: hovering)
    }
}
