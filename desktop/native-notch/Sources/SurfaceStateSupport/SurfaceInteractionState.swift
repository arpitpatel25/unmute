public enum SurfaceRegion: Equatable, Sendable {
    case bar
    // NO `.pocket` ANY MORE.
    //
    // The pocket had a second size that the pointer opened, so it needed its own
    // hover region, its own settle/exit boundaries, and a debounce to stop the
    // two from fighting. It has ONE size now (see PocketRow / PocketCard), so
    // there is nothing for a pointer to reveal and nothing to keep track of.
}

public enum SurfaceInteractionAction: Equatable, Sendable {
    case pointerEntered(SurfaceRegion)
    case pointerExited(SurfaceRegion)
    case taskEntered(id: String, terminalDefaultOpen: Bool, requiresTerminal: Bool)
    case taskLeft
    case terminalVisibilityChanged(Bool)
}

public struct SurfacePresentation: Equatable, Sendable {
    public let barHovered: Bool
}

public struct SurfacePlaneInsets: Equatable, Sendable {
    public let top: Double
    public let horizontal: Double
    public let bottom: Double
}

/// Every content plane meets the top edge while retaining the shell as a
/// visible rail on the left, right and bottom.
public enum SurfacePlanePolicy {
    public static func insets(panelPadding: Double, topFillet: Double) -> SurfacePlaneInsets {
        SurfacePlaneInsets(
            top: 0,
            horizontal: panelPadding + topFillet,
            bottom: panelPadding
        )
    }
}

/// The native helper's sole authority for visit-scoped interaction.
///
/// Domain truth remains in Electron. This value owns only what must react at
/// pointer speed or survive repeated snapshots without being reset.
///
/// IT USED TO OWN THE POCKET'S MORPH — a four-phase machine (compact → growing
/// → expanded → hiding) whose only job was to sequence a resize against the
/// content appearing inside it, plus the rule that a leg in flight may not
/// reverse. All of it existed because the pocket had two sizes. It has one, so
/// the machine, the phases, the settle/hidden boundaries and the 0.18s exit
/// debounce that stopped them oscillating are all gone with it.
public struct SurfaceInteractionState: Equatable, Sendable {
    public private(set) var barHovered = false
    public private(set) var taskID: String?
    public private(set) var terminalVisible = false

    public init() {}

    public var presentation: SurfacePresentation {
        SurfacePresentation(barHovered: barHovered)
    }

    public mutating func reduce(_ action: SurfaceInteractionAction) {
        switch action {
        case let .pointerEntered(region):
            switch region {
            case .bar: barHovered = true
            }

        case let .pointerExited(region):
            switch region {
            case .bar: barHovered = false
            }

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
