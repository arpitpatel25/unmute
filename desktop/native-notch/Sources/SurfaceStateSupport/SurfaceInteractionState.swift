public enum SurfaceRegion: Equatable, Sendable {
    case bar
    case pocket
}

public enum SurfaceInteractionAction: Equatable, Sendable {
    case pocketAvailability(open: Bool, itemCount: Int)
    case pointerEntered(SurfaceRegion)
    case pointerExited(SurfaceRegion)
    /// The native window reached the pocket frame requested on pointer entry.
    /// Content is revealed only now, so it grows out of the existing card.
    case pocketGeometrySettled
    /// The outgoing pocket controls have finished fading. Geometry may now
    /// contract without looking as though a second card replaced the first.
    case pocketContentHidden
    case captureAimed(Bool)
    case taskEntered(id: String, terminalDefaultOpen: Bool, requiresTerminal: Bool)
    case taskLeft
    case terminalVisibilityChanged(Bool)
}

public struct SurfacePresentation: Equatable, Sendable {
    public let barHovered: Bool
    public let pocketDetailsVisible: Bool
    public let pocketHeight: Double?
}

/// The native helper's sole authority for visit-scoped interaction.
///
/// Domain truth remains in Electron. This value owns only what must react at
/// pointer speed or survive repeated snapshots without being reset.
public struct SurfaceInteractionState: Equatable, Sendable {
    private enum PocketPhase: Equatable, Sendable {
        case compact
        case growing
        case expanded
        case hiding
    }

    public private(set) var barHovered = false
    public private(set) var pocketHovered = false
    public private(set) var captureAimed = false
    public private(set) var pocketOpen = false
    public private(set) var pocketItemCount = 0
    public private(set) var taskID: String?
    public private(set) var terminalVisible = false
    private var pocketPhase: PocketPhase = .compact

    public init() {}

    public var presentation: SurfacePresentation {
        let details = pocketOpen && pocketPhase == .expanded
        let fullHeight = pocketItemCount > 1 ? 146.0 : 120.0
        let height: Double? = pocketOpen
            ? (pocketPhase == .compact ? 64 : fullHeight)
            : nil
        return SurfacePresentation(
            barHovered: barHovered,
            pocketDetailsVisible: details,
            pocketHeight: height
        )
    }

    public mutating func reduce(_ action: SurfaceInteractionAction) {
        switch action {
        case let .pocketAvailability(open, itemCount):
            pocketOpen = open
            pocketItemCount = max(0, itemCount)
            if !open {
                pocketHovered = false
                pocketPhase = .compact
            } else {
                advancePocketTowardIntent()
            }

        case let .pointerEntered(region):
            switch region {
            case .bar: barHovered = true
            case .pocket:
                pocketHovered = true
                advancePocketTowardIntent()
            }

        case let .pointerExited(region):
            switch region {
            case .bar: barHovered = false
            case .pocket:
                pocketHovered = false
                advancePocketTowardIntent()
            }

        case .pocketGeometrySettled:
            guard pocketPhase == .growing else { break }
            pocketPhase = wantsPocketDetails ? .expanded : .compact

        case .pocketContentHidden:
            guard pocketPhase == .hiding else { break }
            pocketPhase = wantsPocketDetails ? .expanded : .compact

        case let .captureAimed(aimed):
            captureAimed = aimed
            advancePocketTowardIntent()

        case let .taskEntered(id, terminalDefaultOpen, requiresTerminal):
            if taskID != id {
                taskID = id
                terminalVisible = terminalDefaultOpen || requiresTerminal
            } else if requiresTerminal {
                terminalVisible = true
            }

        case .taskLeft:
            taskID = nil
            terminalVisible = false

        case let .terminalVisibilityChanged(visible):
            terminalVisible = visible

        }
    }

    private var wantsPocketDetails: Bool {
        pocketOpen && (pocketHovered || captureAimed)
    }

    /// Intent may change while either half of the morph is in flight. Do not
    /// reverse window geometry mid-animation: remember the new intent and
    /// honour it at the next settlement boundary instead.
    private mutating func advancePocketTowardIntent() {
        guard pocketOpen else { pocketPhase = .compact; return }
        switch (pocketPhase, wantsPocketDetails) {
        case (.compact, true): pocketPhase = .growing
        case (.expanded, false): pocketPhase = .hiding
        case (.hiding, true): pocketPhase = .expanded
        default: break
        }
    }
}
