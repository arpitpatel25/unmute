// HOW TALL THE OPEN POCKET CARD IS — which depends on whether it has anything
// to ask.
//
// The card had one height, 106pt, sized for its tallest case: a title, a
// two-line question, and the carousel. When there was no question the middle row
// did not go away — it fell back to the same status word the footer already
// shows. A finished task therefore said "Done" twice, two inches apart, and paid
// 31pt of height (sized for two lines of prose) to render four characters. On a
// display with no cutout that is a third of the card spent on an echo.
//
// The fallback's own reasoning was that showing the status there means the card
// and the closed bar "can never disagree". The way to guarantee that is to say
// it once, not twice.
//
// SAFE TO DERIVE. A height that depends on layout is the loop that has bitten
// this codebase three times (see ConversationSupport/BottomProximity). This one
// depends on DATA — whether the slot carries an ask — which no amount of drawing
// can change. Asking "is there a question?" is stable; asking "did the thing I
// drew fit?" is not.

import CoreGraphics

// Mirrors of PocketCard's own metrics. Kept here so the window frame and the
// view cannot drift apart — a height that disagrees with the layout clips the
// footer or leaves a dead band under it.
public let pocketCardPadTop: CGFloat = 11
public let pocketCardPadBottom: CGFloat = 9
public let pocketRowGap: CGFloat = 7
public let pocketHeaderHeight: CGFloat = 20
/// Two lines of 12pt prose. Only present when there is prose.
public let pocketAskRowHeight: CGFloat = 31
public let pocketFootHeight: CGFloat = 21

/// Title · question · carousel.
public let pocketCardHeightAsking: CGFloat =
    pocketCardPadTop + pocketHeaderHeight + pocketRowGap
    + pocketAskRowHeight + pocketRowGap + pocketFootHeight + pocketCardPadBottom

/// Title · carousel. The middle row is dropped, not filled.
public let pocketCardHeightQuiet: CGFloat =
    pocketCardHeightAsking - pocketAskRowHeight - pocketRowGap

/// The height to give the window, from what the card will actually draw.
public func pocketCardHeight(hasAsk: Bool) -> CGFloat {
    hasAsk ? pocketCardHeightAsking : pocketCardHeightQuiet
}
