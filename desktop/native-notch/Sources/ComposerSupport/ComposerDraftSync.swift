public struct DraftSyncState: Equatable {
    public let text: String
    public let revision: Int

    public init(text: String, revision: Int) {
        self.text = text
        self.revision = revision
    }
}

public struct RemoteDraftSnapshot: Equatable {
    public let text: String
    public let revision: Int?
    public init(text: String, revision: Int?) { self.text = text; self.revision = revision }
}

/// Accept an authoritative pair atomically. An older response must not erase a
/// newer local edit; an accepted same-text response still advances the clock.
public func reconcileDraft(localText: String, localRevision: Int,
                           remoteText: String, remoteRevision: Int?) -> DraftSyncState {
    guard let remoteRevision else {
        return DraftSyncState(text: remoteText, revision: localRevision)
    }
    guard remoteRevision >= localRevision else {
        return DraftSyncState(text: localText, revision: localRevision)
    }
    return DraftSyncState(text: remoteText, revision: remoteRevision)
}
