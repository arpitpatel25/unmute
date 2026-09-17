/// WHETHER TO OFFER THE REST OF THE CONVERSATION, AND WHETHER IT CAN BE COUNTED.
///
/// The count arrives from the engine as `olderMessages`, and it has three
/// meanings, not two. Treating it as a plain number — `if olderMessages > 0` —
/// collapsed the third into "there is nothing older", which is how a card that
/// was holding one turn of a hundred-turn conversation offered no way back.
///
/// A reattached card is fed the daemon's replay tail, and the engine cannot
/// count what it has not read: establishing the remainder means loading the
/// durable history, which is precisely what this control is for. So it reports
/// the remainder as UNKNOWN, and unknown must still offer — a button without a
/// number is the honest version, and the only one that can break the deadlock.
public enum LoadEarlierControl {
    /// The control's title, or nil when the conversation is already whole.
    public static func label(olderMessages: Int) -> String? {
        if olderMessages == 0 { return nil }
        if olderMessages < 0 { return "Load earlier messages" }
        return "Load earlier messages (\(olderMessages))"
    }
}
