import SwiftUI

// THE POCKET — the state between expanded and gone.
//
// Leaving a task used to mean closing it, and closing says "I am done with
// this", which is rarely what was meant: the user changed window BECAUSE they
// had to go look at something in order to answer. Their only escape from a
// panel covering 70% of the display carried a meaning they did not intend, and
// getting back to the task afterwards meant a trip through the dashboard.
//
// So an expanded task now collapses INTO the notch. It stays alive, stays in
// the crank, stays unmuted — and stays the address your voice reaches.
//
// TWO SHAPES, AND THE SPLIT BETWEEN THEM IS THE WHOLE DESIGN:
//
//   at rest    the notch itself, tinted, reading "3 in your pocket". There is
//              no new window and no floating widget: the footprint is a surface
//              that was already on screen, so it covers nothing. Any card big
//              enough to read is a card big enough to be in the way, and the
//              thing you need it for lasts a few seconds.
//   open       one card, and only while it is useful — while you are SPEAKING
//              (transient) or because you tapped it (sticky).
//
// Transient must never become an aim. If merely speaking counted as opening the
// pocket, every utterance would silently target a pocketed task, which is the
// exact thing a closed pocket exists to prevent. Transient REVEALS the address;
// sticky DECIDES it. See applyVoiceTarget in notch-controller.ts.

/// The notch at rest, holding things. Deliberately the same shape as the bar —
/// it is the bar — just tinted and counting.
struct PocketNub: View {
    let pocket: PocketP

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.cNeeds).frame(width: 8, height: 8)
            Text(label)
                .font(Theme.fSub).foregroundColor(Theme.textDim)
                .lineLimit(1)
        }
        .padding(.horizontal, 13)
    }

    private var label: String {
        let n = pocket.taskCount
        return n == 1 ? "1 in your pocket" : "\(n) in your pocket"
    }
}

/// The open card: what your next words land on, and one keypress to change it.
struct PocketCard: View {
    @ObservedObject var model: NotchModel
    /// True while the mic is actually hot — the route line says "listening"
    /// rather than "your voice goes to", because one is happening and the
    /// other is a promise about the future.
    let listening: Bool

    private var pocket: PocketP { model.pocket }
    private var slot: PocketSlotP? { pocket.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            header
            detail
            rail
            route
        }
        .padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 9)
    }

    // ── the address ───────────────────────────────────────────────────────
    //
    // THE POCKET IS A GLANCE, NOT A DESTINATION. It exists because the expanded
    // panel takes the whole screen, not because the expanded panel is wrong —
    // so getting back to it has to be one tap. Without this the state was a
    // one-way door: leave a task and the only route back was the dashboard,
    // which is the exact trip the pocket was built to save.
    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(dotColor).frame(width: 8, height: 8)
            Text(slot?.title ?? "Nothing in your pocket")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(isNew ? Theme.cWorking : Theme.text)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            if canExpand {
                Button { model.emit(.pocketExpand) } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 8.5, weight: .semibold))
                        Text("Open").font(.system(size: 10.5, weight: .medium))
                    }
                    .foregroundColor(Theme.textDim)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.hairline, lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .help("Back to the full task")
            }
        }
        // The whole row is the target too — a card showing one task should open
        // that task when you click it, button or no button.
        .contentShape(Rectangle())
        .onTapGesture { if canExpand { model.emit(.pocketExpand) } }
    }

    /// Only a real task can be opened; the two synthetic stops have nothing
    /// behind them to expand into.
    private var canExpand: Bool { slot?.kind == "task" }

    @ViewBuilder private var detail: some View {
        // Two lines, hard. This card exists so you can remember WHICH thing you
        // are answering — reading the whole ask is what expanding is for, and a
        // card that grows is a card back in your way.
        Text(detailText)
            .font(.system(size: 12)).foregroundColor(Theme.textDim)
            .lineLimit(2).truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var detailText: String {
        guard let s = slot else { return "" }
        switch s.kind {
        // Says what it will do AND how to overrule it, because this is the stop
        // you land on by simply pressing the key — the moment someone asks
        // "how do I just start something new?"
        case "auto": return "Unmute picks from what you said. Press → to force a new task, ← for one you set aside."
        case "new":  return "Whatever you say next starts something new. Nothing reaches what you set aside."
        default:     return s.ask ?? "Waiting on you."
        }
    }

    // ── choosing ──────────────────────────────────────────────────────────
    private var rail: some View {
        HStack(spacing: 7) {
            arrow("chevron.left") { model.emit(.pocketMove(delta: -1)) }
            // THE GHOST HINT. The carousel wraps, so `+ New task` is always ONE
            // press to the left of the first task however many you have set
            // aside — but that was invisible, and an escape hatch nobody can
            // see is not an escape hatch.
            if let g = ghost {
                Text(g.0).font(.system(size: 10, design: .monospaced))
                    .foregroundColor(g.1).lineLimit(1)
            }
            Spacer(minLength: 0)
            pips
            Spacer(minLength: 0)
            arrow("chevron.right") { model.emit(.pocketMove(delta: 1)) }
            arrow("xmark") { model.emit(.pocketRelease) }
        }
    }

    /// EVERY STOP SAYS WHERE NEW TASK IS. The carousel wraps so `+ New task` is
    /// one press from both places it ever starts — but `auto` had no hint at
    /// all, which is where you land the moment you press the key with something
    /// pocketed. So the commonest way in was the one with nothing pointing at
    /// the way out, and "how do I just make a new task?" had no visible answer.
    private var ghost: (String, Color)? {
        guard pocket.slots.count > 1 else { return nil }
        switch slot?.kind {
        case "auto": return ("+ New task →", Theme.cWorking)   // one press RIGHT, wrapping
        case "new":  return pocket.slots.count > 2 ? ("→ \(pocket.slots[1].title)", Theme.cNeeds) : nil
        default:     return pocket.at == 1 ? ("← + New task", Theme.cWorking) : nil
        }
    }

    private var pips: some View {
        HStack(spacing: 4) {
            ForEach(Array(pocket.slots.enumerated()), id: \.offset) { i, s in
                Circle()
                    .fill(i == pocket.at ? (s.kind == "new" ? Theme.cWorking : Theme.cNeeds)
                                         : Color.white.opacity(0.22))
                    .frame(width: 5, height: 5)
            }
        }
    }

    private func arrow(_ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 9, weight: .semibold))
                .foregroundColor(Theme.textDim)
                .frame(width: 24, height: 22)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }

    // ── where the words go ────────────────────────────────────────────────
    private var route: some View {
        HStack(spacing: 5) {
            if listening {
                Circle().fill(Theme.cError).frame(width: 6, height: 6)
            }
            Text(routeText)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(listening ? Theme.text : Theme.textFaint)
                .lineLimit(1).truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 5)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(height: 0.5), alignment: .top)
    }

    private var routeText: String {
        let name = slot?.kind == "new" ? "new task"
                 : slot?.kind == "auto" ? "wherever it fits"
                 : (slot?.title ?? "nothing")
        return listening ? "listening → \(name)" : "your voice goes to \(name)"
    }

    private var isNew: Bool { slot?.kind == "new" }
    private var dotColor: Color {
        switch slot?.kind {
        case "new":  return Theme.cWorking
        case "auto": return Theme.textFaint
        default:     return slot?.status == "ready" ? Theme.cReady : Theme.cNeeds
        }
    }
}
