import AppKit
import SwiftUI

// THE POCKET — one open state, in two arrangements.
//
// Leaving a task used to mean closing it, and closing says "I am done with
// this", which is rarely what was meant: the user changed window BECAUSE they
// had to go look at something in order to answer. So an expanded task now
// collapses INTO the notch instead. It stays alive, stays in the crank, stays
// unmuted — and stays reachable.
//
// THERE IS ONE CONCEPT HERE, NOT TWO: a task is in front of you. It comes in
// two sizes — the full panel, or this — and the aim follows what you can see
// either way:
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
// ── ONE OPEN STATE ─────────────────────────────────────────────────────────
//
// It had two: a 64pt card, and a 120/146pt one the pointer or an aimed capture
// grew it into. Once the carousel moved onto the card itself there was nothing
// left for the second size to carry — the ask belongs on the surface you can
// actually answer from, and "Right ⌥ goes here" is already taught by the closed
// pocket's hover and by the live mic. What the second size DID carry was a
// four-phase morph, an ordering rule, a settle boundary and a 0.18s debounce to
// stop the two fighting over the pointer. All deleted with it.
//
// ── ...AND WHY IT LOOKS DIFFERENT ON A NOTCHED MAC ─────────────────────────
//
// The card's plane is grey and the housing is black. Where a different material
// passes behind the camera it simply stops being displayed, taking its own
// rounded corners and hairline with it — the chopped, uneven border reported
// from the field. The old answer was to push the whole card BELOW the housing,
// which is correct and is also why it read as a menu hanging off the notch.
//
// The answer here is to move it SIDEWAYS instead. The bar has done this since
// the beginning: content left of the housing, content right of it, one black
// path drawn straight through the middle. Nothing readable is ever under the
// camera because nothing is PUT there. So on a notched display the pocket is a
// single ROW on the housing's own line (PocketRow); on a display without one
// there is nothing to work around and it stays a CARD (PocketCard).

/// What the open pocket says on a notched display, and how wide each shoulder
/// must be to say it.
///
/// ONE SOURCE FOR BOTH, exactly as `BarContent` is: AppController sizes the
/// window from these numbers and `PocketRow` renders in these fonts, so the
/// frame and its content cannot drift apart.
struct PocketRowMetrics {
    var left: CGFloat
    var right: CGFloat
    /// The card inside each shoulder. Tall enough to read as a card, short
    /// enough that nothing crosses the housing's bottom edge.
    var cardHeight: CGFloat

    // ── Metrics. The view reads these too; nothing here is duplicated there. ──

    static let cardPadX: CGFloat = 9
    static let cardGap: CGFloat = 7
    static let cardRadius: CGFloat = 9
    static let markSize: CGFloat = 16
    static let dotSize: CGFloat = 8
    static let arrow: CGFloat = 18
    static let arrowGap: CGFloat = 4
    static let sepGap: CGFloat = 8
    static let button: CGFloat = 17
    static let buttonGap: CGFloat = 6
    /// The live-aim chip, which replaces whatever the right card was saying.
    static let chip: CGFloat = 74
    /// Slack, so a label that fits exactly does not ellipsise on a rounding.
    static let slack: CGFloat = 3

    static let titleFont  = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
    static let askFont    = NSFont.systemFont(ofSize: 12)
    static let statusFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    static let countFont  = NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular)

    static func measure(_ s: String, _ f: NSFont) -> CGFloat {
        (s as NSString).size(withAttributes: [.font: f]).width
    }

    /// `listening` is the aimed-capture chip taking the place of the words.
    static func make(for pocket: PocketP, listening: Bool, barHeight: CGFloat) -> PocketRowMetrics {
        let slot = pocket.current
        let title = slot?.title ?? "Nothing in your pocket"
        let saying = PocketFace.saying(for: slot)

        var left = cardPadX + dotSize + cardGap
            + ProviderMark.width(size: markSize, terminal: slot?.terminal ?? true)
            + cardGap + measure(title, titleFont) + cardPadX + slack
        left += BarContent.inset + BarContent.gap

        var card = cardPadX + (listening ? chip : measure(saying, askFont))
        if pocket.slots.count > 1 {
            card += sepGap + 1 + sepGap + arrow + arrowGap
                + measure(PocketFace.count(for: pocket), countFont) + arrowGap + arrow
        }
        card += cardPadX + slack
        // The close button is outside the card in BOTH cases, where a close
        // belongs; the dashboard sits beside it.
        let right = BarContent.gap + card + BarContent.gap
            + button + buttonGap + button + BarContent.inset

        return PocketRowMetrics(left: ceil(left), right: ceil(right),
                                cardHeight: max(20, min(30, barHeight - 10)))
    }
}

/// The words the pocket says, in one place, so the row and the card cannot
/// disagree about them.
enum PocketFace {
    /// WHAT IT IS ASKING — and when it is not asking anything, WHAT IT IS.
    ///
    /// The ask wins when there is one: it is the more specific truth. Falling
    /// back to the same status the closed surface shows means the two can never
    /// disagree.
    static func saying(for slot: PocketSlotP?) -> String {
        guard let slot else { return "Nothing in your pocket" }
        if let ask = slot.ask, !ask.isEmpty { return ask }
        return status(for: slot)
    }

    /// ONE VOCABULARY. This used to capitalise the wire state — so the card said
    /// "Needs User" two inches from a bar saying "Needs you", which reads as a
    /// different system talking. `Theme.statusLabel` is that sentence, and it is
    /// what the bar already uses.
    static func status(for slot: PocketSlotP?) -> String {
        guard let raw = slot?.status, !raw.isEmpty else {
            return slot?.demanding == true ? "Needs you" : "Ready"
        }
        if let known = TaskStatus(rawValue: raw) { return Theme.statusLabel(known) }
        return raw.replacingOccurrences(of: "-", with: " ")
                  .replacingOccurrences(of: "_", with: " ")
                  .capitalized
    }

    static func count(for pocket: PocketP) -> String {
        "\(min(pocket.at + 1, pocket.slots.count))/\(pocket.slots.count)"
    }
}

// MARK: - Shared pieces

/// A card drawn on the BARE BLACK mass. `Theme.raised` was tuned against
/// `Theme.plane` and all but disappears here, which is the whole reason the
/// open pocket used to read as another bar message rather than as something
/// being held.
private struct OnBlackCard<Content: View>: View {
    let height: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: 0) { content() }
            .padding(.horizontal, PocketRowMetrics.cardPadX)
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: PocketRowMetrics.cardRadius)
                .fill(Theme.onBlackFill))
            .overlay(RoundedRectangle(cornerRadius: PocketRowMetrics.cardRadius)
                .stroke(Theme.onBlackEdge, lineWidth: 0.5))
    }
}

private struct RoundButton: View {
    let symbol: String
    let size: CGFloat
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .foregroundColor(Theme.textDim)
                .frame(width: PocketRowMetrics.button, height: PocketRowMetrics.button)
                .background(Circle().fill(Theme.onBlackFill))
                .overlay(Circle().stroke(Theme.onBlackEdge, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// ‹ 1/3 › — the way through the pocket, and it is on the surface itself.
///
/// It used to live in the second size, so moving between held tasks meant
/// opening something first: the pocket's main verb hidden inside its own
/// second state.
private struct SlotRail: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        HStack(spacing: PocketRowMetrics.arrowGap) {
            arrow("chevron.left", -1)
            Text(PocketFace.count(for: model.pocket))
                .font(Theme.fNum).foregroundColor(Theme.textDim)
                .fixedSize()
            arrow("chevron.right", 1)
        }
    }

    private func arrow(_ symbol: String, _ delta: Int) -> some View {
        Button { model.emit(.pocketMove(delta: delta)) } label: {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(Theme.text.opacity(0.7))
                .frame(width: PocketRowMetrics.arrow, height: PocketRowMetrics.arrow)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.07)))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Notched: one row, on the housing's own line

struct PocketRow: View {
    @ObservedObject var model: NotchModel
    /// True while the mic is actually hot — the words give way to it, in place,
    /// because "is it hearing me" is the only question being asked at that
    /// moment and it is asked at the size the pocket is actually left at.
    let listening: Bool

    private var slot: PocketSlotP? { model.pocket.current }
    private var quiet: Bool { slot?.demanding == false }

    var body: some View {
        HStack(spacing: 0) {
            identity(height: model.pocketCardHeight)
                .frame(width: model.bar.left, alignment: .leading)
                .clipped()
            Color.clear.frame(width: model.bar.middle)
            state(height: model.pocketCardHeight)
                .frame(width: model.bar.right, alignment: .trailing)
                .clipped()
        }
        .padding(.horizontal, model.bar.fillet)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// WHO YOU ARE ADDRESSING — status, the agent's own mark, the name.
    private func identity(height: CGFloat) -> some View {
        HStack(spacing: 0) {
            OnBlackCard(height: height) {
                Dot(status: quiet ? .done : (slot.flatMap { TaskStatus(rawValue: $0.status ?? "") } ?? .needsUser),
                    size: PocketRowMetrics.dotSize)
                Spacer().frame(width: PocketRowMetrics.cardGap)
                ProviderMark(backend: slot?.backend, terminal: slot?.terminal ?? true,
                             size: PocketRowMetrics.markSize)
                Spacer().frame(width: PocketRowMetrics.cardGap)
                Text(slot?.title ?? "Nothing in your pocket")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(quiet ? Theme.textDim : Theme.text)
                    .lineLimit(1).truncationMode(.tail)
            }
            .contentShape(Rectangle())
            .onTapGesture { if slot != nil { model.emit(.pocketExpand) } }
            Spacer(minLength: 0)
        }
        .padding(.leading, BarContent.inset)
    }

    /// WHAT IT IS DOING, WHICH OF THEM THIS IS, AND THE WAY OUT.
    private func state(height: CGFloat) -> some View {
        HStack(spacing: BarContent.gap) {
            Spacer(minLength: 0)
            OnBlackCard(height: height) {
                if listening {
                    AimedChip(level: model.captureLevel, compact: true)
                } else {
                    Text(PocketFace.saying(for: slot))
                        .font(.system(size: 12))
                        .foregroundColor(Theme.text.opacity(0.68))
                        .lineLimit(1).truncationMode(.tail)
                }
                if model.pocket.slots.count > 1 {
                    Spacer().frame(width: PocketRowMetrics.sepGap)
                    Rectangle().fill(Theme.onBlackEdge)
                        .frame(width: 1, height: height * 0.5)
                    Spacer().frame(width: PocketRowMetrics.sepGap)
                    SlotRail(model: model)
                }
            }
            // A WAY OUT TO THE WALL. From the pocket the only forward motion
            // used to be INTO a task, so seeing everything meant closing, then
            // tapping the empty notch, and hoping that read as "dashboard".
            RoundButton(symbol: "square.grid.2x2", size: 8.5, help: "Open the dashboard") {
                model.emit(.openDashboard)
            }
            RoundButton(symbol: "xmark", size: 8,
                        help: "Close — your voice goes back to normal routing") {
                model.emit(.pocketRelease)
            }
        }
        .padding(.trailing, BarContent.inset)
    }
}

// MARK: - No cutout: one card, hanging from the top edge

/// The same content, arranged for a card that hangs free instead of straddling
/// a hole: who you are addressing, what it is asking, and which of them this is.
///
/// This is the FULLER card, not the 64pt compact one it replaces. Off the notch
/// nothing forces the content onto a single line, so a card that shows only a
/// title and a status word is not compact — it is withholding.
struct PocketCard: View {
    @ObservedObject var model: NotchModel
    var pocketOverride: PocketP? = nil
    let listening: Bool

    private var pocket: PocketP { pocketOverride ?? model.pocket }
    private var slot: PocketSlotP? { pocket.current }
    private var quiet: Bool { slot?.demanding == false }

    static let padX: CGFloat = 12
    static let padTop: CGFloat = 11
    static let padBottom: CGFloat = 9
    static let rowGap: CGFloat = 7
    static let askHeight: CGFloat = 31
    static let footHeight: CGFloat = 21

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: Self.rowGap) {
                header
                Text(model.toast ?? PocketFace.saying(for: slot))
                    .font(.system(size: 12))
                    .foregroundColor(model.toast == nil ? Theme.text.opacity(0.72) : Theme.cError)
                    .lineLimit(2).truncationMode(.tail)
                    .frame(maxWidth: .infinity, minHeight: Self.askHeight,
                           maxHeight: Self.askHeight, alignment: .topLeading)
                footer
            }
            .padding(.horizontal, Self.padX)
            .padding(.top, Self.padTop)
            .padding(.bottom, Self.padBottom)
            // THE WHOLE CARD IS THE BUTTON. Expanding used to require hitting a
            // 30pt chip; everything else was dead pixels on a surface whose
            // entire job is to be reached at a glance. Buttons inside still win.
            .contentShape(Rectangle())
            .onTapGesture { if slot != nil { model.emit(.pocketExpand) } }

            HStack(spacing: PocketRowMetrics.buttonGap) {
                RoundButton(symbol: "square.grid.2x2", size: 8.5, help: "Open the dashboard") {
                    model.emit(.openDashboard)
                }
                RoundButton(symbol: "xmark", size: 8,
                            help: "Close — your voice goes back to normal routing") {
                    model.emit(.pocketRelease)
                }
            }
            .padding(9)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Dot(status: quiet ? .done : (slot.flatMap { TaskStatus(rawValue: $0.status ?? "") } ?? .needsUser),
                size: 8)
            ProviderMark(backend: slot?.backend, terminal: slot?.terminal ?? true, size: 14)
            Text(slot?.title ?? "Nothing in your pocket")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(quiet ? Theme.textDim : Theme.text)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        // The two controls own this corner.
        .padding(.trailing, 46)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            if pocket.slots.count > 1 { SlotRail(model: model) }
            Spacer(minLength: 0)
            if listening {
                AimedChip(level: model.captureLevel, compact: true)
            } else {
                Text(PocketFace.status(for: slot))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundColor(Theme.text.opacity(0.68))
                    .lineLimit(1)
            }
        }
        .frame(height: Self.footHeight)
    }
}
