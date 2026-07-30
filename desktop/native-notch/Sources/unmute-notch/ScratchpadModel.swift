import SwiftUI

// THE SCRATCHPAD'S STATE, and the rules for reading it off the wire.
//
// A pad is a capture the user chose to HOLD rather than deliver. It accumulates
// across recordings — speech, and anything copied or screenshotted while the
// mic was hot — until a destination is picked on the pad itself.
//
// EVERY FIELD IS OPTIONAL ON THE WIRE, and that is not stylistic. Swift's
// synthesized Decodable does NOT fall back to a property's default: it requires
// the key, and one missing key makes the whole command undecodable and silently
// dropped. CockpitData is the cautionary example — it has no custom init(from:),
// so every field there is mandatory and adding one without sending it kills
// every cockpit update. This file follows PillState instead: a lenient
// init(from:) with a default per field, so main can send whatever it has and a
// payload from an older or newer engine still draws.

/// One row of the pad. RAW, not rendered — the wire says what an entry IS and
/// this side decides how it looks, because a preview cannot be honest about
/// output anyway: rendering depends on the destination, and the destination has
/// not been chosen yet.
struct ScratchpadEntry: Decodable, Identifiable, Equatable {
    let id: String
    /// "segment" (a stretch of speech) or "insert" (something copied/captured).
    let type: String
    /// segment: the transcript. Empty until it lands.
    let text: String
    /// insert: url | path | line | block | image.
    let kind: String
    /// insert: the text, or an absolute file path for an image.
    let content: String
    let startMs: Double
    let endMs: Double
    let atMs: Double

    enum CodingKeys: String, CodingKey {
        case id, type, text, kind, content, startMs, endMs, atMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ k: CodingKeys, _ d: T) -> T {
            (try? c.decodeIfPresent(T.self, forKey: k)) ?? d
        }
        // The ID IS REQUIRED — it is what a remove is addressed to, and a row
        // that cannot be removed is worse than a row that is not drawn. Every
        // other field defaults.
        id      = v(.id, "")
        type    = v(.type, "insert")
        text    = v(.text, "")
        kind    = v(.kind, "line")
        content = v(.content, "")
        startMs = v(.startMs, 0)
        endMs   = v(.endMs, 0)
        atMs    = v(.atMs, 0)
    }

    var isSegment: Bool { type == "segment" }

    /// What the whole entry says, shown when a segment is expanded.
    var full: String { isSegment ? text : content }

    /// The glyph for an insert. Segments use a disclosure chevron instead —
    /// they are the only rows that expand.
    var glyph: String {
        switch kind {
        case "url":   return "link"
        case "path":  return "folder"
        case "image": return "photo"
        case "block": return "text.justify"
        default:      return "text.alignleft"
        }
    }

    /// ONE LINE, opening words. The job at review time is confirmation — is the
    /// right thing attached, is it in the right place — not proofreading words
    /// said thirty seconds ago.
    var preview: String {
        if isSegment {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            // An open segment has no transcript yet. Saying so beats an empty
            // row that reads as a bug.
            return t.isEmpty ? "Still transcribing…" : String(t.prefix(120))
        }
        if kind == "image" || kind == "path" {
            // The tail is the identifying part of a path, and the head is a home
            // directory the user already knows.
            return (content as NSString).lastPathComponent
        }
        let firstLine = content.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? content
        return String(firstLine.trimmingCharacters(in: .whitespaces).prefix(120))
    }

    /// "0:07" for a segment that has ended. nil while it is still open, and nil
    /// for inserts — an insert is an instant, not a stretch.
    var durationLabel: String? {
        guard isSegment, endMs > startMs else { return nil }
        let s = Int(((endMs - startMs) / 1000).rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// The pad itself.
struct ScratchpadPad: Decodable, Equatable {
    let id: String
    /// Where the capture that opened this pad was heading. A DEFAULT, never a
    /// commitment — it decides which destination button reads as primary.
    let origin: String
    let entries: [ScratchpadEntry]

    enum CodingKeys: String, CodingKey { case id, origin, entries }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id      = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        origin  = (try? c.decodeIfPresent(String.self, forKey: .origin)) ?? "cursor"
        entries = (try? c.decodeIfPresent([ScratchpadEntry].self, forKey: .entries)) ?? []
    }
}

/// A task the pad can be added to.
struct ScratchpadTaskRef: Decodable, Equatable {
    let id: String
    let name: String

    enum CodingKeys: String, CodingKey { case id, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id   = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "the open task"
    }
}

/// One destination button.
struct ScratchpadDestination: Identifiable, Equatable {
    let id: String        // "cursor" | "newTask" | "openTask"
    let label: String
    let isPrimary: Bool
}

/// Where a held pad can go. `openTask` is decided per push and is null unless a
/// task is genuinely focused — a destination that cannot receive is worse than
/// no destination at all.
struct ScratchpadDestinations: Decodable, Equatable {
    let openTask: ScratchpadTaskRef?

    init(openTask: ScratchpadTaskRef? = nil) { self.openTask = openTask }

    enum CodingKeys: String, CodingKey { case openTask }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        openTask = (try? c.decodeIfPresent(ScratchpadTaskRef.self, forKey: .openTask)) ?? nil
    }

    /// Cursor and new-task always exist, so they are not carried as flags —
    /// only the one that varies is on the wire.
    ///
    /// THE PRIMARY IS WHERE THE CAPTURE WAS HEADING when it opened. It is the
    /// likeliest answer and the one the user already implied, but it is only a
    /// default: every alternative is one tap away and nothing is committed
    /// until a button is actually pressed.
    func ordered(origin: String) -> [ScratchpadDestination] {
        let taskIsPrimary = origin == "task"
        var out: [ScratchpadDestination] = []
        if let t = openTask {
            out.append(ScratchpadDestination(id: "openTask", label: "Add to \(t.name)", isPrimary: taskIsPrimary))
        }
        out.append(ScratchpadDestination(id: "newTask", label: "New task",
                                         isPrimary: taskIsPrimary && openTask == nil))
        out.append(ScratchpadDestination(id: "cursor", label: "Paste at cursor", isPrimary: !taskIsPrimary))
        return out
    }
}

/// Everything the pad surface draws, pushed as one object so the pad, the arm
/// state and the destinations can never be sampled from two different instants.
struct ScratchpadPayload: Decodable, Equatable {
    /// FALSE UNTIL MAIN SAYS OTHERWISE. This one field defaults the opposite way
    /// to the rest, and deliberately: it gates a CONTROL, and a control that
    /// cannot act is worse than no control. An engine that never sends a
    /// `scratchpad` command has no scratchpad to arm, so the pill must not offer
    /// one. main seeds this at startup and re-sends on every change, so the icon
    /// appears as soon as there is something behind it.
    var enabled: Bool = false
    var armed: Bool = false
    /// A delivery is in flight. The pad has ALREADY been taken for it — see
    /// ScratchpadView's footer for why that disables Discard rather than
    /// offering a cancel that does not exist.
    var delivering: Bool = false
    var pad: ScratchpadPad? = nil
    var destinations: ScratchpadDestinations = ScratchpadDestinations()

    static let empty = ScratchpadPayload()

    init() {}

    enum CodingKeys: String, CodingKey { case enabled, armed, delivering, pad, destinations }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ k: CodingKeys, _ d: T) -> T {
            (try? c.decodeIfPresent(T.self, forKey: k)) ?? d
        }
        enabled      = v(.enabled, false)   // see the property: no control without a backend
        armed        = v(.armed, false)
        delivering   = v(.delivering, false)
        pad          = (try? c.decodeIfPresent(ScratchpadPad.self, forKey: .pad)) ?? nil
        destinations = v(.destinations, ScratchpadDestinations())
    }

    /// The panel exists only when there is something on the pad. An empty pad
    /// with a footer of destination buttons would be a control for sending
    /// nothing.
    var hasContent: Bool { !(pad?.entries.isEmpty ?? true) }
}

/// Observable state the pad surface and the pill's icon both render.
final class ScratchpadModel: ObservableObject {
    @Published var state: ScratchpadPayload = .empty

    var emit: (Event) -> Void = { _ in }

    /// Is the panel on screen? Content only — arming with nothing captured yet
    /// shows the icon lit, not an empty window.
    var visible: Bool { state.enabled && state.hasContent }
}
