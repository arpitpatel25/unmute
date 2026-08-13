public enum SurfaceRegion: Equatable, Sendable {
    case bar
    case pocket
}

public enum SurfaceInteractionAction: Equatable, Sendable {
    case pocketAvailability(open: Bool, itemCount: Int)
    case pointerEntered(SurfaceRegion)
    case pointerExited(SurfaceRegion)
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
    public private(set) var barHovered = false
    public private(set) var pocketHovered = false
    public private(set) var captureAimed = false
    public private(set) var pocketOpen = false
    public private(set) var pocketItemCount = 0
    public private(set) var taskID: String?
    public private(set) var terminalVisible = false

    public init() {}

    public var presentation: SurfacePresentation {
        let details = pocketOpen && (pocketHovered || captureAimed)
        let height: Double? = pocketOpen
            ? (details ? (pocketItemCount > 1 ? 146 : 120) : 64)
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
            if !open { pocketHovered = false }

        case let .pointerEntered(region):
            switch region {
            case .bar: barHovered = true
            case .pocket: pocketHovered = true
            }

        case let .pointerExited(region):
            switch region {
            case .bar: barHovered = false
            case .pocket: pocketHovered = false
            }

        case let .captureAimed(aimed):
            captureAimed = aimed

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
}
