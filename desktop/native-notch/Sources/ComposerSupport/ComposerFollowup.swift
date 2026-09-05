public func composerFollowupCanSend(mode: String?) -> Bool {
    mode != "full" && mode != "locked"
}

public func composerFollowupSendLabel(mode: String?) -> String {
    mode == "queue" ? "Queue follow-up" : mode == "answer" ? "Answer pending request" : "Send message"
}
