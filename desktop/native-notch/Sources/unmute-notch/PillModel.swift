import SwiftUI
import Combine

// THE INPUT SURFACE — bottom-centre, the counterpart to the notch's top-centre.
//
// ARCHITECTURE: this is a VIEW ONLY, exactly like the notch. Audio capture,
// VAD, mic-source resolution and the scratchpad's buffer all stay where they
// already work — the renderer and main; main pushes their state here and the
// user's gestures travel back as events. Nothing about the capture path moves.
//
// That boundary is not tidiness — it is the dictation constraint. Heavy
// main-process work while recording corrupts audio, so the capture path keeps
// its existing shape and this surface never touches it. The traffic during a
// capture is one amplitude float per frame, plus a `scratchpad` line whenever
// something is copied into a pad the user chose to hold — which is a user
// action, not a per-frame cost. Nothing else is sent while the mic is hot.

/// What the capture pill is doing right now.
///
/// These mirror the ORIGINAL widget's state machine one-for-one. The first
/// build invented its own smaller set — and with it a lot of words the pill
/// never said. Two states in particular are wordless by design: while you are
/// speaking it shows a timer and a stop button, and on success it shows a
/// checkmark and nothing else, because the text is already at your cursor.
enum PillPhase: String, Codable {
    case hidden
    /// Speaking. dot (or the Remote glyph) + timer + stop. NO label.
    case recording
    /// STOPPED WITH THE SCRATCHPAD ARMED — the work is on the pad and the same
    /// key resumes the same dictation. Amber dot + "Paused". The one state the
    /// pill stays up for with no live capture behind it, because vanishing here
    /// tells the user their session ended when it has not. Main decides it (see
    /// hideNativePill in init.ts), not the capture renderer.
    case paused
    /// Audio done, text pending. The one resting state that does carry a word.
    case processing
    /// Silent success acknowledgement — a green tick, nothing else.
    case output
    /// Pasted, but formatting was unavailable.
    case outputFallback = "output-fallback"
    /// Nothing captured — too short or silent. No API call was made.
    case tooShort = "too-short"
    /// Discarded by the user. Carries the Undo.
    case cancelled
    case error
}

/// Which KIND of capture this is. Not derivable from phase: a Remote capture
/// runs as a dictation session under the hood, so anything keyed on the
/// recording state alone is always wrong for the picker.
enum PillKind: String, Codable {
    case dictation
    /// The AI formatter (Caps Lock) — transforms what you say instead of
    /// typing it verbatim. A DIFFERENT AXIS from `remote`: this is about what
    /// happens to the words, not about where the work runs.
    case instruction
    case remote
}

/// One of Codex's reasoning axes — Model, Effort or Speed.
struct PillAxis: Codable, Identifiable, Equatable {
    let axis: String
    let values: [String]
    let current: String?
    var id: String { axis }
}

/// One selectable option in a chip's menu (model, agent, mic).
struct PillOption: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    /// Secondary text — "fastest", "deepest", a device name.
    let detail: String?
    /// False renders the row dimmed and unselectable (e.g. Codex not running).
    let available: Bool?
    var isAvailable: Bool { available ?? true }
}

/// Why the on-device engine is handling this capture. Mirrors OnDeviceReason on
/// the Electron side; `paymentFailed` is the one that carries a recovery action.
enum PillOfflineReason: String, Codable {
    case notSignedIn = "not_signed_in"
    case noSubscription = "no_subscription"
    case paymentFailed = "payment_failed"
    case cloudUnreachable = "cloud_unreachable"
    case choseOnDevice = "chose_on_device"

    var text: String {
        switch self {
        case .notSignedIn:      return "Sign in for faster cloud transcription"
        case .noSubscription:   return "Subscribe for cloud transcription"
        // Deliberately not "Subscribe": this person already did. They kept
        // access for the whole period they paid for and are seeing this only
        // now that it has lapsed with the renewal unpaid. Say what went wrong
        // and give them the one control that fixes it.
        case .paymentFailed:    return "Payment failed — update your card to restore cloud"
        case .cloudUnreachable: return "Cloud unreachable — using the on-device model"
        case .choseOnDevice:    return "On-device mode is selected in Settings"
        }
    }

    var symbol: String {
        switch self {
        case .notSignedIn:      return "person.crop.circle"
        case .noSubscription:   return "creditcard"
        case .paymentFailed:    return "exclamationmark.circle"
        case .cloudUnreachable: return "wifi.slash"
        case .choseOnDevice:    return "laptopcomputer"
        }
    }

    /// Only the RECOVERABLE state gets a tint and a primary button — one tinted
    /// thing per surface, and it is the one that fixes the problem.
    var isRecoverable: Bool { self == .paymentFailed }
}

/// Live capture coaching ("noisy room — move closer"). Two-tier copy: the bold
/// condition, then the dim remedy.
struct PillCoaching: Codable, Equatable {
    let condition: String
    let remedy: String?
    /// "warn" | "good"
    let level: String?
}

/// Everything main pushes about the input surface, in one payload.
struct PillState: Codable, Equatable {
    var phase: PillPhase = .hidden
    var kind: PillKind = .dictation
    /// 0…1 amplitude for the waveform. One float per frame is the ONLY new
    /// traffic on the capture path.
    var level: Double = 0
    /// Seconds elapsed in this capture.
    var elapsed: Int = 0
    /// Cap, for the timer's warning colour.
    var maxSeconds: Int = 300
    /// Error copy, when phase is .error.
    var message: String? = nil
    /// A quick draft is available while the real result is still coming.
    var draftOffer: Bool = false
    /// The on-device engine is handling this one ("On-device" / "offline model").
    var engineNotice: Bool = false
    /// "Esc to discard" — shown only when the hint is earned.
    var showDiscardHint: Bool = false
    /// What was pasted, echoed on the fallback pill.
    var outputPreview: String? = nil
    /// Why formatting was unavailable.
    var fallbackMessage: String? = nil
    /// "Didn't catch that" and its variants.
    var mutedText: String? = nil

    // Chips — each nil when it should not render at all.
    var model: String? = nil
    var modelOptions: [PillOption]? = nil
    /// CODEX'S OWN AXES, when the agent is Codex.
    ///
    /// The two platforms do not share a model list — Claude Code has a flat
    /// catalog, Codex has Model / Effort / Speed — so switching platform must
    /// change what the model control offers. When this is present it REPLACES
    /// modelOptions; a Claude catalog shown under Codex is how the chip ended up
    /// reading "Opus" with Codex selected.
    var modelAxes: [PillAxis]? = nil
    var agent: String? = nil
    var agentOptions: [PillOption]? = nil
    /// Is the selected backend reachable right now? Drives the dot on the agent
    /// chip and the "· connect" suffix — a functional indicator, not decoration.
    var agentConnected: Bool = true
    /// One line of mic narration, shown for a few seconds and then dropped.
    /// "chip colours are ambience, WORDS are communication."
    var micStatus: String? = nil
    var raw: Bool? = nil
    var micOptions: [PillOption]? = nil
    var mic: String? = nil
    var coaching: PillCoaching? = nil
    var offline: PillOfflineReason? = nil
    /// Undo is offered for a short window after a paste.
    var canUndo: Bool = false

    static let hidden = PillState()

    init() {}

    /// EVERY FIELD IS OPTIONAL ON THE WIRE.
    ///
    /// Swift's synthesized Decodable does NOT fall back to a property's default
    /// value — it requires the key. So a payload that omitted, say, `maxSeconds`
    /// failed to decode entirely and the command was dropped as unknown, which
    /// is a silent, total failure for a surface driven by partial updates. Main
    /// must be able to send only what changed.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ k: CodingKeys, _ d: T) -> T {
            (try? c.decodeIfPresent(T.self, forKey: k)) as? T ?? d
        }
        phase        = (try? c.decodeIfPresent(PillPhase.self, forKey: .phase)) as? PillPhase ?? .hidden
        kind         = (try? c.decodeIfPresent(PillKind.self, forKey: .kind)) as? PillKind ?? .dictation
        level        = v(.level, 0)
        elapsed      = v(.elapsed, 0)
        maxSeconds   = v(.maxSeconds, 300)
        message      = try? c.decodeIfPresent(String.self, forKey: .message)
        draftOffer      = v(.draftOffer, false)
        engineNotice    = v(.engineNotice, false)
        showDiscardHint = v(.showDiscardHint, false)
        outputPreview   = try? c.decodeIfPresent(String.self, forKey: .outputPreview)
        fallbackMessage = try? c.decodeIfPresent(String.self, forKey: .fallbackMessage)
        mutedText       = try? c.decodeIfPresent(String.self, forKey: .mutedText)
        model        = try? c.decodeIfPresent(String.self, forKey: .model)
        modelOptions = try? c.decodeIfPresent([PillOption].self, forKey: .modelOptions)
        modelAxes    = try? c.decodeIfPresent([PillAxis].self, forKey: .modelAxes)
        agent        = try? c.decodeIfPresent(String.self, forKey: .agent)
        agentOptions = try? c.decodeIfPresent([PillOption].self, forKey: .agentOptions)
        agentConnected = v(.agentConnected, true)
        micStatus    = try? c.decodeIfPresent(String.self, forKey: .micStatus)
        raw          = try? c.decodeIfPresent(Bool.self, forKey: .raw)
        micOptions   = try? c.decodeIfPresent([PillOption].self, forKey: .micOptions)
        mic          = try? c.decodeIfPresent(String.self, forKey: .mic)
        coaching     = try? c.decodeIfPresent(PillCoaching.self, forKey: .coaching)
        offline      = try? c.decodeIfPresent(PillOfflineReason.self, forKey: .offline)
        canUndo      = v(.canUndo, false)
    }
}

/// Gestures the input surface sends back.
enum PillEvent {
    case stop                       // finish this capture now
    case cancel                     // discard it
    case undo
    case acceptDraft
    case pickModel(String)
    /// Codex only: set one reasoning axis (Model / Effort / Speed).
    case pickAxis(axis: String, value: String)
    /// The agent control CYCLES rather than opening a list — the original's
    /// behaviour, and there are only ever two.
    case cycleAgent
    case pickAgent(String)
    case pickMic(String)
    case toggleRaw(Bool)
    case openBillingPortal
    case dismissOffline

    var json: [String: Any] {
        switch self {
        case .stop:                 return ["type": "pillStop"]
        case .cancel:               return ["type": "pillCancel"]
        case .undo:                 return ["type": "pillUndo"]
        case .acceptDraft:          return ["type": "pillAcceptDraft"]
        case let .pickModel(v):     return ["type": "pillPickModel", "value": v]
        case let .pickAxis(a, v):   return ["type": "pillPickAxis", "axis": a, "value": v]
        case .cycleAgent:           return ["type": "pillCycleAgent"]
        case let .pickAgent(v):     return ["type": "pillPickAgent", "value": v]
        case let .pickMic(v):       return ["type": "pillPickMic", "value": v]
        case let .toggleRaw(v):     return ["type": "pillToggleRaw", "value": v]
        case .openBillingPortal:    return ["type": "pillOpenBillingPortal"]
        case .dismissOffline:       return ["type": "pillDismissOffline"]
        }
    }
}

/// Observable state the pill's SwiftUI tree renders.
final class PillModel: ObservableObject {
    @Published var state: PillState = .hidden
    /// Which chip menu is open, if any ("model" | "agent" | "mic").
    @Published var openMenu: String? = nil

    var emit: (PillEvent) -> Void = { _ in }

    var visible: Bool { state.phase != .hidden }
}
