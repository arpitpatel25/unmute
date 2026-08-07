import SwiftUI

// THE POCKET — a small expanded state.
//
// Leaving a task used to mean closing it, and closing says "I am done with
// this", which is rarely what was meant: the user changed window BECAUSE they
// had to go look at something in order to answer. So an expanded task now
// collapses INTO the notch instead. It stays alive, stays in the crank, stays
// unmuted — and stays reachable.
//
// THERE IS ONE CONCEPT HERE, NOT TWO: a task is in front of you. It comes in
// two sizes — the full panel, or this card — and the aim follows what you can
// see either way:
//
//     task expanded   ->  that task
//     pocket open     ->  the task on the card
//     neither         ->  standard routing, exactly as it always worked
//
// Which is why the pocket must never open ITSELF. An earlier build bloomed the
// card the moment the mic went hot; under this rule that would aim every single
// utterance at a pocketed task, which is the one thing a closed pocket exists
// to prevent. Opening is a decision the user makes. Pressing the key is not
// opening.
//
// And closing is the whole control. Escape shuts the card and the aim goes with
// it, mid-sentence or not — because that is already what closing means on the
// expanded panel. No modifier, no second gesture, nothing new to learn.

/// The notch at rest, holding things. The same shape as the bar — it IS the
/// bar — just tinted and counting.
struct PocketNub: View {
    let pocket: PocketP

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.cNeeds).frame(width: 8, height: 8)
            Text(pocket.taskCount == 1 ? "1 in your pocket" : "\(pocket.taskCount) in your pocket")
                .font(Theme.fSub).foregroundColor(Theme.textDim)
                .lineLimit(1)
        }
        .padding(.horizontal, 13)
    }
}

/// The open card: which task you are addressing, and one keypress to change it.
struct PocketCard: View {
    @ObservedObject var model: NotchModel
    /// True while the mic is actually hot — the route line then says
    /// "listening", because one is happening and the other is a promise.
    let listening: Bool

    private var pocket: PocketP { model.pocket }
    private var slot: PocketSlotP? { pocket.current }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 7) {
                if slot?.isSeam == true { seam } else { taskFace }
                if pocket.slots.count > 1 { rail }
                Spacer(minLength: 0)
                route
            }
            .padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 9)

            // TOP-RIGHT, AND THE STANDARD CONTROL. It sat mid-card beside the
            // arrows, which is nowhere anyone looks for a close.
            Button { model.emit(.pocketRelease) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(Theme.textDim)
                    .frame(width: 17, height: 17)
                    .background(Circle().fill(Theme.raised))
                    .overlay(Circle().stroke(Theme.hairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .padding(9)
            .help("Close — your voice goes back to normal routing")
        }
    }

    @ViewBuilder private var taskFace: some View {
        header
        Text(slot?.ask ?? "Waiting on you.")
            .font(.system(size: 12)).foregroundColor(Theme.textDim)
            .lineLimit(2).truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// THE SEAM — the one card that is not a task.
    ///
    /// It marks where the crank stops being triage and starts being browsing.
    /// Without it that change happens in silence: you keep pressing, the cards
    /// keep coming, and nothing tells you that everything waiting on you is
    /// behind you — so the next thing you say lands in a task you were never
    /// triaging. One keypress across a whole session, and it is where most
    /// people will stop, which is exactly the point of drawing it.
    ///
    /// Deliberately centred and quiet: it is a threshold, not an item, and it
    /// must not read as one more thing demanding something.
    private var seam: some View {
        VStack(spacing: 4) {
            Text("Nothing else is waiting")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(Theme.text)
            if let n = slot?.more, n > 0 {
                Text("\(n) more from today  ›")
                    .font(.system(size: 11))
                    .foregroundColor(Theme.textDim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 6)
        .padding(.trailing, 22)          // the close owns that corner
    }

    // ── which task ────────────────────────────────────────────────────────
    //
    // The card is a GLANCE, not a destination: it exists because the panel is
    // large, not because the panel is wrong. Reading a whole ask or answering a
    // picker still needs the panel, so the way back is one tap.
    private var header: some View {
        HStack(spacing: 8) {
            // WAITING ON YOU READS LOUDER THAN TODAY. The crank now carries
            // both, and a reach item drawn at full weight would make the list
            // look like a dozen things demanding you — which is precisely what
            // the badge, and the seam, exist to stop it from claiming.
            Circle().fill(slot?.demanding == false ? Theme.textDim : Theme.cNeeds)
                .frame(width: 8, height: 8)
            Text(slot?.title ?? "Nothing in your pocket")
                .font(.system(size: 13.5, weight: slot?.demanding == false ? .medium : .semibold))
                .foregroundColor(slot?.demanding == false ? Theme.textDim : Theme.text)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            if slot != nil {
                Button { model.emit(.pocketExpand) } label: {
                    Text("Open")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundColor(Theme.textDim)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Theme.raised))
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.hairline, lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .help("Back to the full task")
            }
        }
        .padding(.trailing, 22)          // the close owns that corner
        .contentShape(Rectangle())
        .onTapGesture { if slot != nil { model.emit(.pocketExpand) } }
    }

    /// Only drawn when there is more than one — a carousel over a single task
    /// is chrome with nothing to do.
    private var rail: some View {
        HStack(spacing: 7) {
            arrow("chevron.left") { model.emit(.pocketMove(delta: -1)) }
            HStack(spacing: 4) {
                ForEach(Array(pocket.slots.enumerated()), id: \.offset) { i, _ in
                    Circle()
                        .fill(i == pocket.at ? Theme.cNeeds : Color.white.opacity(0.22))
                        .frame(width: 5, height: 5)
                }
            }
            .frame(maxWidth: .infinity)
            arrow("chevron.right") { model.emit(.pocketMove(delta: 1)) }
        }
    }

    private func arrow(_ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 9, weight: .semibold))
                .foregroundColor(Theme.textDim)
                .frame(width: 24, height: 21)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.hairline, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }

    // ── where the words go ────────────────────────────────────────────────
    private var route: some View {
        HStack(spacing: 5) {
            if listening { Circle().fill(Theme.cError).frame(width: 6, height: 6) }
            Text(listening
                 ? "listening → \(slot?.title ?? "nothing")"
                 : "your voice goes to \(slot?.title ?? "nothing")")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(listening ? Theme.text : Theme.textFaint)
                .lineLimit(1).truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 5)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(height: 0.5), alignment: .top)
    }
}
