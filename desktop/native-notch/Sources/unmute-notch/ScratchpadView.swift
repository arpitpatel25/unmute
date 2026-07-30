import SwiftUI

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
struct ScratchpadView: View {
    let pad: ScratchpadPad
    let destinations: ScratchpadDestinations
    let armed: Bool
    /// A delivery is in flight. See the footer.
    let delivering: Bool
    let onRemove: (String) -> Void
    let onDeliver: (String) -> Void
    let onDiscard: () -> Void

    @State private var expanded: Set<String> = []

    private var ordered: [ScratchpadDestination] { destinations.ordered(origin: pad.origin) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.hairline)

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
            .frame(maxHeight: 320)

            Divider().overlay(Theme.hairline)
            footer
        }
        .frame(width: 340)
        .pillGlass(RoundedRectangle(cornerRadius: 14))
    }

    /// Says what the surface IS, because a floating list of fragments with no
    /// title is not self-explanatory the first time it appears. The arm state is
    /// here too: it is the difference between "this keeps growing" and "this is
    /// what you have", and the icon that controls it is on a pill that may not
    /// be on screen right now.
    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: armed ? "note.text.badge.plus" : "note.text")
                .font(.system(size: 11))
                .foregroundColor(armed ? Theme.cReady : Theme.textFaint)
            Text("Scratchpad")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(Theme.text)
            Text(armed ? "keeping" : "held")
                .font(.system(size: 11))
                .foregroundColor(Theme.textFaint)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            // The primary is whichever destination the capture opened with; the
            // rest are alternatives. "Add to <task>" is present only when a task
            // is really focused.
            ForEach(ordered) { d in
                PadButton(label: d.label, prominent: d.isPrimary, enabled: !delivering) {
                    onDeliver(d.id)
                }
            }
            Spacer(minLength: 6)
            // DISCARD IS NOT A CANCEL, and must never look like one.
            //
            // Once a delivery is in flight the pad has already been TAKEN for
            // it — the text exists only inside the attempt, and if the
            // destination refuses, the delivery seam puts the pad back. Discard
            // deliberately cannot reach into that: a pad taken for delivery is
            // work the user tried to SEND. Offering a live Discard here would
            // read as "stop the send", which it would not do, so it goes quiet
            // for the moment the question is unanswerable.
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
                    .foregroundColor(Theme.textFaint)
                    .frame(width: 12)
                Text(entry.preview)
                    .font(.system(size: 12.5))
                    .foregroundColor(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if let d = entry.durationLabel {
                    Text(d)
                        .font(.system(size: 11)).monospacedDigit()
                        .foregroundColor(Theme.textFaint)
                }
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.textFaint)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Remove this from the pad")
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7)
                .fill(hovering ? Color.white.opacity(0.06) : .clear))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture { if entry.isSegment { onToggle() } }

            if isExpanded {
                Text(entry.full)
                    .font(.system(size: 12.5))
                    .foregroundColor(Theme.textDim)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 24).padding(.trailing, 8)
                    .padding(.bottom, 4)
            }
        }
        .animation(Theme.hover, value: isExpanded)
    }
}

/// The footer's button. Same capsule vocabulary as the pill's CapsuleButton —
/// this surface is part of the same instrument, not a dialog.
private struct PadButton: View {
    let label: String
    var prominent: Bool = false
    var destructive: Bool = false
    var enabled: Bool = true
    let action: () -> Void
    @State private var hovering = false

    private var ink: Color {
        if !enabled { return Theme.textFaint }
        if prominent { return Theme.accentInk }
        return destructive ? Theme.cError : Theme.text
    }

    var body: some View {
        Button(action: { if enabled { action() } }) {
            Text(label)
                .font(.system(size: 12, weight: prominent ? .semibold : .regular))
                .foregroundColor(ink)
                .lineLimit(1)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(Capsule().fill(prominent && enabled
                                           ? Theme.accent.opacity(hovering ? 0.86 : 1)
                                           : Color.white.opacity(enabled && hovering ? 0.18 : 0.10)))
                .overlay(Capsule().stroke(prominent && enabled ? Color.clear : Color.white.opacity(0.30),
                                          lineWidth: 0.5))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
        .onHover { hovering = $0 && enabled }
        .animation(Theme.hover, value: hovering)
    }
}
