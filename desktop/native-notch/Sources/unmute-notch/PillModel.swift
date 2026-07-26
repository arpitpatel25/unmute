import SwiftUI
import Combine

// THE INPUT SURFACE — bottom-centre, the counterpart to the notch's top-centre.
//
// ARCHITECTURE: this is a VIEW ONLY, exactly like the notch. Audio capture,
// VAD, mic-source resolution and the staged-image ledger all stay in the
// renderer where they already work; main pushes their state here and the user's
// gestures travel back as events. Nothing about the capture path moves.
//
// That boundary is not tidiness — it is the dictation constraint. Heavy
// main-process work while recording corrupts audio, so the capture path keeps
// its existing shape and this surface never touches it. The only new traffic
// during a capture is one amplitude float per frame.

/// What the capture pill is doing right now.
enum PillPhase: String, Codable {
    case hidden
    case listening      // recording
    case transcribing   // audio done, text pending
    case landed         // pasted / dispatched
    case error
    case draft          // a draft is offered for insertion
}

/// Which KIND of capture this is. Not derivable from phase: a Remote capture
/// runs as a dictation session under the hood, so anything keyed on the
/// recording state alone is always wrong for the picker.
enum PillKind: String, Codable {
    case dictation
    case remote
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
    /// Headline on the pill ("Listening", "Transcribing…", "Pasted").
    var label: String? = nil
    /// Error / fallback copy, when phase is .error.
    var message: String? = nil

    // Chips — each nil when it should not render at all.
    var model: String? = nil
    var modelOptions: [PillOption]? = nil
    var agent: String? = nil
    var agentOptions: [PillOption]? = nil
    var stagedCount: Int = 0
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
        label        = try? c.decodeIfPresent(String.self, forKey: .label)
        message      = try? c.decodeIfPresent(String.self, forKey: .message)
        model        = try? c.decodeIfPresent(String.self, forKey: .model)
        modelOptions = try? c.decodeIfPresent([PillOption].self, forKey: .modelOptions)
        agent        = try? c.decodeIfPresent(String.self, forKey: .agent)
        agentOptions = try? c.decodeIfPresent([PillOption].self, forKey: .agentOptions)
        stagedCount  = v(.stagedCount, 0)
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
    case pickAgent(String)
    case pickMic(String)
    case toggleRaw(Bool)
    case clearStaged
    case openBillingPortal
    case dismissOffline

    var json: [String: Any] {
        switch self {
        case .stop:                 return ["type": "pillStop"]
        case .cancel:               return ["type": "pillCancel"]
        case .undo:                 return ["type": "pillUndo"]
        case .acceptDraft:          return ["type": "pillAcceptDraft"]
        case let .pickModel(v):     return ["type": "pillPickModel", "value": v]
        case let .pickAgent(v):     return ["type": "pillPickAgent", "value": v]
        case let .pickMic(v):       return ["type": "pillPickMic", "value": v]
        case let .toggleRaw(v):     return ["type": "pillToggleRaw", "value": v]
        case .clearStaged:          return ["type": "pillClearStaged"]
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
